export const PLAYER_TRAIL_STORAGE_KEY = 'MiniRacerPlayerTrail';

/** Trail paint for the route line behind the car (canvas strokeStyle). */
export const PLAYER_TRAIL_COLORS = Object.freeze([
    Object.freeze({ id: 'none', label: 'No Trail', strokeStyle: 'rgba(15, 23, 42, 0)', swatch: '#0f172a' }),
    Object.freeze({ id: 'sky', label: 'Sky', strokeStyle: 'rgba(56, 189, 248, 0.5)', swatch: '#38bdf8' }),
    Object.freeze({ id: 'cyan', label: 'Cyan', strokeStyle: 'rgba(34, 211, 238, 0.5)', swatch: '#22d3ee' }),
    Object.freeze({ id: 'lime', label: 'Lime', strokeStyle: 'rgba(163, 230, 53, 0.5)', swatch: '#a3e635' }),
    Object.freeze({ id: 'gold', label: 'Gold', strokeStyle: 'rgba(250, 204, 21, 0.5)', swatch: '#facc15' }),
    Object.freeze({ id: 'coral', label: 'Coral', strokeStyle: 'rgba(251, 113, 133, 0.5)', swatch: '#fb7185' }),
    Object.freeze({ id: 'violet', label: 'Violet', strokeStyle: 'rgba(167, 139, 250, 0.5)', swatch: '#a78bfa' }),
    Object.freeze({ id: 'white', label: 'White', strokeStyle: 'rgba(248, 250, 252, 0.55)', swatch: '#f8fafc' })
]);

const DEFAULT_TRAIL_ID = 'sky';

const BY_ID = new Map(PLAYER_TRAIL_COLORS.map((entry) => [entry.id, entry]));

export function trailStrokeStyleForId(id) {
    if (id === 'none') return null;
    return BY_ID.get(id)?.strokeStyle ?? BY_ID.get(DEFAULT_TRAIL_ID).strokeStyle;
}

export function readPlayerTrailId() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return DEFAULT_TRAIL_ID;
    }
    try {
        const raw = window.localStorage.getItem(PLAYER_TRAIL_STORAGE_KEY);
        if (!raw) return DEFAULT_TRAIL_ID;
        const parsed = JSON.parse(raw);
        const id = typeof parsed === 'string' ? parsed.trim() : '';
        if (id && BY_ID.has(id)) return id;
    } catch (error) {
        console.error('Error reading player trail color:', error);
    }
    return DEFAULT_TRAIL_ID;
}

export function readPlayerTrailStrokeStyle() {
    return trailStrokeStyleForId(readPlayerTrailId());
}

export function writePlayerTrailId(id) {
    const next = BY_ID.has(id) ? id : DEFAULT_TRAIL_ID;
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            window.localStorage.setItem(PLAYER_TRAIL_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
            console.error('Error saving player trail color:', error);
        }
    }
    return next;
}
