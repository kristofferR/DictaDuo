import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPath, endpoint, parseConfig } from "../src/config.ts";
test("endpoint changes cannot silently reuse another server's microphone preferences", () => {
  const value = {
    server: "http://localhost:8391",
    tokenFile: "/private/token",
    destinationHelper: "/opt/dictaduo-destination",
    device: { id: "desktop", name: "Omarchy" },
    sources: {
      server: "http://localhost:8391",
      hostID: "desktop",
      mode: "automatic",
      priority: [],
    },
  };
  expect(parseConfig(value).sources.hostID).toBe("desktop");
  expect(() => parseConfig({ ...value, server: "http://other-server:8391" })).toThrow(
    "another server",
  );
  expect(() => endpoint("https://secret@example.com")).toThrow();
  expect(() => endpoint("http://localhost:8391/v1")).toThrow();
  expect(() => parseConfig({ ...value, sources: { ...value.sources, mode: "fixed" } })).toThrow(
    "source identity",
  );
});

test("an empty XDG config directory uses the home config path", () => {
  const previousConfig = process.env.DICTADUO_CLIENT_CONFIG;
  const previousXDG = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.DICTADUO_CLIENT_CONFIG;
    process.env.XDG_CONFIG_HOME = "";
    const homeConfig = join(homedir(), ".config");
    expect(configPath()).toBe(join(homeConfig, "dictaduo", "linux-client.json"));
  } finally {
    if (previousConfig === undefined) delete process.env.DICTADUO_CLIENT_CONFIG;
    else process.env.DICTADUO_CLIENT_CONFIG = previousConfig;
    if (previousXDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXDG;
  }
});
