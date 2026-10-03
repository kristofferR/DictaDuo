import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { API, APIError } from "./api.ts";
import type { components } from "../../../Server/src/generated/api.ts";
import { ClientNotice } from "./errors.ts";

type Generation = components["schemas"]["GenerationRecord"];
type Recording = components["schemas"]["RecordingSnapshot"];
type Page = { items: Generation[]; nextCursor?: string };
/**
 * The last shown entry of legacy generations and of recording sessions. A
 * missing position starts that list from its newest entry; null ends it.
 */
type Cursor = { legacy?: string | null; recordings?: string | null };
const maximumAudioBytes = 128 * 1024 * 1024;
const retention = 15 * 60 * 1000;
const terminal = new Set(["completed", "failed", "cancelled"]);
type ArtifactName = components["schemas"]["WisprFlowArtifactName"];
const artifactNames = new Set<ArtifactName>([
  "source.json",
  "source.wav",
  "opus.json",
  "screenshot.png",
  "built-in-audio.bin",
]);
function artifactName(value: unknown): value is ArtifactName {
  return typeof value === "string" && artifactNames.has(value as ArtifactName);
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    throw new ClientNotice("Choose a valid history entry.");
  return value.toUpperCase();
}
function notice(error: unknown, operation: string): never {
  if (error instanceof ClientNotice) throw error;
  if (error instanceof APIError) {
    if ([401, 403].includes(error.status))
      throw new ClientNotice(
        "The server rejected the access token. Check Connection in This computer.",
      );
    if (error.status === 404)
      throw new ClientNotice("This entry or recording is no longer available. Refresh history.");
    if (error.status === 409)
      throw new ClientNotice("Finish or cancel this recording before deleting it.");
    if (error.status === 400)
      throw new ClientNotice("History changed. Refresh before loading older entries.");
  }
  throw new ClientNotice(
    `${operation} failed. Check the connection and refresh history before trying again.`,
  );
}
function parseCursor(before: string): Cursor {
  try {
    const value: unknown = JSON.parse(before);
    const position = (item: unknown) =>
      item === undefined || item === null ? item : identifier(item);
    if (value && typeof value === "object" && !Array.isArray(value))
      return {
        legacy: position("legacy" in value ? value.legacy : undefined),
        recordings: position("recordings" in value ? value.recordings : undefined),
      };
  } catch {}
  throw new ClientNotice("Invalid history cursor. Refresh history.");
}
/** Runs recorded in different formats; the server exports their originals only one at a time. */
type OriginalRun = { runID: string; byteCount: number };
/** `paused`: a long recording stopped before it finished; only its own computer can resume it. */
type Entry = Generation & { originalRuns?: OriginalRun[]; paused?: boolean; capturing?: boolean };
function originalRuns(snapshot: Recording): OriginalRun[] | undefined {
  const streams = snapshot.streams.filter((stream) => stream.kind === "original");
  const format = streams[0]?.format;
  const uniform = streams.every(
    (stream) =>
      stream.format.sampleRate === format?.sampleRate && stream.format.channels === format.channels,
  );
  const runs = streams
    .filter((stream) => stream.frameCount > 0)
    .map((stream) => ({
      runID: stream.runID,
      byteCount: stream.frameCount * stream.format.channels * 4 + 44,
    }));
  return uniform || !runs.length ? undefined : runs;
}
const newestFirst = (a: Generation, b: Generation) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);
/** A history entry for a session without a materialized result. */
function summary(snapshot: Recording): Entry {
  const audio = (kind: "inference" | "original") => {
    const streams = snapshot.streams.filter((stream) => stream.kind === kind);
    const frameCount = streams.reduce((sum, stream) => sum + stream.frameCount, 0);
    const format = streams[0]?.format;
    // The server exports mixed-format runs only separately, never as one file.
    const uniform = streams.every(
      (stream) =>
        stream.format.sampleRate === format?.sampleRate &&
        stream.format.channels === format.channels,
    );
    return format && uniform && frameCount > 0
      ? {
          filename: `${kind}.wav`,
          ...format,
          frameCount,
          byteCount: frameCount * format.channels * 4 + 44,
          encoding: "pcm_f32le",
        }
      : undefined;
  };
  const inferenceAudio = audio("inference"),
    originalAudio = audio("original"),
    runs = originalRuns(snapshot);
  return {
    schemaVersion: 1,
    id: snapshot.id,
    requestID: snapshot.requestID,
    device: snapshot.device,
    mode: snapshot.mode,
    status:
      snapshot.captureState === "discarded"
        ? "cancelled"
        : snapshot.processingState === "completed"
          ? "completed"
          : snapshot.processingState === "failed"
            ? "failed"
            : snapshot.captureState === "recording"
              ? "receiving"
              : snapshot.processingState === "processing"
                ? "transcribing"
                : "queued",
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.createdAt,
    settings: snapshot.settings,
    rawText: "",
    finalText: "",
    insertionText: "",
    previewText: snapshot.previewText,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(snapshot.capture ? { capture: snapshot.capture } : {}),
    ...(inferenceAudio ? { inferenceAudio } : {}),
    ...(originalAudio ? { originalAudio } : {}),
    ...(runs ? { originalRuns: runs } : {}),
    // The server retries a session only once its capture has fully stopped.
    ...(snapshot.captureState === "recording" || snapshot.captureState === "interrupted"
      ? { capturing: true }
      : {}),
    ...(snapshot.captureState === "interrupted" &&
    !["completed", "failed"].includes(snapshot.processingState)
      ? { paused: true }
      : {}),
  };
}
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new ClientNotice(
      "The private audio folder is unavailable. Restart background dictation.",
    );
}
/** Only explicit history actions download or delete. No recording/delivery owner is involved. */
export class HistoryTools {
  private busy = false;
  private readonly scope: string;
  /** Listed entries that are recording sessions rather than legacy generations. */
  private readonly recordings = new Set<string>();
  constructor(private readonly api: API) {
    this.scope = createHash("sha256").update(api.endpoint).digest("hex").slice(0, 24);
  }
  async list(before: unknown, source: unknown, queryID: unknown) {
    if (before !== undefined && (typeof before !== "string" || before.length > 512))
      throw new ClientNotice("Invalid history cursor. Refresh history.");
    if (source !== undefined && source !== "dictaduo" && source !== "wispr-flow")
      throw new ClientNotice("Choose DictaDuo, Wispr Flow or all sources.");
    if (queryID !== undefined && (typeof queryID !== "string" || queryID.length > 128))
      throw new ClientNotice("Invalid history request.");
    const cursor = before === undefined ? undefined : parseCursor(before);
    try {
      return { ...(await this.page(cursor, source)), server: this.api.endpoint, queryID };
    } catch (error) {
      return notice(error, "Loading history");
    }
  }
  /**
   * Merges legacy generations and recording sessions into one dated page. An
   * entry is shown only once nothing unfetched from the other list can be newer.
   */
  private async page(cursor: Cursor = {}, source: string | undefined) {
    const empty = { items: [], nextCursor: undefined };
    const [legacy, recordings] = await Promise.all([
      cursor.legacy === null ? empty : this.api.history(cursor.legacy, source),
      cursor.recordings === null || source === "wispr-flow"
        ? empty
        : this.api.recordingHistory(cursor.recordings).catch((error) => {
            // A server without recording sessions has only legacy history.
            if (error instanceof APIError && error.status === 404) return empty;
            throw error;
          }),
    ]);
    // A completed session's result can be large; `entry` loads it once selected.
    const sessions: Page = {
      items: recordings.items.map((snapshot) => ({
        ...summary(snapshot),
        ...(snapshot.processingState === "completed" ? { summaryOnly: true } : {}),
      })),
      nextCursor: recordings.nextCursor,
    };
    for (const session of sessions.items) this.recordings.add(session.id);
    // Each list's oldest fetched entry bounds what may be shown before its next page.
    const bounds = [legacy, sessions].flatMap((page: Page) =>
      page.nextCursor && page.items.length ? [page.items.at(-1)!] : [],
    );
    const items = [...legacy.items, ...sessions.items]
      .sort(newestFirst)
      .filter((item) => bounds.every((bound) => newestFirst(item, bound) <= 0));
    const next = (page: Page, previous: string | null | undefined) => {
      const shown = page.items.filter((item) => items.includes(item));
      if (shown.length === page.items.length && !page.nextCursor) return null;
      return shown.at(-1)?.id ?? previous;
    };
    const position: Cursor = {
      legacy: next(legacy, cursor.legacy),
      recordings: source === "wispr-flow" ? null : next(sessions, cursor.recordings),
    };
    return {
      items,
      ...(position.legacy !== null || position.recordings !== null
        ? { nextCursor: JSON.stringify(position) }
        : {}),
    };
  }
  /**
   * The full record of an entry: a listed recording session's item is only a
   * summary, and a take being transcribed again changes until it settles.
   */
  async entry(request: Record<string, unknown>) {
    if (request.server !== this.api.endpoint)
      throw new ClientNotice("The connected server changed. Refresh history before continuing.");
    const id = identifier(request.id);
    try {
      const record: Entry = this.recordings.has(id)
        ? await this.session(id)
        : await this.api.get(id, 60_000);
      return { record, server: this.api.endpoint };
    } catch (error) {
      return notice(error, "Loading the entry");
    }
  }
  /**
   * Transcribes a finished, failed or cancelled take's saved audio again.
   * Returns at once; `entry` follows the take until it settles. Nothing is pasted.
   */
  async retry(request: Record<string, unknown>) {
    if (request.server !== this.api.endpoint)
      throw new ClientNotice("The connected server changed. Refresh history before continuing.");
    const id = identifier(request.id);
    if (this.busy) throw new ClientNotice("Wait for the current history action to finish.");
    this.busy = true;
    try {
      const record: Entry = this.recordings.has(id)
        ? summary(await this.api.retryRecording(id))
        : await this.api.retryGeneration(id);
      return { record, server: this.api.endpoint };
    } catch (error) {
      if (error instanceof APIError && error.status === 409)
        throw new ClientNotice("Only finished takes with saved audio can be transcribed again.");
      if (error instanceof APIError && error.status === 503)
        throw new ClientNotice("The speech engine is not ready yet. Try again in a moment.");
      return notice(error, "Transcribing again");
    } finally {
      this.busy = false;
    }
  }
  async action(
    action: "deleteHistory" | "historyAudio" | "historyArtifact",
    request: Record<string, unknown>,
  ) {
    if (request.server !== this.api.endpoint)
      throw new ClientNotice("The connected server changed. Refresh history before continuing.");
    const id = identifier(request.id);
    if (this.busy) throw new ClientNotice("Wait for the current history action to finish.");
    this.busy = true;
    try {
      const recording = this.recordings.has(id);
      const record: Entry = recording ? await this.session(id) : await this.api.get(id, 60_000);
      if (action === "deleteHistory") {
        if (!terminal.has(record.status) && !record.paused)
          throw new ClientNotice("Finish or cancel this recording before deleting it.");
        if (recording) await this.api.discardRecording(id);
        else await this.api.deleteHistory(id);
        // Delete only cached copies for this server and entry. The server deletion is authoritative.
        await this.prune(`${this.scope}-${id}-`).catch(() => {});
        return { id, server: this.api.endpoint };
      }
      const kind = request.kind;
      const run =
        request.runID === undefined
          ? undefined
          : record.originalRuns?.find((item) => item.runID === identifier(request.runID));
      if (request.runID !== undefined && (kind !== "original" || !run))
        throw new ClientNotice("This entry has no saved recording of that kind.");
      const filename =
        action === "historyArtifact"
          ? artifactName(request.filename) &&
            record.importedSource?.artifactNames.includes(request.filename)
            ? request.filename
            : undefined
          : kind === "inference" && record.inferenceAudio
            ? "inference.wav"
            : kind === "original" && (record.originalAudio || run)
              ? "original.wav"
              : kind === "imported" && record.importedSource?.artifactNames.includes("source.wav")
                ? "source.wav"
                : undefined;
      if (!filename)
        throw new ClientNotice(
          action === "historyArtifact"
            ? "This entry has no saved source file of that kind."
            : "This entry has no saved recording of that kind.",
        );
      const directory = await this.directory();
      await this.prune();
      const path = join(
        directory,
        `${this.scope}-${id}-${randomUUID()}.${filename.split(".").at(-1)}`,
      );
      const file = await open(path, "wx+", 0o600);
      try {
        const response = await this.api.historyAudio(id, filename, recording, run?.runID);
        if (!response.body) throw new Error("Empty audio response");
        const reader = response.body.getReader();
        try {
          // A session export has no duration limit; bound it by the advertised WAV size instead.
          const exported = recording
            ? (run ?? (filename === "original.wav" ? record.originalAudio : record.inferenceAudio))
                ?.byteCount
            : undefined;
          const maximumBytes = filename.endsWith(".json")
            ? 8 * 1024 * 1024
            : (exported ?? maximumAudioBytes);
          if (Number(response.headers.get("content-length")) > maximumBytes)
            throw new ClientNotice("This file is too large to open here.");
          let size = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maximumBytes) throw new ClientNotice("This file is too large to open here.");
            let offset = 0;
            while (offset < value.byteLength) {
              const { bytesWritten } = await file.write(value.subarray(offset));
              if (!bytesWritten) throw new Error("Could not write audio");
              offset += bytesWritten;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (filename.endsWith(".wav")) {
          const header = Buffer.alloc(12);
          await file.read(header, 0, 12, 0);
          if (
            header.toString("ascii", 0, 4) !== "RIFF" ||
            header.toString("ascii", 8, 12) !== "WAVE"
          )
            throw new ClientNotice("The server did not return a playable WAV recording.");
        } else if (filename.endsWith(".png")) {
          const header = Buffer.alloc(8);
          await file.read(header, 0, 8, 0);
          if (!header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw new ClientNotice("The server did not return a PNG screenshot.");
        } else if (filename.endsWith(".json")) {
          try {
            JSON.parse(await readFile(path, "utf8"));
          } catch {
            throw new ClientNotice("The server did not return a JSON source file.");
          }
        }
      } catch (error) {
        await unlink(path).catch(() => {});
        throw error;
      } finally {
        await file.close();
      }
      setTimeout(() => void unlink(path).catch(() => {}), retention).unref();
      return { id, kind, filename, server: this.api.endpoint, url: pathToFileURL(path).href };
    } catch (error) {
      return notice(
        error,
        action === "deleteHistory" ? "Deleting the entry" : "Opening the saved file",
      );
    } finally {
      this.busy = false;
    }
  }
  private async session(id: string) {
    const detail = await this.api.recording(id, 60_000);
    const runs = originalRuns(detail.snapshot);
    // A failed retry of a finished take keeps its result and reports why on the session.
    const error = detail.snapshot.error;
    const record: Entry = detail.result
      ? { ...detail.result, ...(error ? { error } : {}) }
      : summary(detail.snapshot);
    return runs ? { ...record, originalRuns: runs } : record;
  }
  private async directory() {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime)
      throw new ClientNotice(
        "The desktop session is unavailable. Sign in again before opening audio.",
      );
    const base = join(runtime, "dictaduo-client");
    await privateDirectory(base);
    const directory = join(base, "history-audio");
    await privateDirectory(directory);
    return directory;
  }
  private async prune(prefix?: string) {
    const directory = await this.directory();
    const candidates = await Promise.all(
      (await readdir(directory))
        .filter((name) =>
          /^[a-f0-9]{24}-[A-F0-9-]{36}-[a-f0-9-]{36}\.(wav|json|png|bin)$/.test(name),
        )
        .map(async (name) => ({
          name,
          info: await lstat(join(directory, name)).catch(() => undefined),
        })),
    );
    const entries = candidates.flatMap((entry) =>
      entry.info ? [{ name: entry.name, info: entry.info }] : [],
    );
    entries.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    await Promise.all(
      entries
        .filter((entry, index) =>
          prefix
            ? entry.name.startsWith(prefix)
            : index >= 3 || Date.now() - entry.info.mtimeMs > retention,
        )
        .map((entry) =>
          unlink(join(directory, entry.name)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          }),
        ),
    );
  }
}
