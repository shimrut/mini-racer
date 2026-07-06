const MAX_CHECKPOINT_SPLITS = 32;

/**
 * @param {number} bestTimeSec
 * @param {unknown} raw
 * @returns {number[] | null}
 */
export function normalizeCheckpointTimesSec(bestTimeSec, raw) {
    if (raw == null) {
        return null;
    }
    if (!Array.isArray(raw)) {
        return null;
    }
    if (!Number.isFinite(bestTimeSec) || bestTimeSec <= 0) {
        return null;
    }

    const splits = [];
    for (const item of raw) {
        if (!Number.isFinite(item)) {
            return null;
        }
        const sec = Number(item);
        if (sec < 0 || sec > bestTimeSec) {
            return null;
        }
        if (splits.length > 0 && sec < splits[splits.length - 1]) {
            return null;
        }
        splits.push(sec);
    }

    if (splits.length > MAX_CHECKPOINT_SPLITS) {
        return null;
    }

    return splits.length ? splits : null;
}
