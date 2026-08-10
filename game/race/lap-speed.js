export function formatSplitTimeDeltaSec(deltaSec) {
    if (deltaSec === null || deltaSec === undefined || !Number.isFinite(deltaSec)) {
        return null;
    }
    const rounded = Math.round(deltaSec * 1000) / 1000;
    if (Math.abs(rounded) < 0.0005) {
        return { text: '0.000', isGain: false, isLoss: false };
    }
    if (rounded < 0) {
        return { text: rounded.toFixed(3), isGain: true, isLoss: false };
    }
    return { text: `+${rounded.toFixed(3)}`, isGain: false, isLoss: true };
}
