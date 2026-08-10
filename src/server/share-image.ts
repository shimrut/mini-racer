import { getDevvitConfig } from '@devvit/shared-types/server/get-devvit-config.js';

export function getShareImageAssetPath(trackKey: string): string {
    return `share/${trackKey}.jpg`;
}

export function resolveDailyShareImageUrl(trackKey: string): string | null {
    if (typeof trackKey !== 'string' || !trackKey.trim()) {
        return null;
    }

    try {
        const assets = getDevvitConfig().assets;
        const url = assets?.[getShareImageAssetPath(trackKey)];
        if (typeof url !== 'string' || !url) {
            return null;
        }
        if (/^https?:\/\//i.test(url)) {
            return url;
        }
        // Asset map may store a media id; Media Service URLs use i.redd.it.
        return `https://i.redd.it/${url}`;
    } catch {
        return null;
    }
}
