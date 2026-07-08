export const SCOREBOARD_REPLAY_MAX_FRAMES = 12000;

export class ReplayRecorder {
  #maxFrames;
  #segments;
  #frameCount;
  #overflowed;

  constructor(maxFrames = SCOREBOARD_REPLAY_MAX_FRAMES) {
    this.#maxFrames = maxFrames;
    this.#segments = [];
    this.#frameCount = 0;
    this.#overflowed = false;
  }

  /** Clears all recorded data. Call at the start of each race. */
  reset() {
    this.#segments = [];
    this.#frameCount = 0;
    this.#overflowed = false;
  }

  record(left, right, relaunchDelay) {
    if (this.#overflowed) return;

    if (this.#frameCount >= this.#maxFrames) {
      this.#overflowed = true;
      return;
    }

    const lastSegment = this.#segments[this.#segments.length - 1];
    if (
      lastSegment &&
      lastSegment.left === left &&
      lastSegment.right === right &&
      lastSegment.relaunchDelay === relaunchDelay
    ) {
      lastSegment.frames += 1;
    } else {
      this.#segments.push({ frames: 1, left, right, relaunchDelay });
    }

    this.#frameCount += 1;
  }

  getPayload(targetLapNumber = 1) {
    if (this.#overflowed || this.#frameCount <= 0) return null;
    return {
      targetLapNumber,
      inputs: this.#segments.map((segment) => ({ ...segment })),
    };
  }

  /** Total number of ticks recorded (not number of segments). */
  get frameCount() {
    return this.#frameCount;
  }

  /** True if the buffer exceeded its capacity and the replay was discarded. */
  get overflowed() {
    return this.#overflowed;
  }
}
