const LAP_FINISH_TOLERANCE_SEC = 0.002;

/**
 * Normalizes cumulative lap-completion timestamps for one verified race.
 *
 * The last boundary is the race finish, so it must agree with the canonical
 * finish time. Old PB records may omit this field entirely.
 */
export function normalizeLapCompletionTimesSec(finishTimeSec, raw, lapCount) {
  const expectedLapCount = Math.trunc(Number(lapCount));
  if (
    !Array.isArray(raw)
    || !Number.isFinite(finishTimeSec)
    || finishTimeSec <= 0
    || !Number.isInteger(expectedLapCount)
    || expectedLapCount < 1
    || raw.length !== expectedLapCount
  ) {
    return null;
  }

  const times = raw.map(Number);
  if (
    times.some((time) => !Number.isFinite(time) || time <= 0 || time > finishTimeSec + LAP_FINISH_TOLERANCE_SEC)
    || times.some((time, index) => index > 0 && time <= times[index - 1])
    || Math.abs(times[times.length - 1] - finishTimeSec) > LAP_FINISH_TOLERANCE_SEC
  ) {
    return null;
  }

  times[times.length - 1] = finishTimeSec;
  return times;
}
