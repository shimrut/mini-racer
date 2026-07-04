export const PUBLISHED_DAILY_GP_TRACKS_BY_DATE = Object.freeze({
    '2026-06-02': 'albertGardens',
    '2026-06-03': 'mistwoodSerpent',
    '2026-06-04': 'ardennesRidge',
    '2026-06-05': 'sunlitTemple',
    '2026-06-06': 'harborPrincipality',
    '2026-06-07': 'turboShell',
    '2026-06-08': 'desertBridge',
    '2026-06-09': 'circuitPromax',
    '2026-06-10': 'caspianBoulevard',
    '2026-06-11': 'lanternPier',
});

export function getBackfilledDailyGpTrackKeyForDate(challengeDate) {
    return PUBLISHED_DAILY_GP_TRACKS_BY_DATE[challengeDate] || null;
}
