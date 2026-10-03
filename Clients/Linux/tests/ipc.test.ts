import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { send, serve } from "../src/ipc.ts";
import { ClientNotice } from "../src/errors.ts";

test("private IPC serializes commands, rejects a second daemon and releases its lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dictaduo-ipc-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
  let close: (() => Promise<void>) | undefined;
  try {
    const calls: string[] = [];
    close = await serve(async (command) => {
      calls.push(command);
      await Bun.sleep(10);
      return "ok";
    });
    expect((await stat(join(dir, "dictaduo-client", "control.sock"))).mode & 0o777).toBe(0o600);
    expect(await send("start")).toBe("ok\n");
    expect(await send("stop")).toBe("ok\n");
    expect(calls).toEqual(["start", "stop"]);
    await expect(serve(async () => "other")).rejects.toThrow("lock");
    expect(await send("status")).toBe("ok\n");
    await close();
    close = await serve(async () => "new process, no take");
    expect(await send("status")).toBe("new process, no take\n");
  } finally {
    await close?.();
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("GUI IPC accepts a newline without a half-close and rejects malformed JSON", async () => {
  const { connect } = await import("node:net");
  const dir = await mkdtemp(join(tmpdir(), "dictaduo-gui-ipc-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
  let close: (() => Promise<void>) | undefined;
  const request = (input: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect(join(dir, "dictaduo-client", "control.sock"));
      const decoder = new StringDecoder("utf8");
      let data = "";
      socket.setTimeout(3000, () => socket.destroy(new Error("timeout")));
      socket.on("connect", () => socket.write(input));
      socket.on("data", (bytes) => {
        data += decoder.write(bytes);
      });
      socket.on("end", () => resolve(data + decoder.end()));
      socket.on("error", reject);
    });
  try {
    close = await serve(
      async () => "ok",
      () => {},
      async (value) => {
        if (value !== null && typeof value === "object" && "notice" in value)
          throw new ClientNotice("Finish dictation before changing settings.");
        if (value !== null && typeof value === "object" && "privateError" in value)
          throw new Error("private-token-and-path");
        return { received: value };
      },
    );
    expect(JSON.parse(await request('{"version":1,"action":"snapshot"}\n'))).toEqual({
      ok: true,
      data: { received: { version: 1, action: "snapshot" } },
    });
    expect(JSON.parse(await request("{invalid}\n")).ok).toBe(false);
    expect(JSON.parse(await request('{"notice":true}\n'))).toEqual({
      ok: false,
      error: "Finish dictation before changing settings.",
    });
    expect(JSON.parse(await request('{"privateError":true}\n'))).toEqual({
      ok: false,
      error: "Request failed. Check the connection and reload before trying again.",
    });
    const unicode = "æøå🌍".repeat(12000);
    expect(
      JSON.parse(await request(JSON.stringify({ unicode }) + "\n")).data.received.unicode,
    ).toBe(unicode);
    expect(
      JSON.parse(await request(JSON.stringify({ large: "x".repeat(530000) }) + "\n")).error,
    ).toContain("too large");
    expect(await send("status")).toBe("ok\n");
  } finally {
    await close?.();
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
