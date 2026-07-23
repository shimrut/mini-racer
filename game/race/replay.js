export const SCOREBOARD_REPLAY_MAX_FRAMES = 3000;
export const SCOREBOARD_REPLAY_FRAMES_PER_LAP = 2500;

export function getScoreboardReplayMaxFrames({
  rulesRevision = 0,
  lapCount = 1,
} = {}) {
  if (!Number.isInteger(rulesRevision) || rulesRevision < 1) {
    return SCOREBOARD_REPLAY_MAX_FRAMES;
  }
  const safeLapCount = Number.isInteger(lapCount)
    ? Math.min(Math.max(lapCount, 1), 3)
    : 1;
  return SCOREBOARD_REPLAY_FRAMES_PER_LAP * safeLapCount;
}

export class ReplayRecorder {
  #maxFrames;
  #targetLapNumber;
  #rulesRevision;
  #segments;
  #frameCount;
  #overflowed;

  constructor(maxFrames = SCOREBOARD_REPLAY_MAX_FRAMES) {
    this.#maxFrames = maxFrames;
    this.#targetLapNumber = 1;
    this.#rulesRevision = null;
    this.#segments = [];
    this.#frameCount = 0;
    this.#overflowed = false;
  }

  /** Clears all recorded data. Call at the start of each race. */
  reset({
    maxFrames = this.#maxFrames,
    targetLapNumber = this.#targetLapNumber,
    rulesRevision = this.#rulesRevision,
  } = {}) {
    this.#maxFrames = Number.isInteger(maxFrames) && maxFrames >= 0
      ? maxFrames
      : SCOREBOARD_REPLAY_MAX_FRAMES;
    this.#targetLapNumber = Number.isInteger(targetLapNumber) && targetLapNumber > 0
      ? targetLapNumber
      : 1;
    this.#rulesRevision = Number.isInteger(rulesRevision) && rulesRevision >= 0
      ? rulesRevision
      : null;
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

  getPayload(targetLapNumber = this.#targetLapNumber) {
    if (this.#overflowed || this.#frameCount <= 0) return null;
    const resolvedTargetLapNumber = this.#rulesRevision === null
      ? targetLapNumber
      : this.#targetLapNumber;
    return {
      ...(this.#rulesRevision === null ? {} : { rulesRevision: this.#rulesRevision }),
      targetLapNumber: resolvedTargetLapNumber,
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
