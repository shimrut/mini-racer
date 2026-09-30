import { trackLayoutHash } from './medal-times.js';

export const CREATOR_LAP_KEY = 'mini-racer:creator-completed-lap:v1';

export function clearCreatorLap(storage) {
    try { storage?.removeItem(CREATOR_LAP_KEY); } catch {}
}

export function completedCreatorLapSignature(storage, draft) {
    try {
        const lap = JSON.parse(storage?.getItem(CREATOR_LAP_KEY) || 'null');
        return lap?.signature === draft?.geometrySignature
            && lap?.layoutHash === trackLayoutHash(draft.track)
            && Number.isFinite(lap?.lapTimeSec) && lap.lapTimeSec > 0
            ? draft.geometrySignature : null;
    } catch {
        return null;
    }
}

export function recordCreatorLap(storage, draft, lapTimeSec) {
    if (!draft?.creatorSignature || !draft?.creatorLayoutHash
        || trackLayoutHash(draft.track) !== draft.creatorLayoutHash
        || !Number.isFinite(lapTimeSec) || lapTimeSec <= 0) {
        throw new Error('The driven layout no longer matches the saved draft.');
    }
    storage.setItem(CREATOR_LAP_KEY, JSON.stringify({
        signature: draft.creatorSignature,
        layoutHash: draft.creatorLayoutHash,
        lapTimeSec,
    }));
}
