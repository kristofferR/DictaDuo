import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WaylandClipboard } from "../src/wayland-clipboard.ts";
const native = process.env.DICTADUO_TEST_CLIPBOARD === "1" ? test : test.skip;
function lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let buffer = "";
  return async () => {
    while (!buffer.includes("\n")) {
      const next = await reader.read();
      if (next.done) return "";
      buffer += new TextDecoder().decode(next.value);
    }
    const at = buffer.indexOf("\n");
    const value = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    return value;
  };
}
for (const backend of ["wlr", "ext"] as const)
  native(
    `${backend} Wayland lease preserves binary and empty formats, survives EOF and respects a newer owner`,
    async () => {
      const root = resolve(import.meta.dir, "../../..");
      const directory = await mkdtemp(join(tmpdir(), "dictaduo-clipboard-"));
      const env = { ...process.env, XDG_RUNTIME_DIR: directory };
      const fixture = Bun.spawn(
        [
          join(
            root,
            backend === "wlr" ? ".local/clipboard-fixture" : ".local/clipboard-ext-fixture",
          ),
        ],
        {
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      const readFixture = lines(fixture.stdout);
      const socket = await readFixture();
      const broker = Bun.spawn(
        [
          join(
            root,
            backend === "wlr"
              ? "build/linux-client/dictaduo-clipboard"
              : "build/linux-client/dictaduo-clipboard-ext",
          ),
        ],
        {
          env: { ...env, WAYLAND_DISPLAY: socket },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const read = lines(broker.stdout);
      const command = async (value: unknown) => {
        broker.stdin.write(JSON.stringify(value) + "\n");
        await broker.stdin.flush();
        return read();
      };
      const get = async (type: string) => {
        fixture.stdin.write(type + "\n");
        await fixture.stdin.flush();
        return Buffer.from(await readFixture(), "base64");
      };
      try {
        expect(await read()).toBe("ready");
        const before = await get("text/plain;charset=utf-8");
        expect(await command({ stage: "temporary 👋\n\t" })).toBe("staged");
        expect(await command({ check: true })).toBe("owned");
        expect((await get("text/plain;charset=utf-8")).toString()).toBe("temporary 👋\n\t");
        expect(await command({ restore: true })).toBe("restored");
        expect(await get("text/plain;charset=utf-8")).toEqual(before);
        expect((await get("text/html")).toString()).toBe("<b>original</b>");
        expect(await get("image/png")).toEqual(Buffer.from([0x89, 80, 78, 71, 0, 255]));
        expect((await get("application/x-empty")).length).toBe(0);
        expect(await command({ stage: "not the newer owner" })).toBe("staged");
        fixture.stdin.write("external\n");
        await fixture.stdin.flush();
        expect(await readFixture()).toBe("external");
        expect(await command({ check: true })).toBe("changed");
        expect(await command({ restore: true })).toBe("restored");
        expect(await get("text/plain;charset=utf-8")).toEqual(before);
        expect(await command({ stage: "restore on client exit" })).toBe("staged");
        await broker.stdin.end();
        await Bun.sleep(40);
        expect(await get("text/plain;charset=utf-8")).toEqual(before);
        expect((await get("text/html")).toString()).toBe("<b>original</b>");
        fixture.stdin.write("external\n");
        await fixture.stdin.flush();
        await readFixture();
        expect(await broker.exited).toBe(0);
        const clipboard = new WaylandClipboard(
          join(root, "build/linux-client/dictaduo-clipboard"),
          { ...env, WAYLAND_DISPLAY: socket },
        );
        try {
          expect(
            await clipboard.lease("typed through lease", async (owns) => {
              expect(await owns()).toBe(true);
              expect((await get("text/plain;charset=utf-8")).toString()).toBe(
                "typed through lease",
              );
              return "inserted";
            }),
          ).toBe("inserted");
          expect((await get("text/html")).toString()).toBe("<b>original</b>");
        } finally {
          clipboard.close();
        }
        await Bun.sleep(40);
        expect(await get("image/png")).toEqual(Buffer.from([0x89, 80, 78, 71, 0, 255]));
        fixture.stdin.write("external\n");
        await fixture.stdin.flush();
        await readFixture();
      } finally {
        broker.kill();
        fixture.kill();
        await rm(directory, { recursive: true, force: true });
      }
    },
    10000,
  );
