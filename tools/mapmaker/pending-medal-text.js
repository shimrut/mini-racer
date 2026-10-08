// Typed medal text per track and medal that survives repaints, refreshes and track switches until committed.

export function setPendingMedalText(pendingByKey, trackKey, tier, text) {
    const pending = pendingByKey.get(trackKey) ?? new Map();
    pending.set(tier, String(text));
    pendingByKey.set(trackKey, pending);
}

export function readPendingMedalText(pendingByKey, trackKey, tier) {
    return pendingByKey.get(trackKey)?.get(tier);
}

export function hasPendingMedalText(pendingByKey, trackKey) {
    return Boolean(pendingByKey?.get(trackKey)?.size);
}

export function clearPendingMedalText(pendingByKey, trackKey, tiers = null) {
    const pending = pendingByKey.get(trackKey);
    if (!pending) return;
    if (tiers) tiers.forEach((tier) => pending.delete(tier));
    if (!tiers || !pending.size) pendingByKey.delete(trackKey);
}

export function movePendingMedalText(pendingByKey, fromKey, toKey) {
    const pending = pendingByKey.get(fromKey);
    pendingByKey.delete(fromKey);
    if (pending?.size) pendingByKey.set(toKey, pending);
}

export function copyPendingMedalText(pendingByKey, trackKey) {
    const pending = pendingByKey.get(trackKey);
    return pending?.size ? new Map(pending) : null;
}

// The text a medal field shows: the typed text, else the medal time.
export function medalFieldText(pendingText, modelValue) {
    if (pendingText !== undefined) return pendingText;
    const value = Number(modelValue);
    return Number.isFinite(value) && value > 0 ? value.toFixed(2) : '';
}
