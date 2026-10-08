// Medal rules shared by the Mapmaker and the server, so both refuse the same rows.

export const MEDAL_TIERS = Object.freeze(['author', 'gold', 'silver', 'bronze']);

function roundCentiseconds(value) {
    return Math.round(value * 100) / 100;
}

export function normalizeMedalRow(row) {
    if (!row || typeof row !== 'object') return null;
    const values = {};
    for (const tier of MEDAL_TIERS) {
        const value = Number(row[tier]);
        if (!Number.isFinite(value) || value <= 0) return null;
        values[tier] = roundCentiseconds(value);
    }
    return values;
}

// Returns an error text, or null when all four times are set and in order.
export function getMedalRowError(row) {
    const values = normalizeMedalRow(row);
    if (!values) return 'Set all four medal times.';
    if (!(values.author < values.gold && values.gold < values.silver && values.silver < values.bronze)) {
        return 'Medal times must go up: author, then gold, then silver, then bronze.';
    }
    return null;
}

export function sameMedalRow(first, second) {
    const a = normalizeMedalRow(first);
    const b = normalizeMedalRow(second);
    if (!a || !b) return a === b;
    return MEDAL_TIERS.every((tier) => a[tier] === b[tier]);
}
