/**
 * Renders a lap count as a carousel meta label ("1 Lap" / "3 Laps").
 * A missing or nonsensical count reads as a single lap rather than
 * printing "undefined Laps" onto a card.
 * @param {unknown} laps
 * @returns {string}
 */
export function formatLapsLabel(laps) {
    const safeLaps = Number.isInteger(laps) && laps > 0 ? laps : 1;
    return `${safeLaps} ${safeLaps === 1 ? 'Lap' : 'Laps'}`;
}
