const REDDIT_AVATAR_HOSTS = [
    'redd.it',
    'redditmedia.com',
    'redditstatic.com',
];

export function isRedditAvatarUrl(value) {
    if (typeof value !== 'string') return false;
    try {
        const { protocol, hostname } = new URL(value);
        if (protocol !== 'https:') return false;
        return REDDIT_AVATAR_HOSTS.some(
            (host) => hostname === host || hostname.endsWith(`.${host}`),
        );
    } catch {
        return false;
    }
}
