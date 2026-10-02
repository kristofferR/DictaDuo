/** Two taps within this window toggle recording; a press held longer is not a tap. */
export const doubleTapWindowMS = 450;

/** CLOCK_MONOTONIC milliseconds, immune to wall-clock corrections and shared with the GUI bridge. */
export const monotonicMS = () => Number(process.hrtime.bigint()) / 1e6;

/** A bridge timestamp from the same monotonic clock, or now if it is missing or implausible. */
export function edgeTime(value: unknown, now = monotonicMS()) {
  return typeof value === "number" && value <= now + 1000 && value >= now - 10_000 ? value : now;
}

/**
 * Turns shortcut press/release edges into double taps. A lone tap does
 * nothing, and a hold breaks the pair. The compositor only reports this
 * key, so unrelated typing between taps cannot be seen here.
 */
export class DoubleTap {
  private pressedAt?: number;
  private lastTapAt?: number;

  constructor(private readonly now = monotonicMS) {}

  press(at = this.now()) {
    this.pressedAt ??= at;
  }

  /** True when this release completes a double tap. */
  release(now = this.now()) {
    const pressedAt = this.pressedAt;
    this.pressedAt = undefined;
    if (pressedAt === undefined || now - pressedAt > doubleTapWindowMS) {
      this.lastTapAt = undefined;
      return false;
    }
    if (this.lastTapAt !== undefined && now - this.lastTapAt <= doubleTapWindowMS) {
      this.lastTapAt = undefined;
      return true;
    }
    this.lastTapAt = now;
    return false;
  }

  reset() {
    this.pressedAt = this.lastTapAt = undefined;
  }
}
