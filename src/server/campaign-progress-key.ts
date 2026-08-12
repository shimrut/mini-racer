import { createHash } from 'node:crypto';
import { CAMPAIGN_ID } from '../../game/campaign/manifest.js';

/** Shared so identity checks can look for leftover guest progress without importing the Campaign store. */
export function campaignProgressKey(playerId: string): string {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `campaign:${CAMPAIGN_ID}:progress:${playerHash}`;
}
