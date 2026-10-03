import { expect, test } from "bun:test";
import { desktopUnlocked, Notifier } from "../src/desktop.ts";
const state = "LockedHint=no\nActive=yes\nType=wayland\nState=active\n";
const lock = {
  locked: false,
  requested: false,
  pending: false,
  sessionLocked: false,
  secure: false,
  lastEventAt: "",
};
const monitors = [{ solitaryBlockedBy: ["WINDOW"] }];
test("Omarchy lock checks reject pending, orphan and rapid lock/unlock even with stale logind hints", () => {
  expect(desktopUnlocked(state, lock, monitors, 1000)).toBe(true);
  for (const key of ["locked", "requested", "pending", "sessionLocked", "secure"])
    expect(desktopUnlocked(state, { ...lock, [key]: true }, monitors, 1000)).toBe(false);
  expect(desktopUnlocked(state, lock, [{ solitaryBlockedBy: ["LOCK"] }], 1000)).toBe(false);
  expect(desktopUnlocked(state, lock, [{ solitaryBlockedBy: ["WORKSPACE"] }], 1000)).toBe(false);
  expect(desktopUnlocked(state, lock, [{}], 1000)).toBe(false);
  expect(desktopUnlocked(state, lock, [], 1000)).toBe(false);
  expect(
    desktopUnlocked(state, { ...lock, lastEventAt: new Date(1001).toISOString() }, monitors, 1000),
  ).toBe(false);
  expect(desktopUnlocked(state.replace("Active=yes", "Active=no"), lock, monitors, 1000)).toBe(
    false,
  );
});

test("only exact namespaced compositor events control dictation", async () => {
  const { shortcutEvent } = await import("../src/desktop.ts");
  expect(["custom>>sottoduo:start", "custom>>sottoduo:stop"].map(shortcutEvent)).toEqual([
    "start",
    "stop",
  ]);
  for (const event of [
    "custom>>other:start",
    "custom>>sottoduo:start\nstop",
    "windowtitle>>sottoduo:start",
    "custom>>sottoduo:status",
  ])
    expect(shortcutEvent(event)).toBeUndefined();
});

test("each notification replaces the previous one instead of stacking", async () => {
  const calls: string[][] = [];
  const notifier = new Notifier(async (args) => {
    calls.push(args);
    return "41\n";
  });
  notifier.notify("Not pasted", "Your text is ready. Copy it from the tray or SottoDuo.");
  notifier.notify("Check the field");
  await notifier.settled();
  expect(calls[0]!.some((arg) => arg.startsWith("--replace-id"))).toBe(false);
  expect(calls[0]!.slice(-2)).toEqual([
    "Not pasted",
    "Your text is ready. Copy it from the tray or SottoDuo.",
  ]);
  expect(calls[1]).toContain("--replace-id=41");
  expect(calls[1]!.at(-1)).toBe("Check the field");
});
