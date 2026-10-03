import { expect, test } from "bun:test";
import { MicrophoneSharing } from "../src/microphone-sharing.ts";

test("a sharing change that cannot be saved is reported and not applied", async () => {
  const sharing = new MicrophoneSharing("/nonexistent-dictaduo-directory/microphone-sharing.json");
  const source = { hostID: "desktop", id: "dji" };
  await expect(sharing.set(source, true)).rejects.toThrow();
  expect(sharing.isShared(source)).toBe(false);
});

test("overlapping sharing changes are all saved", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "dictaduo-sharing-"));
  try {
    const file = join(directory, "microphone-sharing.json");
    const sharing = new MicrophoneSharing(file);
    await Promise.all([
      sharing.set({ hostID: "desktop", id: "dji" }, true),
      sharing.set({ hostID: "desktop", id: "desk" }, true),
    ]);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.shared.map((source: { id: string }) => source.id).sort()).toEqual(["desk", "dji"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed discovery write is retried on a later discovery", async () => {
  const { mkdtemp, mkdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "dictaduo-sharing-"));
  try {
    const folder = join(directory, "data");
    const sharing = new MicrophoneSharing(join(folder, "microphone-sharing.json"));
    // The data folder is missing, so the first write fails, and so does the final drain.
    sharing.observe([{ hostID: "desktop", id: "dji" }]);
    await sharing.settled();
    await expect(sharing.settled()).rejects.toThrow();
    await mkdir(folder);
    sharing.observe([{ hostID: "desktop", id: "dji" }]);
    await sharing.settled();
    const saved = JSON.parse(await readFile(join(folder, "microphone-sharing.json"), "utf8"));
    expect(saved.shared.map((source: { id: string }) => source.id)).toEqual(["dji"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
