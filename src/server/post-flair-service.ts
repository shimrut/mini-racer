import { reddit } from '@devvit/web/server';
import { normalizeName } from './value-guards.js';

export type MiniRacerPostType =
    | 'daily-race'
    | 'head-to-head'
    | 'daily-podium';

const POST_FLAIR_TEXT_BY_TYPE: Record<MiniRacerPostType, string> = {
    'daily-race': 'Daily',
    'head-to-head': 'Challenge',
    'daily-podium': 'Podiums',
};

export async function resolveMiniRacerPostFlairId(
    subredditName: string,
    postType: MiniRacerPostType,
): Promise<string> {
    const flairText = POST_FLAIR_TEXT_BY_TYPE[postType];
    const templates = await reddit.getPostFlairTemplates(subredditName);
    const template = templates.find((candidate) => (
        typeof candidate?.text === 'string'
        && normalizeName(candidate.text) === normalizeName(flairText)
    ));
    const flairId = template?.id;

    if (typeof flairId !== 'string' || !flairId) {
        throw new Error(
            `Mini Racer requires the "${flairText}" post flair template in r/${subredditName} `
            + `before it can create a ${postType} post.`,
        );
    }

    return flairId;
}
