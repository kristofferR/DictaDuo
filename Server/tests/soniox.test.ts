import { afterEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { startSonioxStream, sonioxHints } from "../src/inference/soniox.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture(message: (socket: ServerWebSocket<undefined>, data: string | Buffer) => void) {
  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: { message },
  });
  cleanups.push(() => {
    server.stop(true);
  });
  return { apiKey: "test-secret", model: "stt-rt-v5", endpoint: `ws://127.0.0.1:${server.port}` };
}

test("streams PCM before release; replaces interim tails, filters markers and drains final tokens", async () => {
  const received: Buffer[] = [],
    previews: string[] = [];
  let configuration: Record<string, unknown> = {};
  const audioArrived = Promise.withResolvers<void>();
  const previewArrived = Promise.withResolvers<void>();
  const config = fixture((socket, data) => {
    if (typeof data === "string" && data) {
      configuration = JSON.parse(data);
      return;
    }
    if (typeof data !== "string") {
      received.push(data);
      socket.send(
        JSON.stringify({
          tokens: [
            { text: "Hello", is_final: true, language: "en" },
            { text: " wrong", is_final: false },
          ],
        }),
      );
      socket.send(JSON.stringify({ tokens: [{ text: " world", is_final: false }] }));
      audioArrived.resolve();
    } else {
      socket.send(
        JSON.stringify({
          tokens: [
            { text: " world.", is_final: true },
            { text: "<end>", is_final: true },
            { text: "<fin>", is_final: true },
          ],
        }),
      );
      socket.send(JSON.stringify({ tokens: [], finished: true }));
      socket.close();
    }
  });
  const stream = startSonioxStream(
    config,
    "auto",
    ["DictaDuo"],
    "generation-id",
    (text) => {
      previews.push(text);
      if (text === "Hello world") previewArrived.resolve();
    },
    () => {},
  );
  cleanups.push(() => stream.cancel());
  const audio = Buffer.alloc(3200, 1);
  stream.send(audio);
  await audioArrived.promise;
  expect(received).toEqual([audio]);
  await previewArrived.promise;
  expect(previews).toContain("Hello world");
  expect(configuration).toMatchObject({
    model: "stt-rt-v5",
    audio_format: "pcm_f32le",
    sample_rate: 16000,
    num_channels: 1,
    context: { terms: ["DictaDuo"] },
  });
  expect(configuration.language_hints).toBeUndefined();
  const result = await stream.finish();
  expect(result.text).toBe("Hello world.");
  expect(result.audioSeconds).toBe(0.05);
  expect(result.language).toBe("en");
});

test.each(["disconnect", "provider-error", "invalid", "premature-finish"])(
  "rejects %s instead of publishing provisional text",
  async (failure) => {
    const rejected = Promise.withResolvers<string>();
    const config = fixture((socket, data) => {
      if (typeof data === "string") return;
      socket.send(JSON.stringify({ tokens: [{ text: "not final", is_final: false }] }));
      if (failure === "disconnect") socket.close();
      if (failure === "provider-error")
        socket.send(JSON.stringify({ error_code: 401, error_message: "test-secret" }));
      if (failure === "invalid") socket.send('{"tokens":[{"text":5}]}');
      if (failure === "premature-finish") socket.send('{"finished":true}');
    });
    const stream = startSonioxStream(config, "en", [], "id", () => {}, rejected.resolve);
    cleanups.push(() => stream.cancel());
    stream.send(Buffer.alloc(3200));
    expect(await rejected.promise).not.toContain("test-secret");
    await expect(stream.finish()).rejects.toThrow();
  },
);

test("cancellation and excessive startup backlog release the session", async () => {
  const config = fixture(() => {});
  const reasons: string[] = [];
  const stream = startSonioxStream(
    config,
    "en",
    [],
    "id",
    () => {},
    (reason) => reasons.push(reason),
  );
  stream.send(Buffer.alloc(128004));
  await expect(stream.finish()).rejects.toThrow("keep up");
  expect(reasons).toHaveLength(1);
  const cancelled = startSonioxStream(
    config,
    "en",
    [],
    "id",
    () => {},
    () => {},
  );
  cancelled.cancel();
  await expect(cancelled.finish()).rejects.toThrow("cancelled");
});

test("context is bounded without dropping deterministic dictionary rules", () => {
  const hints = sonioxHints(["first", "x".repeat(7000), "last"]);
  expect(hints.includedTerms).toEqual(["first", "last"]);
  expect(hints.omittedTerms).toHaveLength(1);
});

test("an open connection that never confirms finish hits a bounded finalization deadline", async () => {
  const config = fixture(() => {});
  const stream = startSonioxStream(
    config,
    "en",
    [],
    "id",
    () => {},
    () => {},
  );
  cleanups.push(() => stream.cancel());
  stream.send(Buffer.alloc(3200));
  await expect(stream.finish()).rejects.toThrow("finalization timed out");
}, 15_000);
