/**
 * @param {number | null | undefined} deltaSec positive = slower than best
 */
export function formatSplitTimeDeltaSec(deltaSec) {
    if (deltaSec === null || deltaSec === undefined || !Number.isFinite(deltaSec)) {
        return null;
    }
    const rounded = Math.round(deltaSec * 100) / 100;
    if (Math.abs(rounded) < 0.005) {
        return { text: '0.00', isGain: false, isLoss: false };
    }
    if (rounded < 0) {
        return { text: rounded.toFixed(2), isGain: true, isLoss: false };
    }
    return { text: `+${rounded.toFixed(2)}`, isGain: false, isLoss: true };
}
