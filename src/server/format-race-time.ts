export function formatRaceTime(bestTimeMs: number): string {
    const totalMilliseconds = Math.max(0, Math.round(bestTimeMs));
    const minutes = Math.floor(totalMilliseconds / 60_000);
    const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

export function formatHeadToHeadTime(timeMs: number): string {
    const seconds = Math.floor(timeMs / 1000);
    const milliseconds = timeMs % 1000;
    return `${seconds}.${String(milliseconds).padStart(3, '0')}`;
}

export function formatChallengeResultTime(timeMs: number): string {
    return `${(timeMs / 1000).toFixed(3)}s`;
}
