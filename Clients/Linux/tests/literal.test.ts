import { expect, test } from "bun:test";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { NativeDestinations } from "../src/native-destination.ts";
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

native(
  "literal delivery releases the IME seat while another take retains the destination",
  async () => {
    const root = resolve(import.meta.dir, "../../..");
    const directory = await mkdtemp(join(tmpdir(), "dictaduo-literal-queue-"));
    const fixture = Bun.spawn([join(root, ".local/clipboard-fixture")], {
      env: { ...process.env, XDG_RUNTIME_DIR: directory },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const readFixture = lines(fixture.stdout);
    const socket = await readFixture();
    const destinations = new NativeDestinations();
    let other: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
    try {
      const helper = join(directory, "dictaduo-destination");
      // The private destination acknowledges commits; the real Wayland fixture
      // below verifies their content and exclusive seat ownership independently.
      await Bun.write(
        helper,
        `#!${process.execPath}\nimport { createInterface } from "node:readline";\nconsole.log("ready:chromium");\ncreateInterface({ input: process.stdin }).on("line", line => console.log(line === "false" ? "inserted" : "ready"));\n`,
      );
      await chmod(helper, 0o700);
      // Spawn on the fixture's display without changing the test process's seat.
      const literal = join(directory, "dictaduo-literal");
      await Bun.write(
        literal,
        `#!${process.execPath}\nconst child = Bun.spawn([${JSON.stringify(join(root, "build/linux-client/dictaduo-literal"))}], {
      env: { ...process.env, XDG_RUNTIME_DIR: ${JSON.stringify(directory)}, WAYLAND_DISPLAY: ${JSON.stringify(socket)} },
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    process.exit(await child.exited);\n`,
      );
      await chmod(literal, 0o700);
      const first = await destinations.capture(helper, "test", "unicodeTyping");
      const next = await destinations.capture(helper, "test", "unicodeTyping");
      expect(first.reason).toBeUndefined();
      expect(next.reason).toBeUndefined();
      const result = await first.deliver("\n👋 first");
      expect({ result, reason: first.reason }).toEqual({ result: "inserted", reason: undefined });
      other = Bun.spawn([join(directory, "dictaduo-literal")], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      expect(await lines(other.stdout)()).toBe("ready");
      other.stdin.end();
      expect(await other.exited).toBe(0);
      expect(await next.deliver("\n👋 next")).toBe("inserted");
      fixture.stdin.write("literal\n");
      await fixture.stdin.flush();
      expect(Buffer.from(await readFixture(), "base64").toString()).toBe("\n👋 first\n👋 next");
    } finally {
      destinations.close();
      other?.kill();
      fixture.kill();
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000,
);
