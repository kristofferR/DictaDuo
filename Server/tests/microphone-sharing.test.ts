import { expect, test } from "bun:test";
import { MicrophoneSharing } from "../src/microphone-sharing.ts";

test("a sharing change that cannot be saved is reported and not applied", async () => {
  const sharing = new MicrophoneSharing("/nonexistent-sottoduo-directory/microphone-sharing.json");
  const source = { hostID: "desktop", id: "dji" };
  await expect(sharing.set(source, true)).rejects.toThrow();
  expect(sharing.isShared(source)).toBe(false);
});
