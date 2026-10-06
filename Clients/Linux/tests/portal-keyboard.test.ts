import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PortalKeyboard } from "../src/portal-keyboard.ts";
const native = process.env.DICTADUO_TEST_PORTAL === "1" ? test : test.skip;
const root = resolve(import.meta.dir, "../../..");
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
  "keyboard portal grants keyboard only, rotates private tokens, releases chords and handles revocation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "dictaduo-portal-"));
    const daemon = Bun.spawn(["dbus-daemon", "--session", "--nofork", "--print-address=1"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const address = await lines(daemon.stdout)();
    const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: address, XDG_STATE_HOME: directory };
    const fixture = Bun.spawn([join(root, ".local/portal-fixture")], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const readFixture = lines(fixture.stdout);
    const launch = (mode: string) =>
      Bun.spawn([join(root, "build/linux-client/dictaduo-portal-keyboard"), mode], {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
    let helper = launch("--authorize");
    try {
      expect(await readFixture()).toBe("ready");
      let read = lines(helper.stdout);
      expect(await read()).toBe("ready");
      const token = join(directory, "dictaduo/keyboard-portal-token");
      expect((await stat(token)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(token).text()).toBe("private-test-token");
      helper.stdin.write(JSON.stringify({ text: "æ👋" }) + "\n");
      await helper.stdin.flush();
      expect(await read()).toBe("sent");
      helper.stdin.write('{"paste":true}\n');
      await helper.stdin.flush();
      expect(await read()).toBe("sent");
      helper.stdin.write('{"text":"unsafe\\n"}\n');
      await helper.stdin.flush();
      expect(await read()).toBe("unavailable");
      helper.stdin.end();
      await helper.exited;
      helper = launch("--restore");
      read = lines(helper.stdout);
      expect(await read()).toBe("ready");
      fixture.stdin.write("get\n");
      await fixture.stdin.flush();
      const state = JSON.parse(await readFixture());
      expect(state.types).toBe(1);
      expect(state.restored).toBe(true);
      expect(state.closed).toBe(true);
      expect(state.keys).toEqual([
        [0xe6, 1],
        [0xe6, 0],
        [0x1000000 + 0x1f44b, 1],
        [0x1000000 + 0x1f44b, 0],
        [0xffe3, 1],
        [118, 1],
        [118, 0],
        [0xffe3, 0],
      ]);
      fixture.stdin.write("revoke\n");
      await fixture.stdin.flush();
      expect(await helper.exited).toBe(0);
      await chmod(token, 0o644);
      helper = launch("--restore");
      read = lines(helper.stdout);
      expect(await read()).toBe("unavailable");
      expect(await helper.exited).toBe(1);
      const keyboard = new PortalKeyboard(
        join(root, "build/linux-client/dictaduo-portal-keyboard"),
        env,
      );
      const waitStatus = async (status: PortalKeyboard["status"]) => {
        for (let i = 0; i < 100 && keyboard.status !== status; i++) await Bun.sleep(10);
        expect(keyboard.status).toBe(status);
      };
      try {
        await waitStatus("unavailable");
        keyboard.enable();
        await waitStatus("ready");
        expect((await stat(token)).mode & 0o777).toBe(0o600);
        fixture.stdin.write("get\n");
        await fixture.stdin.flush();
        expect(JSON.parse(await readFixture()).restored).toBe(false);
        expect(await keyboard.type("æ", false)).toBe(true);
        const cancelled = keyboard.type("x", false);
        keyboard.abort();
        keyboard.enable(true);
        expect(await cancelled).toBe(false);
        await waitStatus("ready");
        fixture.stdin.write("get\n");
        await fixture.stdin.flush();
        expect(JSON.parse(await readFixture()).restored).toBe(true);
        expect(await keyboard.type("👋", false)).toBe(true);
      } finally {
        keyboard.close();
      }
    } finally {
      helper.kill();
      fixture.kill();
      daemon.kill();
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000,
);
