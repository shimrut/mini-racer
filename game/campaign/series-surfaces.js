import { TRACK_GROUNDS, isTrackGroundKey } from '../track/grounds.js';

// Surfaces are display data only; the track definition decides driving.
export function getCampaignSeriesGrounds(series, readTrackGround = null) {
    const stages = Array.isArray(series?.stages) ? series.stages : [];
    let grounds;
    if (typeof readTrackGround === 'function' && stages.length) {
        grounds = stages.map((stage) => readTrackGround(stage.trackKey));
    } else if (Array.isArray(series?.grounds)) {
        grounds = series.grounds;
    } else {
        // Old records were homogeneous; empty series retain their preview theme.
        grounds = [series?.ground ?? 'tarmac'];
    }
    if (!grounds.length || grounds.some((ground) => !isTrackGroundKey(ground))) return [];
    return [...new Set(grounds)];
}

export function getCampaignSeriesSurfaceLabel(series, readTrackGround = null) {
    const grounds = getCampaignSeriesGrounds(series, readTrackGround);
    if (grounds.length > 1) return 'Mixed';
    return TRACK_GROUNDS[grounds[0]]?.label ?? '—';
}
