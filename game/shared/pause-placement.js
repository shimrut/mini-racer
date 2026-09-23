export const PAUSE_PLACEMENT_SEPARATE = 'separate';
export const PAUSE_PLACEMENT_TIMER = 'timer';
export const PAUSE_PLACEMENT_SPEEDO = 'speedo';
export const DEFAULT_PAUSE_PLACEMENT = PAUSE_PLACEMENT_TIMER;

const PAUSE_PLACEMENTS = new Set([
    PAUSE_PLACEMENT_SEPARATE,
    PAUSE_PLACEMENT_TIMER,
    PAUSE_PLACEMENT_SPEEDO,
]);

export function normalizePausePlacement(value) {
    return PAUSE_PLACEMENTS.has(value) ? value : null;
}
