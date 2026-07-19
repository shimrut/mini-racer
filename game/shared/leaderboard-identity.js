export const LEADERBOARD_IDENTITY_CONSTRUCTED = 'constructed';
export const LEADERBOARD_IDENTITY_REDDIT = 'reddit';

export const LEADERBOARD_NAME_ADJECTIVES = [
    'Arctic', 'Blazing', 'Crimson', 'Electric', 'Flying', 'Golden', 'Hidden', 'Iron',
    'Jade', 'Lucky', 'Midnight', 'Neon', 'Phantom', 'Quantum', 'Rapid', 'Rocket',
    'Shadow', 'Silver', 'Turbo', 'Velvet', 'Wild', 'Winter', 'Zenith', 'Zero'
];

export const LEADERBOARD_NAME_NOUNS = [
    'Badger', 'Cobra', 'Falcon', 'Gecko', 'Jaguar', 'Koala', 'Lynx', 'Manta',
    'Mustang', 'Orca', 'Otter', 'Panther', 'Pigeon', 'Raven', 'Shark', 'Sparrow',
    'Tiger', 'Viper', 'Wolf', 'Wombat', 'Yak', 'Zebra', 'Comet', 'Meteor'
];

export function hashLeaderboardPlayerId(playerId) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < playerId.length; index += 1) {
        hash ^= playerId.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function normalizeLeaderboardIdentityPreference(value) {
    return value === LEADERBOARD_IDENTITY_REDDIT
        ? LEADERBOARD_IDENTITY_REDDIT
        : LEADERBOARD_IDENTITY_CONSTRUCTED;
}

export function sanitizeRedditUsername(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/^u\//i, '');
    return trimmed ? trimmed : null;
}

export function getConstructedLeaderboardName(playerId) {
    if (typeof playerId !== 'string' || !playerId) return 'Anonymous Racer';

    const hash = hashLeaderboardPlayerId(playerId);
    const adjective = LEADERBOARD_NAME_ADJECTIVES[hash % LEADERBOARD_NAME_ADJECTIVES.length];
    const noun = LEADERBOARD_NAME_NOUNS[Math.floor(hash / LEADERBOARD_NAME_ADJECTIVES.length) % LEADERBOARD_NAME_NOUNS.length];
    const suffixSeed = hash >>> 16;
    const suffix = suffixSeed % 4 === 0 ? '' : ` ${2 + (suffixSeed % 98)}`;
    return `${adjective} ${noun}${suffix}`;
}

export function resolveLeaderboardDisplayName({
    playerId,
    preference = LEADERBOARD_IDENTITY_CONSTRUCTED,
    redditUsername = null,
} = {}) {
    const normalizedPreference = normalizeLeaderboardIdentityPreference(preference);
    const safeUsername = sanitizeRedditUsername(redditUsername);

    if (normalizedPreference === LEADERBOARD_IDENTITY_REDDIT && safeUsername) {
        return safeUsername;
    }

    return getConstructedLeaderboardName(playerId);
}
