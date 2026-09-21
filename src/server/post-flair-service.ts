import { reddit } from '@devvit/web/server';

export type MiniRacerPostType =
    | 'daily-race'
    | 'head-to-head'
    | 'daily-podium';

const POST_FLAIR_TEXT_BY_TYPE: Record<MiniRacerPostType, string> = {
    'daily-race': 'Daily',
    'head-to-head': 'Challenges',
    'daily-podium': 'Podiums',
};

function normalizeFlairText(value: string): string {
    return value.trim().toLowerCase();
}

export async function resolveMiniRacerPostFlairId(
    subredditName: string,
    postType: MiniRacerPostType,
): Promise<string> {
    const flairText = POST_FLAIR_TEXT_BY_TYPE[postType];
    const templates = await reddit.getPostFlairTemplates(subredditName);
    const template = templates.find((candidate) => (
        typeof candidate?.text === 'string'
        && normalizeFlairText(candidate.text) === normalizeFlairText(flairText)
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
