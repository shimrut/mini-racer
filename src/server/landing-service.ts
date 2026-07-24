import { reddit } from '@devvit/web/server';
import type { DailyGpChallenge } from './daily-gp-model.js';
import { ensureDailyMiniRacerPostForSubreddit } from './daily-post-service.js';
import {
    acquireCampaignHubPostCreationLock,
    acquireLandingPostCreationLock,
    CAMPAIGN_HUB_POST_TYPE,
    LANDING_POST_TYPE,
    readCampaignHubPostRecord,
    readLandingPostRecord,
    releaseCampaignHubPostCreationLock,
    releaseLandingPostCreationLock,
    writeCampaignHubPostRecord,
    writeLandingPostRecord,
    type HubPostRecord,
} from './landing-post-store.js';
import { getRequestAppSlug } from './request-context.js';
import { resolveDailyShareImageUrl } from './share-image.js';

export type LandingDestinations = {
    dailyPostUrl: string | null;
    campaignPostUrl: string | null;
};

export type LandingPostResult = {
    created: boolean;
    postUrl: string | null;
    destinations: LandingDestinations;
};

const LANDING_SHARE_TRACK_KEY = 'titanTrack';

function requireAppSlug(): string {
    const appSlug = getRequestAppSlug();
    if (!appSlug) {
        throw new Error('Reddit did not provide the Mini Racer app identity.');
    }
    return appSlug;
}

function shareImageStyles() {
    const shareImageUrl = resolveDailyShareImageUrl(LANDING_SHARE_TRACK_KEY);
    return shareImageUrl ? { styles: { shareImageUrl } } : {};
}

async function submitCampaignHubPost(subredditName: string) {
    const post = await reddit.submitCustomPost({
        subredditName,
        title: 'Mini Racer Campaign',
        entry: 'campaign',
        postData: {
            postType: CAMPAIGN_HUB_POST_TYPE,
        },
        textFallback: {
            text: [
                '# Mini Racer Campaign',
                '',
                'Play the permanent Mini Racer Campaign — ten fixed stages, medals, and standings.',
                '',
                'Open this post on Reddit and select **Race Campaign** to play.',
            ].join('\n'),
        },
        ...shareImageStyles(),
    });
    if (typeof post.id !== 'string' || !post.id.startsWith('t3_') || typeof post.url !== 'string') {
        throw new Error('Reddit did not return the campaign post identity.');
    }
    return post;
}

async function submitLandingPost(subredditName: string) {
    const post = await reddit.submitCustomPost({
        subredditName,
        title: 'Mini Racer',
        entry: 'landing',
        postData: {
            postType: LANDING_POST_TYPE,
        },
        textFallback: {
            text: [
                '# Mini Racer',
                '',
                'Choose **Daily** for today\'s featured race, or **Campaign** for the permanent ten-stage series.',
                '',
                'Open this post on Reddit to pick a mode.',
            ].join('\n'),
        },
        ...shareImageStyles(),
    });
    if (typeof post.id !== 'string' || !post.id.startsWith('t3_') || typeof post.url !== 'string') {
        throw new Error('Reddit did not return the landing post identity.');
    }
    return post;
}

function toRecord(
    subredditName: string,
    post: { id: string; url: string },
    createdAt = new Date().toISOString(),
): HubPostRecord {
    return {
        subredditName,
        postId: post.id as `t3_${string}`,
        postUrl: post.url,
        createdAt,
    };
}

export async function ensureCampaignHubPostForSubreddit(
    subredditName: string,
): Promise<{ created: boolean; postUrl: string }> {
    requireAppSlug();
    const existing = await readCampaignHubPostRecord(subredditName);
    if (existing) {
        await writeCampaignHubPostRecord(existing);
        return { created: false, postUrl: existing.postUrl };
    }

    const lock = await acquireCampaignHubPostCreationLock(subredditName);
    if (!lock) {
        const raced = await readCampaignHubPostRecord(subredditName);
        if (raced) return { created: false, postUrl: raced.postUrl };
        throw new Error('The Mini Racer campaign post is already being created.');
    }
    try {
        const raced = await readCampaignHubPostRecord(subredditName);
        if (raced) return { created: false, postUrl: raced.postUrl };
        const post = await submitCampaignHubPost(subredditName);
        await writeCampaignHubPostRecord(toRecord(subredditName, post));
        return { created: true, postUrl: post.url };
    } finally {
        await releaseCampaignHubPostCreationLock(lock);
    }
}

export async function ensureLandingPostForSubreddit(
    subredditName: string,
): Promise<{ created: boolean; postUrl: string }> {
    requireAppSlug();
    const existing = await readLandingPostRecord(subredditName);
    if (existing) {
        await writeLandingPostRecord(existing);
        return { created: false, postUrl: existing.postUrl };
    }

    const lock = await acquireLandingPostCreationLock(subredditName);
    if (!lock) {
        const raced = await readLandingPostRecord(subredditName);
        if (raced) return { created: false, postUrl: raced.postUrl };
        throw new Error('The Mini Racer landing post is already being created.');
    }
    try {
        const raced = await readLandingPostRecord(subredditName);
        if (raced) return { created: false, postUrl: raced.postUrl };
        const post = await submitLandingPost(subredditName);
        await writeLandingPostRecord(toRecord(subredditName, post));
        return { created: true, postUrl: post.url };
    } finally {
        await releaseLandingPostCreationLock(lock);
    }
}

export async function getLandingDestinations(
    subredditName: string,
    challenge: DailyGpChallenge,
): Promise<LandingDestinations> {
    const [daily, campaign] = await Promise.all([
        ensureDailyMiniRacerPostForSubreddit(subredditName, challenge),
        ensureCampaignHubPostForSubreddit(subredditName),
    ]);
    return {
        dailyPostUrl: daily.postUrl,
        campaignPostUrl: campaign.postUrl,
    };
}

export async function ensureLandingBundleForSubreddit(
    subredditName: string,
    challenge: DailyGpChallenge,
): Promise<LandingPostResult> {
    const destinations = await getLandingDestinations(subredditName, challenge);
    const landing = await ensureLandingPostForSubreddit(subredditName);
    return {
        created: landing.created,
        postUrl: landing.postUrl,
        destinations,
    };
}
