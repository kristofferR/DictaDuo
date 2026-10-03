import { connect, createServer } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { acquireDataDirectoryLock } from "../../../Server/src/data-lock.ts";
import { ClientNotice } from "./errors.ts";
export type Command =
  | "start"
  | "stop"
  | "toggle"
  | "cancel"
  | "undo"
  | "status"
  | "result"
  | "copy"
  | "arm"
  | "disarm"
  | "button-status";
export const commands: readonly string[] = [
  "start",
  "stop",
  "toggle",
  "cancel",
  "undo",
  "status",
  "result",
  "copy",
  "arm",
  "disarm",
  "button-status",
];
export function isCommand(value: string): value is Command {
  return commands.includes(value);
}
async function path(): Promise<string> {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime) throw new Error("XDG_RUNTIME_DIR is missing.");
  const dir = join(runtime, "dictaduo-client");
  await mkdir(dir, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Unsafe client runtime directory.");
  return join(dir, "control.sock");
}
export async function send(command: Command): Promise<string> {
  const socket = connect(await path());
  return new Promise((resolve, reject) => {
    let value = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("DictaDuo did not respond.")));
    socket.on("connect", () => socket.write(command + "\n"));
    socket.on("data", (data: Buffer) => {
      value += data.toString();
      if (value.length > 524288) socket.destroy(new Error("Oversized reply."));
    });
    socket.on("end", () => resolve(value));
    socket.on("error", reject);
  });
}
export async function serve(
  handler: (command: Command) => Promise<string>,
  onFailure: () => void = () => {},
  gui?: (request: unknown) => Promise<unknown>,
): Promise<() => Promise<void>> {
  const socketPath = await path();
  const lock = acquireDataDirectoryLock(dirname(socketPath));
  try {
    await unlink(socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  } catch (error) {
    lock.release();
    throw error;
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const decoder = new StringDecoder("utf8");
    let input = "";
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => {});
    let handled = false;
    const dispatch = () => {
      if (handled || socket.destroyed) return;
      handled = true;
      socket.setTimeout(15000, () => socket.destroy());
      if (input.trimStart().startsWith("{")) {
        void (async () => {
          try {
            if (!gui) throw new Error();
            const request: unknown = JSON.parse(input);
            if (request !== null && typeof request === "object" && "action" in request) {
              if (request.action === "historyAudio" || request.action === "historyArtifact")
                socket.setTimeout(365_000, () => socket.destroy());
              else if (request.action === "history" || request.action === "historyEntry")
                socket.setTimeout(65_000, () => socket.destroy());
              else if (request.action === "deleteHistory")
                socket.setTimeout(70_000, () => socket.destroy());
              // Longer than the retry request itself, which verifies a finished take's audio.
              else if (request.action === "retryHistory")
                socket.setTimeout(122_000, () => socket.destroy());
              else if (request.action === "saveShortcut")
                socket.setTimeout(30_000, () => socket.destroy());
            }
            const data = await gui(request);
            socket.end(JSON.stringify({ ok: true, data }) + "\n");
          } catch (error) {
            socket.end(
              JSON.stringify({
                ok: false,
                error:
                  error instanceof ClientNotice
                    ? error.message
                    : "Request failed. Check the connection and reload before trying again.",
              }) + "\n",
            );
          }
        })();
        return;
      }
      const command = input.trim();
      if (!isCommand(command)) {
        socket.end("Unknown command.\n");
        return;
      }
      void handler(command).then(
        (value) => socket.end(value + "\n"),
        () => socket.end("Command failed.\n"),
      );
    };
    socket.on("data", (data: Buffer) => {
      if (handled) {
        socket.destroy();
        return;
      }
      input += decoder.write(data);
      if (Buffer.byteLength(input) > 524288) {
        handled = true;
        socket.removeAllListeners("data");
        socket.resume();
        socket.end(
          JSON.stringify({
            ok: false,
            error: "Settings are too large. Reduce the dictionary or vocabulary before saving.",
          }) + "\n",
        );
      } else if (input.includes("\n")) dispatch();
    });
    socket.on("end", () => {
      input += decoder.end();
      dispatch();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    server.on("error", onFailure);
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    lock.release();
    throw error;
  }
  return async () => {
    server.close();
    await unlink(socketPath).catch(() => {});
    lock.release();
  };
}
