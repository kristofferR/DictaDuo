import type { SonioxConfiguration } from "./inference/soniox.ts";
import type { PipeWireConfiguration } from "./capture/pipewire-provider.ts";
import { readRegularFile } from "./storage.ts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createInferenceConfiguration,
  type InferenceConfiguration,
} from "./inference/native-inference.ts";

export interface ServerConfiguration {
  host: string;
  port: number;
  dataDirectory: string;
  token?: string;
  development: boolean;
  soniox?: SonioxConfiguration;
  inference: InferenceConfiguration;
  capture?: PipeWireConfiguration;
  button?: { helper: string; sourceID: string };
}

export const usage = `SottoDuo server — independent dictation service
sottoduo-server --data-dir PATH --speech-helper PATH --speech-model PATH --vad-model PATH \
  --proof-helper PATH --proof-model PATH [--parakeet-model PATH] [--host 127.0.0.1] [--port 8391] \
  [--token-file PATH] [--dev]

macOS uses Whisper/Metal and Qwen/MLX. Linux uses Whisper/CUDA or CPU and Qwen/llama.cpp.
--parakeet-model additionally offers Parakeet TDT 0.6B v3 as a shared recognition engine choice.
Soniox streaming is preferred when SONIOX_API_KEY or --soniox-key-file is configured.
Whisper remains the automatic offline fallback.
Models must already exist. The server never downloads or imports personal data automatically.
Use persistent storage for --data-dir. Remote bindings require --token-file.
Optional Linux capture: --capture-helper PATH --capture-host-id STABLE_NAME.
Optional device-scoped button routing: --button-helper PATH --button-source-id STABLE_SOURCE_ID.
Run in the desktop user's PipeWire session; without these options the server stays headless.
`;

const names = new Set([
  "soniox-key-file",
  "host",
  "port",
  "data-dir",
  "token-file",
  "speech-helper",
  "speech-model",
  "vad-model",
  "proof-helper",
  "proof-model",
  "parakeet-model",
  "capture-helper",
  "capture-host-id",
  "button-helper",
  "button-source-id",
]);
export const isLoopbackHost = (host: string) => ["localhost", "127.0.0.1", "::1"].includes(host);
const expandPath = (value: string) =>
  resolve(
    value === "~" ? homedir() : value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value,
  );

export async function parseConfiguration(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
) {
  const options = new Map<string, string>();
  let development = environment.SOTTODUO_DEV === "1";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--dev") {
      development = true;
      continue;
    }
    const name = argument.slice(2);
    const value = args[index + 1];
    if (
      !argument.startsWith("--") ||
      !names.has(name) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`Unknown or incomplete argument: ${argument}. Use --help for usage.`);
    }
    options.set(name, value);
    index++;
  }
  const value = (name: string, variable: string) => options.get(name) ?? environment[variable];
  const path = (name: string, variable: string) => {
    const raw = value(name, variable);
    if (!raw) throw new Error(`Configure --${name} or ${variable}.`);
    return expandPath(raw);
  };
  const optionalPath = (name: string, variable: string) => {
    const raw = value(name, variable);
    return raw ? expandPath(raw) : undefined;
  };
  const rawPort = value("port", "SOTTODUO_SERVER_PORT") ?? "8391";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be between 1 and 65535.");
  }
  let token: string | undefined;
  const tokenFile = value("token-file", "SOTTODUO_SERVER_TOKEN_FILE");
  if (tokenFile) {
    const file = await open(
      expandPath(tokenFile),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096)
        throw new Error("The token file must contain at most 4096 bytes of UTF-8 text.");
      const bytes = await file.readFile();
      if (bytes.length > 4096)
        throw new Error("The token file must contain at most 4096 bytes of UTF-8 text.");
      token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    } finally {
      await file.close();
    }
    if (!token || /\s/u.test(token))
      throw new Error("The server token must be nonempty and contain no whitespace.");
  }
  const host = value("host", "SOTTODUO_SERVER_HOST") ?? "127.0.0.1";
  if (!isLoopbackHost(host) && Buffer.byteLength(token ?? "") < 32) {
    throw new Error(
      "Listening beyond localhost requires a token file containing at least 32 characters. Use HTTPS or a private encrypted network for remote connections.",
    );
  }
  const keyFile = value("soniox-key-file", "SOTTODUO_SONIOX_KEY_FILE");
  const apiKey = keyFile
    ? new TextDecoder("utf-8", { fatal: true })
        .decode(await readRegularFile(expandPath(keyFile), 4096))
        .trim()
    : environment.SONIOX_API_KEY?.trim();
  if ((keyFile && !apiKey) || (apiKey && (/\s/u.test(apiKey) || Buffer.byteLength(apiKey) > 4096)))
    throw new Error(
      "The Soniox key must be nonempty, without whitespace, and fit within 4096 bytes.",
    );
  const captureHelper = value("capture-helper", "SOTTODUO_CAPTURE_HELPER");
  const captureHostID = value("capture-host-id", "SOTTODUO_CAPTURE_HOST_ID");
  const buttonHelper = value("button-helper", "SOTTODUO_BUTTON_HELPER");
  const buttonSourceID = value("button-source-id", "SOTTODUO_BUTTON_SOURCE_ID");
  if (
    (buttonHelper || buttonSourceID) &&
    (!captureHelper || !buttonHelper || !buttonSourceID || !/^[a-f0-9]{64}$/.test(buttonSourceID))
  )
    throw new Error(
      "Button routing requires capture plus --button-helper and the exact --button-source-id from audio discovery.",
    );
  if (
    (captureHelper || captureHostID) &&
    (!captureHelper || !captureHostID || !/^[a-zA-Z0-9._-]{1,128}$/.test(captureHostID))
  )
    throw new Error(
      "Configure both --capture-helper and a stable --capture-host-id (letters, digits, dots, underscores or hyphens).",
    );
  return {
    button:
      buttonHelper && buttonSourceID
        ? { helper: expandPath(buttonHelper), sourceID: buttonSourceID }
        : undefined,
    capture:
      captureHelper && captureHostID
        ? { helper: expandPath(captureHelper), hostID: captureHostID }
        : undefined,
    soniox: apiKey
      ? {
          apiKey,
          model: "stt-rt-v5",
          endpoint: "wss://stt-rt.soniox.com/transcribe-websocket",
        }
      : undefined,
    host,
    port,
    token,
    development,
    dataDirectory: path("data-dir", "SOTTODUO_SERVER_DATA_DIR"),
    inference: createInferenceConfiguration({
      speechHelper: path("speech-helper", "SOTTODUO_ENGINE_PATH"),
      speechModel: path("speech-model", "SOTTODUO_SPEECH_MODEL"),
      vadModel: path("vad-model", "SOTTODUO_VAD_PATH"),
      proofHelper: path("proof-helper", "SOTTODUO_TEXT_ENGINE_PATH"),
      proofModel: path("proof-model", "SOTTODUO_TEXT_MODEL"),
      parakeetModel: optionalPath("parakeet-model", "SOTTODUO_PARAKEET_MODEL"),
    }),
  } satisfies ServerConfiguration;
}
