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
        return `https://i.redd.it/${url}`;
    } catch {
        return null;
    }
}
