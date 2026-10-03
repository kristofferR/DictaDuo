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
  /** A discovery write failed; later observations and shutdown retry it. */
  private dirty = false;

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
    if (!unseen.length) {
      if (this.dirty) this.persist();
      return;
    }
    for (const source of unseen) {
      this.known.set(key(source), structuredClone(source));
      if (!this.seeded) this.shared.add(key(source));
    }
    this.seeded = true;
    this.persist();
  }

  /**
   * Each change reads, saves and applies the current state as one queued step,
   * so overlapping changes cannot drop each other; a failed write changes nothing.
   */
  set(source: Identity, shared: boolean) {
    return this.enqueue(async () => {
      const next = new Set(this.shared);
      if (shared) next.add(key(source));
      else next.delete(key(source));
      const known = new Map(this.known).set(key(source), structuredClone(source));
      await this.save(known, next);
      this.known = known;
      this.shared = next;
      this.seeded = true;
    });
  }

  /** Waits for pending writes, so tests and shutdown see the saved state. */
  settled() {
    // A last attempt for a failed discovery write reports its failure.
    if (this.dirty) {
      this.dirty = false;
      return this.enqueue(() => this.save(this.known, this.shared)).catch((error: unknown) => {
        this.dirty = true;
        throw error;
      });
    }
    return this.writes;
  }

  /** Discovery records new sources in the background; a later write retries it. */
  private persist() {
    this.dirty = false;
    void this.enqueue(() => this.save(this.known, this.shared)).catch(() => {
      this.dirty = true;
    });
  }

  private enqueue(step: () => Promise<void>) {
    const run = this.writes.then(step);
    this.writes = run.catch(() => {});
    return run;
  }

  private async save(known: Map<string, Identity>, shared: Set<string>) {
    if (!this.file) return;
    const saved: Saved = {
      version: 1,
      known: [...known.values()],
      shared: [...known.values()].filter((source) => shared.has(key(source))),
    };
    await atomicPrivateWrite(this.file, JSON.stringify(saved));
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
