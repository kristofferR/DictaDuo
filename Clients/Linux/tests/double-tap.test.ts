import { expect, test } from "bun:test";
import { DoubleTap, doubleTapWindowMS } from "../src/double-tap.ts";

function taps() {
  let now = 0;
  const detector = new DoubleTap(() => now);
  const tap = (pressAt: number, releaseAt = pressAt + 80) => {
    now = pressAt;
    detector.press();
    now = releaseAt;
    return detector.release();
  };
  return { detector, tap };
}

test("two quick taps toggle; a lone tap does nothing", () => {
  const { tap } = taps();
  expect(tap(0)).toBe(false);
  expect(tap(200)).toBe(true);
  // A completed double tap starts a fresh pair.
  expect(tap(400)).toBe(false);
  expect(tap(600)).toBe(true);
});

test("a slow second tap starts a new pair instead of toggling", () => {
  const { tap } = taps();
  expect(tap(0)).toBe(false);
  expect(tap(80 + doubleTapWindowMS + 1)).toBe(false);
  expect(tap(800)).toBe(true);
});

test("a hold is not a tap and breaks a pending pair", () => {
  const { tap, detector } = taps();
  expect(tap(0)).toBe(false);
  expect(tap(200, 200 + doubleTapWindowMS + 1)).toBe(false);
  expect(tap(900)).toBe(false);
  detector.reset();
  expect(tap(1000)).toBe(false);
  expect(tap(1200)).toBe(true);
});
