import { createHash } from 'node:crypto';
import { CAMPAIGN_NUMBERS_SERIES_ID, CAMPAIGN_SERIES } from '../../../game/campaign/manifest.js';

// One progress record for each series and player. The Numbers key keeps its
// old form, because the series name of Numbers is the old Campaign name.
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
