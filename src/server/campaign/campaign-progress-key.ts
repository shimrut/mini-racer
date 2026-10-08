import { createHash } from 'node:crypto';
import { CAMPAIGN_NUMBERS_SERIES_ID, CAMPAIGN_SERIES } from '../../../game/campaign/manifest.js';

// One progress record per series and player; Numbers keeps its old key.
export function campaignProgressKey(
    playerId: string,
    seriesId: string = CAMPAIGN_NUMBERS_SERIES_ID,
): string {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `campaign:${seriesId}:progress:${playerHash}`;
}

export function campaignProgressKeys(playerId: string): string[] {
    return CAMPAIGN_SERIES.map((series) => campaignProgressKey(playerId, series.id));
}
