import { TRACK_GROUNDS, isTrackGroundKey } from '../track/grounds.js';

// Series surfaces are presentation metadata: they never decide whether a series
// is live. The track definition remains the authority for driving. Stored
// summaries describe published stages.
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
