/**
 * Renders a race time as `m:ss.mmm` for anything Reddit-facing — podium posts
 * and brag comments both read from this so the two never drift apart.
 * Negative input is treated as zero rather than rendering a `-0:` prefix.
 */
export function formatRaceTime(bestTimeMs: number): string {
    const totalMilliseconds = Math.max(0, Math.round(bestTimeMs));
    const minutes = Math.floor(totalMilliseconds / 60_000);
    const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}
