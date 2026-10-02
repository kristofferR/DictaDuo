/** Display data only. Capture ownership and delivery stay with the controller. */
export class RecordingFeedback {
  private levels: number[] = [];
  private levelAt = -Infinity;
  private recordingAt?: number;
  private stoppedAt?: number;
  private partialText = "";
  private streamAvailable: boolean | null = null;
  private processingStage?: string;

  begin(now = Date.now()) {
    this.recordingAt = now;
  }
  update(
    peak: number | undefined,
    partialText: string | undefined,
    stage: string,
    now = Date.now(),
  ) {
    this.streamAvailable = true;
    this.partialText = partialText ?? "";
    this.processingStage = stage;
    if (this.stoppedAt !== undefined || peak === undefined || !Number.isFinite(peak)) return;
    this.levels = [...this.levels.slice(-8), Math.max(0, Math.min(1, peak))];
    this.levelAt = now;
  }
  unavailable() {
    this.streamAvailable = false;
    this.levels = [];
    this.partialText = "";
    this.processingStage = undefined;
  }
  finish(now = Date.now()) {
    this.stoppedAt ??= now;
    this.levels = [];
  }
  snapshot(now = Date.now()) {
    const recording = this.recordingAt !== undefined && this.stoppedAt === undefined;
    return {
      levels: recording && this.streamAvailable && now - this.levelAt < 1500 ? this.levels : [],
      elapsedSeconds:
        this.recordingAt === undefined
          ? 0
          : Math.max(0, Math.floor(((this.stoppedAt ?? now) - this.recordingAt) / 1000)),
      partialText: this.partialText,
      streamAvailable: this.streamAvailable,
      processingStage: this.processingStage,
    };
  }
}
