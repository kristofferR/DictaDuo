import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GenerationService } from "../../../Server/src/generation-service.ts";
import { createHTTPServer } from "../../../Server/src/http-server.ts";
import { sha256 } from "../../../Server/src/storage.ts";
import { FakeInference, openCaptureServices } from "../../../Server/tests/support.ts";
import { API, APIError, type Generation, type Recording } from "../src/api.ts";
import { HistoryTools } from "../src/history.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dictaduo-history-"));
  const runtime = join(directory, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  const service = await GenerationService.open(
    { dataDirectory: join(directory, "data"), development: true },
    new FakeInference(),
  );
  const server = createHTTPServer(service, "history-fixture-token");
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await service.shutdown();
    await server.close();
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const api = new API(address, "history-fixture-token");
  const tools = new HistoryTools(api);
  const record = await service.create({
    requestID: randomUUID(),
    device: { id: "desktop", name: "Desktop" },
    mode: "test",
  });
  async function complete() {
    await service.appendAudio(
      record.id,
      "inference",
      0,
      { sampleRate: 16000, channels: 1 },
      Buffer.alloc(16000),
    );
    await service.appendAudio(
      record.id,
      "original",
      0,
      { sampleRate: 16000, channels: 1 },
      Buffer.alloc(16000),
    );
    await service.finish(record.id, { inferenceFrames: 4000, originalFrames: 4000 });
    for await (const value of await service.events(record.id))
      if (["completed", "failed", "cancelled"].includes(value.status)) return value;
    throw Error("Missing terminal record");
  }
  return { api, tools, record, complete, address, runtime };
}
test("history reads stay scoped, saved audio is private, and explicit deletion removes shared and cached data", async () => {
  const { tools, record, complete, address, api, runtime } = await fixture();
  await expect(tools.action("deleteHistory", { id: record.id, server: address })).rejects.toThrow(
    "Finish or cancel",
  );
  await complete();
  const page = await tools.list(undefined, "dictaduo", "query-1");
  expect(page).toMatchObject({ server: address, queryID: "query-1" });
  expect(page.items.map((r) => r.id)).toEqual([record.id]);
  expect((await tools.list(undefined, "wispr-flow", "query-2")).items).toEqual([]);
  const result = await tools.action("historyAudio", {
    id: record.id,
    kind: "inference",
    server: address,
  });
  if (typeof result.url !== "string") throw Error("Expected local audio");
  const path = fileURLToPath(result.url);
  expect(path.startsWith(join(runtime, "dictaduo-client", "history-audio"))).toBe(true);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await readFile(path)).subarray(0, 4).toString()).toBe("RIFF");
  expect(JSON.stringify(result)).not.toContain("history-fixture-token");
  const original = await tools.action("historyAudio", {
    id: record.id,
    kind: "original",
    server: address,
  });
  expect(original).toMatchObject({ kind: "original", id: record.id });
  expect((await api.get(record.id)).status).toBe("completed");
  await tools.action("deleteHistory", { id: record.id, server: address });
  expect((await tools.list(undefined, undefined, "query-3")).items).toEqual([]);
  expect(await readdir(join(runtime, "dictaduo-client", "history-audio"))).toEqual([]);
  await expect(api.get(record.id)).rejects.toMatchObject({ status: 404 });
});
test("history actions reject wrong servers, paths, missing audio and untrusted download contents", async () => {
  const { tools, record, complete, address, api, runtime } = await fixture();
  await complete();
  await expect(
    tools.action("deleteHistory", { id: record.id, server: "https://other.example" }),
  ).rejects.toThrow("server changed");
  await expect(
    tools.action("historyAudio", { id: "../preferences", server: address }),
  ).rejects.toThrow("valid history");
  await expect(
    tools.action("historyAudio", { id: record.id, kind: "../../token", server: address }),
  ).rejects.toThrow("no saved recording");
  await expect(tools.list(undefined, "untrusted", "q")).rejects.toThrow("all sources");
  const auth = new HistoryTools(new API(address, "wrong-token"));
  await expect(auth.action("deleteHistory", { id: record.id, server: address })).rejects.toThrow(
    "access token",
  );
  api.historyAudio = async () => new Response("not a WAV file");
  await expect(
    tools.action("historyAudio", { id: record.id, kind: "inference", server: address }),
  ).rejects.toThrow("playable WAV");
  api.historyAudio = async () =>
    new Response("", { headers: { "content-length": String(129 * 1024 * 1024) } });
  await expect(
    tools.action("historyAudio", { id: record.id, kind: "inference", server: address }),
  ).rejects.toThrow("too large");
  expect(await readdir(join(runtime, "dictaduo-client", "history-audio"))).toEqual([]);
  await rm(join(runtime, "dictaduo-client", "history-audio"), { recursive: true });
  await symlink(runtime, join(runtime, "dictaduo-client", "history-audio"));
  await expect(
    tools.action("historyAudio", { id: record.id, kind: "inference", server: address }),
  ).rejects.toThrow("private audio folder");
  expect((await api.get(record.id)).status).toBe("completed");
});

test("saved Wispr Flow source files can be opened without a Linux importer", async () => {
  const { tools, record, complete, address, api, runtime } = await fixture();
  await complete();
  const get = api.get.bind(api);
  api.get = async (id) => ({
    ...(await get(id)),
    importedSource: {
      provider: "wispr-flow",
      sourceID: randomUUID(),
      importedAt: new Date().toISOString(),
      variantNames: [],
      artifactNames: ["source.json", "screenshot.png"],
      sourceSHA256: "0".repeat(64),
      artifactSHA256: {},
    },
  });
  await expect(
    tools.action("historyArtifact", {
      id: record.id,
      filename: "../../token",
      server: address,
    }),
  ).rejects.toThrow("no saved source file");
  await expect(
    tools.action("historyArtifact", {
      id: record.id,
      filename: "opus.json",
      server: address,
    }),
  ).rejects.toThrow("no saved source file");
  api.historyAudio = async () => new Response('{"words":[]}');
  const source = await tools.action("historyArtifact", {
    id: record.id,
    filename: "source.json",
    server: address,
  });
  if (typeof source.url !== "string") throw Error("Expected a private source file");
  expect(fileURLToPath(source.url).endsWith(".json")).toBe(true);
  expect((await stat(fileURLToPath(source.url))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(fileURLToPath(source.url), "utf8"))).toEqual({ words: [] });
  api.historyAudio = async () => new Response("not a PNG");
  await expect(
    tools.action("historyArtifact", {
      id: record.id,
      filename: "screenshot.png",
      server: address,
    }),
  ).rejects.toThrow("PNG screenshot");
  await tools.action("deleteHistory", { id: record.id, server: address });
  expect(await readdir(join(runtime, "dictaduo-client", "history-audio"))).toEqual([]);
});

test("recording sessions join legacy history and are opened and deleted on their own routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dictaduo-history-sessions-"));
  const runtime = join(directory, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  const services = await openCaptureServices(join(directory, "data"), undefined);
  const server = createHTTPServer(
    services.service,
    "history-fixture-token",
    undefined,
    services.recordings,
  );
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await services.close();
    await server.close();
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const legacy = await services.service.create({
    requestID: randomUUID(),
    device: { id: "desktop", name: "Desktop" },
    mode: "test",
  });
  // Distinct millisecond timestamps keep the ID tie-break out of the order.
  await Bun.sleep(5);
  const created = await services.recordings.create({
    requestID: randomUUID(),
    device: { id: "desktop", name: "Desktop" },
    mode: "test",
  });
  const session = await services.recordings.resume(created.id);
  const runID = randomUUID().toUpperCase();
  const pcm = Buffer.alloc(64_000);
  const header = {
    type: "audio",
    epoch: session.epoch,
    runID,
    sequence: 0,
    firstFrame: 0,
  } as const;
  const format = {
    frameCount: 16_000,
    format: { sampleRate: 16000, channels: 1 },
    sha256: sha256(pcm),
  };
  await services.recordings.appendAudio(
    session.id,
    { ...header, kind: "inference", ...format },
    pcm,
  );
  await services.recordings.appendAudio(
    session.id,
    { ...header, kind: "original", ...format },
    pcm,
  );
  await services.recordings.stop(session.id, session.epoch, [
    { runID, inferenceFrames: 16_000, originalFrames: 16_000 },
  ]);
  for (
    let count = 0;
    (await services.recordings.get(session.id)).processingState !== "completed";
    count++
  ) {
    if (count > 400) throw Error("Session did not complete");
    await Bun.sleep(5);
  }
  const api = new API(address, "history-fixture-token");
  let streamed: Recording | undefined;
  await api.events(session.id, AbortSignal.timeout(3000), (snapshot) => (streamed = snapshot));
  expect(streamed?.settings.preferences.recognitionEngine).toBe("whisper");
  const tools = new HistoryTools(api);
  const page = await tools.list(undefined, undefined, "q");
  expect(page.items.map((item) => item.id)).toEqual([session.id, legacy.id]);
  expect(page.items[0]).toMatchObject({
    status: "completed",
    finalText: "",
    previewText: "Hello world.",
    summaryOnly: true,
  });
  expect(page.nextCursor).toBeUndefined();
  const entry = await tools.entry({ id: session.id, server: address });
  expect(entry.record).toMatchObject({ status: "completed", finalText: "Hello world." });
  expect(entry.record).not.toHaveProperty("summaryOnly");
  expect((await tools.list(undefined, "wispr-flow", "q")).items).toEqual([]);
  const audio = await tools.action("historyAudio", {
    id: session.id,
    kind: "original",
    server: address,
  });
  if (typeof audio.url !== "string") throw Error("Expected local audio");
  expect((await readFile(fileURLToPath(audio.url))).subarray(0, 4).toString()).toBe("RIFF");
  await tools.action("deleteHistory", { id: session.id, server: address });
  expect((await services.recordings.get(session.id)).captureState).toBe("discarded");
  expect((await tools.list(undefined, undefined, "q")).items.map((item) => item.id)).toEqual([
    legacy.id,
  ]);
});

test("merged pages never show an entry before a newer unfetched one", async () => {
  const api = new API("http://127.0.0.1:1", "token");
  const at = (minute: number) => ({
    id: randomUUID().toUpperCase(),
    createdAt: new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString(),
  });
  const l10 = at(10),
    l8 = at(8),
    l6 = at(6),
    l5 = at(5),
    l4 = at(4),
    r9 = at(9),
    r7 = at(7),
    r1 = at(1);
  const pages = new Map<
    string | undefined,
    { items: { id: string; createdAt: string }[]; nextCursor?: string }
  >([
    [undefined, { items: [l10, l8, l6], nextCursor: l6.id }],
    [l6.id, { items: [l5, l4] }],
  ]);
  api.history = async (before) => pages.get(before) as Awaited<ReturnType<API["history"]>>;
  const sessions = {
    items: [r9, r7, r1].map((item) => ({
      ...item,
      processingState: "queued",
      captureState: "stopped",
      streams: [],
      previewText: "",
    })),
  };
  api.recordingHistory = async (before) =>
    ({
      items: before
        ? sessions.items.slice(sessions.items.findIndex((item) => item.id === before) + 1)
        : sessions.items,
    }) as unknown as Awaited<ReturnType<API["recordingHistory"]>>;
  const tools = new HistoryTools(api);
  const first = await tools.list(undefined, undefined, "q");
  const ids = (items: Generation[]) => items.map((item) => item.id);
  expect(ids(first.items)).toEqual([l10, r9, l8, r7, l6].map((item) => item.id));
  const second = await tools.list(first.nextCursor, undefined, "q");
  expect(ids(second.items)).toEqual([l5, l4, r1].map((item) => item.id));
  expect(second.nextCursor).toBeUndefined();
  await expect(tools.list("not a cursor", undefined, "q")).rejects.toThrow(
    "Invalid history cursor",
  );
});

test("original runs recorded in different formats open one at a time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dictaduo-history-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  cleanup.push(async () => {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const api = new API("http://127.0.0.1:1", "token");
  const [first, second] = [randomUUID().toUpperCase(), randomUUID().toUpperCase()];
  const stream = (runID: string, sampleRate: number) => ({
    runID,
    kind: "original",
    frameCount: 100,
    format: { sampleRate, channels: 1 },
  });
  const snapshot = {
    id: randomUUID().toUpperCase(),
    createdAt: new Date().toISOString(),
    processingState: "failed",
    captureState: "stopped",
    streams: [stream(first, 48_000), stream(second, 44_100)],
    previewText: "",
  };
  api.history = async () => ({ items: [] });
  api.recordingHistory = async () =>
    ({ items: [snapshot] }) as unknown as Awaited<ReturnType<API["recordingHistory"]>>;
  api.recording = async () => ({ snapshot }) as unknown as Awaited<ReturnType<API["recording"]>>;
  const requested: (string | undefined)[] = [];
  api.historyAudio = async (_id, _filename, _recording, runID) => {
    requested.push(runID);
    return new Response(Buffer.from("RIFF\0\0\0\0WAVE"));
  };
  const tools = new HistoryTools(api);
  const [item] = (await tools.list(undefined, undefined, "q")).items;
  expect(item).not.toHaveProperty("originalAudio");
  expect(item).toMatchObject({ originalRuns: [{ runID: first }, { runID: second }] });
  const request = { id: snapshot.id, kind: "original", server: api.endpoint };
  await expect(tools.action("historyAudio", request)).rejects.toThrow("no saved recording");
  await tools.action("historyAudio", { ...request, runID: second.toLowerCase() });
  await expect(tools.action("historyAudio", { ...request, runID: randomUUID() })).rejects.toThrow(
    "no saved recording",
  );
  expect(requested).toEqual([second]);
});

test("a paused long recording is labelled paused and can be deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dictaduo-history-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  cleanup.push(async () => {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const api = new API("http://127.0.0.1:1", "token");
  const snapshot = {
    id: randomUUID().toUpperCase(),
    createdAt: new Date().toISOString(),
    processingState: "queued",
    captureState: "interrupted",
    streams: [],
    previewText: "",
  };
  api.history = async () => ({ items: [] });
  api.recordingHistory = async () =>
    ({ items: [snapshot] }) as unknown as Awaited<ReturnType<API["recordingHistory"]>>;
  api.recording = async () => ({ snapshot }) as unknown as Awaited<ReturnType<API["recording"]>>;
  const discarded: string[] = [];
  api.discardRecording = async (id) => {
    discarded.push(id);
  };
  const tools = new HistoryTools(api);
  const [item] = (await tools.list(undefined, undefined, "q")).items;
  expect(item).toMatchObject({ status: "queued", paused: true });
  await tools.action("deleteHistory", { id: snapshot.id, server: api.endpoint });
  expect(discarded).toEqual([snapshot.id]);
});

test("Transcribe again replaces a finished take's transcript and is followed until it settles", async () => {
  const { tools, record, complete, address } = await fixture();
  await complete();
  const started = await tools.retry({ id: record.id, server: address });
  expect(started.record).toMatchObject({ id: record.id, status: "queued", finalText: "" });
  let entry = started.record;
  for (let count = 0; !["completed", "failed"].includes(entry.status); count++) {
    if (count > 400) throw Error("Retry did not settle");
    await Bun.sleep(5);
    entry = (await tools.entry({ id: record.id, server: address })).record;
  }
  expect(entry).toMatchObject({ status: "completed", finalText: "Hello world." });
  await expect(tools.retry({ id: record.id, server: "https://other.example" })).rejects.toThrow(
    "server changed",
  );
});

test("Transcribe again uses the session or legacy route and explains refusals", async () => {
  const api = new API("http://127.0.0.1:1", "token");
  const session = {
    id: randomUUID().toUpperCase(),
    createdAt: new Date().toISOString(),
    processingState: "failed",
    captureState: "stopped",
    streams: [],
    previewText: "",
  };
  const legacy = randomUUID().toUpperCase();
  api.history = async () => ({ items: [] });
  api.recordingHistory = async () =>
    ({ items: [session] }) as unknown as Awaited<ReturnType<API["recordingHistory"]>>;
  const routes: string[] = [];
  api.retryRecording = async (id) => {
    routes.push(`v2 ${id}`);
    return { ...session, processingState: "queued" } as unknown as Recording;
  };
  api.retryGeneration = async (id) => {
    routes.push(`v1 ${id}`);
    throw new APIError(409, "not_retryable");
  };
  const tools = new HistoryTools(api);
  await tools.list(undefined, undefined, "q");
  const retried = await tools.retry({ id: session.id.toLowerCase(), server: api.endpoint });
  expect(retried.record).toMatchObject({ id: session.id, status: "queued" });
  await expect(tools.retry({ id: legacy, server: api.endpoint })).rejects.toThrow(
    "Only finished takes with saved audio",
  );
  api.retryGeneration = async () => {
    throw new APIError(503, "server_unavailable");
  };
  await expect(tools.retry({ id: legacy, server: api.endpoint })).rejects.toThrow(
    "speech engine is not ready",
  );
  expect(routes).toEqual([`v2 ${session.id}`, `v1 ${legacy}`]);
});

test("a failed retry of a finished session shows why next to the kept transcript", async () => {
  const api = new API("http://127.0.0.1:1", "token");
  const snapshot = {
    id: randomUUID().toUpperCase(),
    createdAt: new Date().toISOString(),
    processingState: "completed",
    captureState: "stopped",
    streams: [],
    previewText: "Kept.",
    error: "Transcribing again failed: The engine stopped. The previous transcript is kept.",
  };
  api.history = async () => ({ items: [] });
  api.recordingHistory = async () =>
    ({ items: [snapshot] }) as unknown as Awaited<ReturnType<API["recordingHistory"]>>;
  api.recording = async () =>
    ({
      snapshot,
      result: { id: snapshot.id, status: "completed", finalText: "Kept." },
    }) as unknown as Awaited<ReturnType<API["recording"]>>;
  const tools = new HistoryTools(api);
  await tools.list(undefined, undefined, "q");
  const entry = await tools.entry({ id: snapshot.id, server: api.endpoint });
  expect(entry.record).toMatchObject({ finalText: "Kept.", error: snapshot.error });
});
