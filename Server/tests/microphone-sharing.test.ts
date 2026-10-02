import { expect, test } from "bun:test";
import { MicrophoneSharing } from "../src/microphone-sharing.ts";

test("a sharing change that cannot be saved is reported and not applied", async () => {
  const sharing = new MicrophoneSharing("/nonexistent-sottoduo-directory/microphone-sharing.json");
  const source = { hostID: "desktop", id: "dji" };
  await expect(sharing.set(source, true)).rejects.toThrow();
  expect(sharing.isShared(source)).toBe(false);
});

test("overlapping sharing changes are all saved", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "sottoduo-sharing-"));
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
