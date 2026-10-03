import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { validateBody } from "../../../Server/src/validation.ts";
import { profileFields, type ConfiguredSources } from "./microphones.ts";
import type { SourcePreferences } from "./sources.ts";
export interface Config {
  buttonEnabled: boolean;
  /** Hold the key to dictate, or double tap it to toggle recording. */
  activationMode: "hold" | "doubleTap";
  muteOutputWhileRecording: boolean;
  server: string;
  tokenFile: string;
  device: { id: string; name: string };
  sources: ConfiguredSources;
  destinationHelper: string;
}
export const configPath = () => {
  if (process.env.SOTTODUO_CLIENT_CONFIG !== undefined) return process.env.SOTTODUO_CLIENT_CONFIG;
  const home = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(home, "sottoduo", "linux-client.json");
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function endpoint(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use an HTTP(S) server origin without credentials or a path.");
  return url.origin;
}
export function parseConfig(value: unknown): Config {
  if (
    !object(value) ||
    typeof value.server !== "string" ||
    typeof value.tokenFile !== "string" ||
    !isAbsolute(value.tokenFile) ||
    typeof value.destinationHelper !== "string" ||
    !isAbsolute(value.destinationHelper) ||
    !object(value.sources)
  )
    throw new Error("Invalid Linux client configuration.");
  const s = value.sources;
  if (s.server !== endpoint(value.server))
    throw new Error(
      "These microphone settings belong to another server. Choose your microphones again for this server.",
    );
  if (
    typeof s.hostID !== "string" ||
    !s.hostID.trim() ||
    !["automatic", "fixed", "systemDefault"].includes(String(s.mode)) ||
    !Array.isArray(s.priority) ||
    s.priority.length > 32
  )
    throw new Error("Invalid microphone preferences.");
  const fixed = s.fixed === undefined ? undefined : validateBody("AudioSourceIdentity", s.fixed);
  if (s.mode === "fixed" && !fixed) throw new Error("Fixed selection needs a source identity.");
  return {
    buttonEnabled: value.buttonEnabled === true,
    activationMode: value.activationMode === "doubleTap" ? "doubleTap" : "hold",
    muteOutputWhileRecording: value.muteOutputWhileRecording === true,
    server: endpoint(value.server),
    tokenFile: value.tokenFile,
    device: validateBody("DeviceIdentity", value.device),
    destinationHelper: value.destinationHelper,
    sources: {
      server: endpoint(value.server),
      hostID: s.hostID,
      mode: s.mode as SourcePreferences["mode"],
      priority: s.priority.map((id) => validateBody("AudioSourceIdentity", id)),
      fixed,
      ...profileFields(s),
    },
  };
}
export async function readConfig(): Promise<Config> {
  return parseConfig(await Bun.file(configPath()).json());
}
export async function token(config: Config): Promise<string> {
  const info = await stat(config.tokenFile);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || !info.isFile())
    throw new Error("The token file must be owned by you with mode 0600.");
  const text = (await Bun.file(config.tokenFile).text()).trim();
  if (!text || /\s/.test(text)) throw new Error("Invalid token file.");
  return text;
}
export async function initialize(
  server: string,
  hostID: string,
  tokenFile: string,
  destinationHelper: string,
): Promise<void> {
  const value = parseConfig({
    server,
    tokenFile,
    destinationHelper,
    device: { id: randomUUID(), name: "Omarchy" },
    sources: { server: endpoint(server), hostID, mode: "automatic", priority: [] },
  });
  await mkdir(dirname(configPath()), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
