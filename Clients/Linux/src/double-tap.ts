/** Two taps within this window toggle recording; a press held longer is not a tap. */
export const doubleTapWindowMS = 450;

/**
 * Turns shortcut press/release edges into double taps. A lone tap does
 * nothing, and a hold breaks the pair. The compositor only reports this
 * key, so unrelated typing between taps cannot be seen here.
 */
export class DoubleTap {
  private pressedAt?: number;
  private lastTapAt?: number;

  constructor(private readonly now = () => Date.now()) {}

  press() {
    this.pressedAt ??= this.now();
  }

  /** True when this release completes a double tap. */
  release() {
    const pressedAt = this.pressedAt;
    this.pressedAt = undefined;
    const now = this.now();
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
