import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GenerationService,
  defaultProofreadingPrompt as serverPrompt,
} from "../../../Server/src/generation-service.ts";
import { createHTTPServer } from "../../../Server/src/http-server.ts";
import { FakeInference } from "../../../Server/tests/support.ts";
import { API } from "../src/api.ts";
import { defaultProofreadingPrompt, saveSharedPreferences } from "../src/processing.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dictaduo-processing-"));
  const service = await GenerationService.open(
    { dataDirectory: dir, development: true },
    new FakeInference(),
  );
  const server = createHTTPServer(service, "fixture-token");
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await service.shutdown();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { api: new API(address, "fixture-token"), address };
}
test("shared processing saves preserve settings and dictionary metadata, and reject stale writers", async () => {
  const { api } = await fixture();
  expect(defaultProofreadingPrompt).toBe(serverPrompt);
  const base = await api.preferences();
  const value = {
    ...base,
    preferences: {
      ...base.preferences,
      proofreadingPrompt: "Preserve my wording.",
      dictionary: {
        lists: [
          {
            id: "names",
            name: "Names",
            entries: [
              {
                id: "dictaduo",
                term: "DictaDuo",
                aliases: ["so toe", "so, too"],
                isPriority: true,
              },
            ],
          },
        ],
      },
    },
  };
  const saved = await saveSharedPreferences(api, value);
  expect(saved.preferences).toEqual(value.preferences);
  await expect(saveSharedPreferences(api, value)).rejects.toThrow("Another device changed");
  const reset = await saveSharedPreferences(api, {
    ...saved,
    preferences: { ...saved.preferences, proofreadingPrompt: defaultProofreadingPrompt },
  });
  expect(reset.preferences.dictionary).toEqual(value.preferences.dictionary);
  expect(reset.preferences.keepOriginalAudio).toBe(base.preferences.keepOriginalAudio);
  expect(reset.preferences.language).toBe(base.preferences.language);
});
test("dictionary validation and request size failures do not write, and errors never expose server internals", async () => {
  const { api, address } = await fixture();
  const base = await api.preferences();
  await expect(
    saveSharedPreferences(api, {
      ...base,
      preferences: { ...base.preferences, proofreadingPrompt: " " },
    }),
  ).rejects.toThrow("cannot be empty");
  await expect(
    saveSharedPreferences(api, {
      ...base,
      preferences: {
        ...base.preferences,
        dictionary: {
          lists: [
            {
              id: "l",
              name: "Names",
              entries: [{ id: "e", term: "DictaDuo", aliases: ["dictaduo"] }],
            },
          ],
        },
      },
    }),
  ).rejects.toThrow("different from its preferred spelling");
  const entries = Array.from({ length: 500 }, (_, i) => ({
    id: `entry-${i}`,
    term: `term-${i}-${"x".repeat(100)}`,
    aliases: Array.from({ length: 8 }, (_, j) => `alias-${i}-${j}-${"y".repeat(100)}`),
    isPriority: false,
  }));
  await expect(
    saveSharedPreferences(api, {
      ...base,
      preferences: {
        ...base.preferences,
        dictionary: { lists: [{ id: "large", name: "Large", entries }] },
      },
    }),
  ).rejects.toThrow("256 KB");
  expect((await api.preferences()).revision).toBe(base.revision);
  const auth = new API(address, "wrong-private-token");
  await expect(saveSharedPreferences(auth, base)).rejects.toThrow("access token");
  api.savePreferences = async () => {
    throw Error("private-token-and-path");
  };
  await expect(saveSharedPreferences(api, base)).rejects.toThrow("Could not confirm the save");
});
test("a dictionary larger than 64 KB reaches the existing shared preference service", async () => {
  const { api } = await fixture();
  const base = await api.preferences();
  const entries = Array.from({ length: 80 }, (_, i) => ({
    id: `entry-${i}`,
    term: `term-${i}-${"x".repeat(100)}`,
    aliases: Array.from({ length: 8 }, (_, j) => `alias-${i}-${j}-${"y".repeat(100)}`),
    isPriority: i === 0,
  }));
  const value = {
    ...base,
    preferences: {
      ...base.preferences,
      dictionary: { lists: [{ id: "large", name: "Large", entries }] },
    },
  };
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(65536);
  const saved = await saveSharedPreferences(api, value);
  expect(saved.preferences.dictionary.lists[0]?.entries).toEqual(entries);
});
