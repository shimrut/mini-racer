/**
 * Lap time (seconds) for the leaderboard row one place above the current player.
 * Ranks are 1-based; rank 1 is fastest. No row above rank 1 → null.
 *
 * @param {{
 *   playerRank?: number | null,
 *   topRows?: Array<{ rank?: number, bestTime?: number }>,
 *   nearbyRows?: Array<{ rank?: number, bestTime?: number }>,
 * }} snapshot
 * @returns {number | null}
 */
export function getBestTimeOneRankAbove(snapshot) {
    if (!snapshot || !Number.isFinite(snapshot.playerRank)) return null;
    const playerRank = Math.trunc(Number(snapshot.playerRank));
    if (playerRank <= 1) return null;
    const targetRank = playerRank - 1;
    const rows = [
        ...(Array.isArray(snapshot.topRows) ? snapshot.topRows : []),
        ...(Array.isArray(snapshot.nearbyRows) ? snapshot.nearbyRows : []),
    ];
    for (const row of rows) {
        if (!row || !Number.isFinite(row.rank)) continue;
        if (Math.trunc(row.rank) !== targetRank) continue;
        const t = row.bestTime;
        if (Number.isFinite(t)) return t;
    }
    return null;
}
