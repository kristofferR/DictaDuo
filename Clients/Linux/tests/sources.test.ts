import { expect, test } from "bun:test";
import {
  candidates,
  eligible,
  unavailableReason,
  type Source,
  type SourcePreferences,
} from "../src/sources.ts";
const source = (id: string, hostID = "desktop"): Source => ({
  identity: { hostID, id },
  name: id,
  transport: "usb",
  present: true,
  link: "connected",
  capture: "available",
  audioHealth: "unknown",
  observedAt: new Date().toISOString(),
});
const preferences: SourcePreferences = {
  hostID: "desktop",
  mode: "automatic",
  priority: [{ hostID: "desktop", id: "DJI" }],
};
test("priority uses one registered DJI, then the desktop default, without importing Mac preferences", () => {
  const dji = source("DJI"),
    builtIn = source("built-in"),
    remote = source("a-remote", "other-host");
  expect(
    candidates([builtIn, dji, remote], preferences, builtIn.identity).map((s) => s.name),
  ).toEqual(["DJI", "built-in"]);
  expect(candidates([dji, remote], preferences, dji.identity)).toEqual([dji]);
  expect(candidates([remote], preferences)).toEqual([]);
  expect(
    candidates([dji, builtIn], { ...preferences, mode: "systemDefault" }, builtIn.identity),
  ).toEqual([builtIn]);
  expect(
    candidates([builtIn], { ...preferences, mode: "fixed", fixed: dji.identity }, builtIn.identity),
  ).toEqual([builtIn]);
});
test("a source recording for another computer is busy; one recording for this computer is not", () => {
  const dji = source("DJI"),
    builtIn = source("built-in");
  const busy = { ...dji, recordingFor: { id: "mac", name: "MacBook" } };
  expect(candidates([busy, builtIn], preferences, builtIn.identity, "linux")).toEqual([builtIn]);
  expect(unavailableReason(busy, "linux")).toBe("Busy · MacBook is dictating");
  const ours = { ...dji, recordingFor: { id: "linux", name: "Omarchy" } };
  expect(candidates([ours, builtIn], preferences, builtIn.identity, "linux")).toEqual([
    ours,
    builtIn,
  ]);
});
test("stale, future, disconnected, unknown, muted, and degraded inputs cannot be selected", () => {
  const valid = source("DJI");
  for (const patch of [
    { observedAt: new Date(Date.now() - 3501).toISOString() },
    { observedAt: new Date(Date.now() + 5000).toISOString() },
    { link: "unknown" as const },
    { link: "disconnected" as const },
    { capture: "unavailable" as const },
    { audioHealth: "degraded" as const },
    { present: false },
  ])
    expect(eligible({ ...valid, ...patch })).toBe(false);
  expect(eligible(valid)).toBe(true); // Silence/unknown audio health does not prove radio failure.
  expect(eligible({ ...valid, link: "notApplicable" })).toBe(true);
});
