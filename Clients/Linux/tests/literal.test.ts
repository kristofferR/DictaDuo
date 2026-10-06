import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
native(
  "input-method commits literal Unicode with the current serial and refuses an occupied or protected seat",
  async () => {
    const root = resolve(import.meta.dir, "../../..");
    const directory = await mkdtemp(join(tmpdir(), "dictaduo-literal-"));
    const env = { ...process.env, XDG_RUNTIME_DIR: directory };
    const fixture = Bun.spawn([join(root, ".local/clipboard-fixture")], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const readFixture = lines(fixture.stdout);
    const socket = await readFixture();
    const launch = () =>
      Bun.spawn([join(root, "build/linux-client/dictaduo-literal")], {
        env: { ...env, WAYLAND_DISPLAY: socket },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
    const helper = launch();
    const read = lines(helper.stdout);
    const send = async (text: string) => {
      helper.stdin.write(JSON.stringify(text) + "\n");
      await helper.stdin.flush();
      return read();
    };
    const control = async (value: string) => {
      fixture.stdin.write(value + "\n");
      await fixture.stdin.flush();
      return readFixture();
    };
    try {
      expect(await read()).toBe("ready");
      const other = launch();
      expect(await lines(other.stdout)()).toBe("unavailable");
      expect(await other.exited).toBe(1);
      const text = "\n\tæøå 👋🏽 👨‍👩‍👧‍👦\nsecond";
      expect(await send(text)).toBe("sent");
      expect(Buffer.from(await control("literal"), "base64").toString()).toBe(text);
      expect(await send("unsafe\x1b")).toBe("unavailable");
      expect(await control("protected")).toBe("protected");
      expect(await send("must not be inserted")).toBe("unavailable");
      expect(Buffer.from(await control("literal"), "base64").toString()).toBe(text);
      expect(await control("inactive")).toBe("inactive");
      expect(await send("must stay saved")).toBe("unavailable");
      helper.stdin.end();
      expect(await helper.exited).toBe(0);
      const protectedHelper = launch();
      expect(await lines(protectedHelper.stdout)()).toBe("unavailable");
      expect(await protectedHelper.exited).toBe(1);
    } finally {
      helper.kill();
      fixture.kill();
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000,
);
