import { expect, test } from "bun:test";
import {
  isPlasmaDesktop,
  loginSessionPath,
  plasmaLockEvent,
  plasmaUnlocked,
} from "../src/plasma.ts";

const active = "LockedHint=no\nActive=yes\nType=wayland\nState=active\n";

test("desktop detection accepts Plasma's session names", () => {
  expect(isPlasmaDesktop(["KDE", undefined])).toBe(true);
  expect(isPlasmaDesktop([undefined, "plasma"])).toBe(true);
  expect(isPlasmaDesktop(["GNOME:KDE"])).toBe(true);
  expect(isPlasmaDesktop(["Hyprland", undefined])).toBe(false);
});

test("Plasma insertion requires an active unlocked Wayland session throughout the take", () => {
  expect(plasmaUnlocked(active, "(false,)", 0, 100)).toBe(true);
  expect(plasmaUnlocked(active.replace("Active=yes", "Active=no"), "(false,)", 0, 100)).toBe(false);
  expect(plasmaUnlocked(active, "(true,)", 0, 100)).toBe(false);
  expect(plasmaUnlocked(active, "(false,)", 100, 100)).toBe(false);
  expect(plasmaUnlocked(active, "(false,)", 101, 100)).toBe(false);
});

test("Plasma lock events invalidate an in-progress destination", () => {
  expect(plasmaLockEvent("org.freedesktop.ScreenSaver: AboutToLock ()")).toBe(true);
  expect(plasmaLockEvent("ActiveChanged (true,)")).toBe(true);
  expect(plasmaLockEvent("ActiveChanged (false,)")).toBe(false);
  expect(plasmaLockEvent("The name org.freedesktop.ScreenSaver does not have an owner")).toBe(true);
  expect(plasmaLockEvent("The name org.freedesktop.ScreenSaver is owned by :1.42")).toBe(false);
});

test("logind monitoring selects only the current session path", () => {
  expect(loginSessionPath('o "/org/freedesktop/login1/session/_32"\n')).toBe(
    "/org/freedesktop/login1/session/_32",
  );
  expect(() => loginSessionPath('o "/org/freedesktop/login1/session/_32\'"')).toThrow();
  expect(() => loginSessionPath('o "/org/freedesktop/login1/user/_1000"')).toThrow();
});
