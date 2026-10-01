import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { API, APIError } from "./api.ts";
import { configPath, endpoint, parseConfig, token, type Config } from "./config.ts";
import { ClientNotice } from "./errors.ts";

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ClientNotice(
      "Cannot read connection settings. Check the configuration file permissions.",
    );
  }
}
interface Verified {
  id: string;
  expires: number;
  server: string;
  name: string;
  secret: string;
  api: API;
  hosts: string[];
}

/** Credentials stay here; the GUI receives only a short-lived verification ticket. */
export class ConnectionSettings {
  config?: Config;
  api?: API;
  private disk?: string;
  private verified?: Verified;
  private attempt = 0;
  private readonly deviceID = randomUUID();
  private constructor(
    readonly file: string,
    private helper: string,
  ) {
    this.disk = read(file);
    if (this.disk !== undefined) {
      try {
        this.config = parseConfig(JSON.parse(this.disk));
      } catch {
        /* Allow repair in setup. */
      }
    }
  }
  static async open(helper: string, file = configPath()) {
    const settings = new ConnectionSettings(file, helper);
    if (settings.config) {
      try {
        settings.api = new API(settings.config.server, await token(settings.config));
      } catch {
        /* A missing or unsafe token can be replaced from setup. */
      }
    }
    return settings;
  }
  get setupMessage() {
    if (this.api) return "";
    if (this.config)
      return "The saved access token is missing or has unsafe permissions. Enter it again to repair this connection.";
    if (this.disk !== undefined)
      return "The saved configuration is invalid. Save a verified connection to replace it; a private backup will be kept.";
    return "Enter your server details to set up dictation on this computer.";
  }
  accepted(config: Config) {
    this.config = config;
    this.disk = read(this.file);
    this.verified = undefined;
    this.attempt++;
  }
  private assertUnchanged() {
    if (read(this.file) !== this.disk)
      throw new ClientNotice(
        "Connection settings changed outside SottoDuo. Restart background dictation and try again.",
      );
  }
  async test(request: Record<string, unknown>) {
    const attempt = ++this.attempt;
    this.verified = undefined;
    this.assertUnchanged();
    let server: string;
    try {
      if (typeof request.server !== "string") throw new Error();
      server = endpoint(request.server.trim());
    } catch {
      throw new ClientNotice(
        "Enter an HTTP or HTTPS server address, including its port, without a path or login details.",
      );
    }
    if (
      typeof request.name !== "string" ||
      !request.name.trim() ||
      request.name.trim().length > 120
    )
      throw new ClientNotice("Enter a device name of 1–120 characters.");
    if (typeof request.accessToken !== "string" || request.accessToken.length > 4096)
      throw new ClientNotice("Enter a valid access token.");
    let secret = request.accessToken.trim();
    if (!secret) {
      if (!this.config || this.config.server !== server)
        throw new ClientNotice(
          "Enter an access token for this server. Saved tokens are never sent to a different address.",
        );
      try {
        secret = await token(this.config);
      } catch {
        throw new ClientNotice(
          "The saved token is unavailable. Enter the server’s access token again.",
        );
      }
    }
    if (/\s/.test(secret))
      throw new ClientNotice("Access tokens cannot contain spaces or line breaks.");
    const api = new API(server, secret);
    let health: Awaited<ReturnType<API["health"]>>;
    let hosts: string[];
    try {
      health = await api.health();
      if (health.apiVersion !== 2)
        throw new ClientNotice(
          "This server uses an incompatible API version. Update SottoDuo on both computers.",
        );
      hosts = [...new Set((await api.sources()).map((source) => source.identity.hostID))].sort();
      const savedHost = this.config?.server === server ? this.config.sources.hostID : undefined;
      if (savedHost && !hosts.includes(savedHost)) hosts.push(savedHost);
      hosts.sort();
    } catch (error) {
      if (error instanceof ClientNotice) throw error;
      if (error instanceof APIError && [401, 403].includes(error.status))
        throw new ClientNotice(
          "The server rejected this access token. Check the token and try again.",
        );
      throw new ClientNotice(
        "Could not verify this SottoDuo server. Check its address, network connection and that the server is running.",
      );
    }
    if (attempt !== this.attempt)
      throw new ClientNotice("The connection changed during the check. Test it again.");
    this.assertUnchanged();
    this.verified = {
      id: randomUUID(),
      expires: Date.now() + 120_000,
      server,
      name: request.name.trim(),
      secret,
      api,
      hosts,
    };
    return {
      ticket: this.verified.id,
      hosts,
      hostID: hosts.includes(this.config?.sources.hostID ?? "")
        ? this.config!.sources.hostID
        : hosts.length === 1
          ? hosts[0]
          : "",
      ready: health.ready,
      message: health.ready
        ? "Connected. Choose Save to use this connection."
        : "Connected, but the server is not ready to transcribe yet. You can save this connection.",
    };
  }
  validateSave(ticket: unknown, hostID: unknown) {
    this.assertUnchanged();
    const checked = this.verified;
    if (!checked || checked.id !== ticket || checked.expires < Date.now())
      throw new ClientNotice("Test this connection again before saving.");
    if (
      typeof hostID !== "string" ||
      !hostID.trim() ||
      hostID.length > 200 ||
      (checked.hosts.length > 0 && !checked.hosts.includes(hostID))
    )
      throw new ClientNotice(
        "Choose the computer that provides your microphones. If none are listed, enter its configured capture host ID.",
      );
    return { checked, hostID };
  }
  commit(ticket: unknown, chosenHost: unknown) {
    const { checked, hostID } = this.validateSave(ticket, chosenHost);
    const current = this.config;
    const tokenFile = join(dirname(this.file), `client-token-${randomUUID()}`);
    const config = parseConfig({
      server: checked.server,
      tokenFile,
      destinationHelper: current?.destinationHelper ?? this.helper,
      device: { id: current?.device.id ?? this.deviceID, name: checked.name },
      buttonEnabled: current?.buttonEnabled ?? false,
      activationMode: current?.activationMode ?? "hold",
      sources:
        current?.server === checked.server && current.sources.hostID === hostID
          ? current.sources
          : { server: checked.server, hostID, mode: "automatic", priority: [] },
    });
    const text = JSON.stringify(config, null, 2) + "\n";
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      if (this.disk !== undefined && !current)
        writeFileSync(`${this.file}.backup-${randomUUID()}`, this.disk, {
          mode: 0o600,
          flag: "wx",
        });
      // Never overwrite a shared server token or a user-supplied credential file.
      writeFileSync(tokenFile, checked.secret + "\n", { mode: 0o600, flag: "wx" });
      writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
      this.assertUnchanged();
      renameSync(temp, this.file);
    } catch (error) {
      try {
        unlinkSync(tokenFile);
      } catch {}
      if (error instanceof ClientNotice) throw error;
      throw new ClientNotice(
        "Could not save this connection. Check the configuration directory permissions.",
      );
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
    this.config = config;
    this.api = checked.api;
    this.disk = text;
    this.verified = undefined;
    this.attempt++;
    return { config, api: checked.api };
  }
}
