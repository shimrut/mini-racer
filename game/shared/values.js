export function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function finiteNumberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function getChallengeTimeMs(challenge, field) {
    const value = challenge?.[field];
    if (typeof value !== 'string') return NaN;
    return Date.parse(value);
}
