export function formatLapsLabel(laps) {
    const safeLaps = Number.isInteger(laps) && laps > 0 ? laps : 1;
    return `${safeLaps} ${safeLaps === 1 ? 'Lap' : 'Laps'}`;
}

export function formatLapsAndGroundLabel(laps, groundLabel, separator = ' · ') {
    return [formatLapsLabel(laps), groundLabel].filter(Boolean).join(separator);
}
