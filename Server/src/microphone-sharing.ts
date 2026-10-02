import { readFileSync } from "node:fs";
import { atomicPrivateWrite } from "./storage.ts";
import type { components } from "./generated/api.ts";

type Identity = components["schemas"]["AudioSourceIdentity"];
type Saved = { version: 1; shared: Identity[]; known: Identity[] };
const key = (source: Identity) => JSON.stringify([source.hostID, source.id]);

/**
 * Which of this computer's microphones other computers may record from. A
 * source the server has never seen before starts unshared. Before explicit
 * sharing existed every source was shared, so the first sources seen after
 * upgrading stay shared.
 */
export class MicrophoneSharing {
  private shared = new Set<string>();
  private known = new Map<string, Identity>();
  private seeded: boolean;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file?: string) {
    const saved = file ? load(file) : undefined;
    this.seeded = !!saved || !file;
    for (const source of saved?.known ?? []) this.known.set(key(source), source);
    for (const source of saved?.shared ?? []) this.shared.add(key(source));
  }

  isShared(source: Identity) {
    return this.shared.has(key(source));
  }

  /** Records newly discovered sources. */
  observe(sources: Identity[]) {
    const unseen = sources.filter((source) => !this.known.has(key(source)));
    if (!unseen.length) return;
    for (const source of unseen) {
      this.known.set(key(source), structuredClone(source));
      if (!this.seeded) this.shared.add(key(source));
    }
    this.seeded = true;
    this.persist();
  }

  /** Saved before it applies, so a failed write is reported and sharing is unchanged. */
  async set(source: Identity, shared: boolean) {
    const next = new Set(this.shared);
    if (shared) next.add(key(source));
    else next.delete(key(source));
    const known = new Map(this.known).set(key(source), structuredClone(source));
    if (this.file) await this.write(known, next);
    // Apply only this change: discovery may have recorded other sources meanwhile.
    this.known.set(key(source), structuredClone(source));
    if (shared) this.shared.add(key(source));
    else this.shared.delete(key(source));
    this.seeded = true;
  }

  /** Waits for pending writes, so tests and shutdown see the saved state. */
  settled() {
    return this.writes;
  }

  /** Discovery records new sources in the background; a later write retries it. */
  private persist() {
    if (this.file) void this.write(this.known, this.shared).catch(() => {});
  }

  private write(known: Map<string, Identity>, shared: Set<string>) {
    const file = this.file!;
    const saved: Saved = {
      version: 1,
      known: [...known.values()],
      shared: [...known.values()].filter((source) => shared.has(key(source))),
    };
    const data = JSON.stringify(saved);
    const write = this.writes.then(() => atomicPrivateWrite(file, data));
    this.writes = write.catch(() => {});
    return write;
  }
}

function load(file: string): Saved | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
    const identities = (items: unknown) =>
      Array.isArray(items)
        ? items.filter(
            (item): item is Identity =>
              typeof item?.hostID === "string" && typeof item?.id === "string",
          )
        : [];
    return { version: 1, shared: identities(value.shared), known: identities(value.known) };
  } catch (error) {
    // Only a missing file means "never configured"; a damaged one shares nothing.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { version: 1, shared: [], known: [] };
  }
}
