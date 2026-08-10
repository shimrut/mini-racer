import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    DAILY_GP_GUEST_PROFILE_TTL_SECONDS,
    DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS,
    type DailyGpPlayerPreferences,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { mintGuestPlayerToken, verifyGuestPlayerToken } from './player-token.js';
import { STOCK_CAR_ASSET_NAME } from '../../game/car/car-unlock-policy.js';
import {
    normalizeLeaderboardIdentityPreference,
    sanitizeRedditUsername,
} from '../../game/shared/leaderboard-identity.js';

export type ResolvedPlayerIdentity = {
    canonicalPlayerId: string | null;
    guestPlayerId: string | null;
    guestToken: string | null;
};

const MAX_CAR_SKIN_LENGTH = 160;
const MAX_TRAIL_ID_LENGTH = 32;
const MAX_CRASH_RESTART_DELAY_SEC = 1;

const DEFAULT_PLAYER_PREFERENCES: DailyGpPlayerPreferences = {
    carSkin: STOCK_CAR_ASSET_NAME,
    trailId: 'sky',
    musicEnabled: true,
    carAudioEnabled: true,
    crashAutoRestartEnabled: false,
    crashRestartDelaySec: 0.5,
    pbGhostEnabled: true,
};

function readCarSkinPreference(value: unknown): string | null {
    const carSkin = typeof value === 'string' ? value.trim() : '';
    return carSkin && carSkin.length <= MAX_CAR_SKIN_LENGTH ? carSkin : null;
}

function readTrailIdPreference(value: unknown): string | null {
    const trailId = typeof value === 'string' ? value.trim() : '';
    return trailId && trailId.length <= MAX_TRAIL_ID_LENGTH ? trailId : null;
}

function readBooleanPreference(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function readCrashRestartDelaySecPreference(value: unknown): number | null {
    const crashRestartDelaySec = Number(value);
    if (
        !Number.isFinite(crashRestartDelaySec)
        || crashRestartDelaySec < 0
        || crashRestartDelaySec > MAX_CRASH_RESTART_DELAY_SEC
    ) {
        return null;
    }
    return Math.round(crashRestartDelaySec * 10) / 10;
}

function readPbGhostEnabledPreference(value: unknown): boolean | null {
    if (value === undefined) return DEFAULT_PLAYER_PREFERENCES.pbGhostEnabled;
    return readBooleanPreference(value);
}

function readPlayerPreferenceFields(value: unknown): {
    carSkin: string | null;
    trailId: string | null;
    musicEnabled: boolean | null;
    carAudioEnabled: boolean | null;
    crashAutoRestartEnabled: boolean | null;
    crashRestartDelaySec: number | null;
    pbGhostEnabled: boolean | null;
} | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const preferences = value as Record<string, unknown>;
    return {
        carSkin: readCarSkinPreference(preferences.carSkin),
        trailId: readTrailIdPreference(preferences.trailId),
        musicEnabled: readBooleanPreference(preferences.musicEnabled),
        carAudioEnabled: readBooleanPreference(preferences.carAudioEnabled),
        crashAutoRestartEnabled: readBooleanPreference(preferences.crashAutoRestartEnabled),
        crashRestartDelaySec: readCrashRestartDelaySecPreference(preferences.crashRestartDelaySec),
        pbGhostEnabled: readPbGhostEnabledPreference(preferences.pbGhostEnabled),
    };
}

export function normalizePlayerPreferences(value: unknown): DailyGpPlayerPreferences | null {
    const fields = readPlayerPreferenceFields(value);
    if (!fields) return null;

    const {
        carSkin,
        trailId,
        musicEnabled,
        carAudioEnabled,
        crashAutoRestartEnabled,
        crashRestartDelaySec,
        pbGhostEnabled,
    } = fields;
    if (
        carSkin === null
        || trailId === null
        || musicEnabled === null
        || carAudioEnabled === null
        || crashAutoRestartEnabled === null
        || crashRestartDelaySec === null
        || pbGhostEnabled === null
    ) {
        return null;
    }

    return {
        carSkin,
        trailId,
        musicEnabled,
        carAudioEnabled,
        crashAutoRestartEnabled,
        crashRestartDelaySec,
        pbGhostEnabled,
    };
}

export function salvagePlayerPreferences(value: unknown): DailyGpPlayerPreferences | null {
    const fields = readPlayerPreferenceFields(value);
    if (!fields) return null;

    return {
        carSkin: fields.carSkin ?? DEFAULT_PLAYER_PREFERENCES.carSkin,
        trailId: fields.trailId ?? DEFAULT_PLAYER_PREFERENCES.trailId,
        musicEnabled: fields.musicEnabled ?? DEFAULT_PLAYER_PREFERENCES.musicEnabled,
        carAudioEnabled: fields.carAudioEnabled ?? DEFAULT_PLAYER_PREFERENCES.carAudioEnabled,
        crashAutoRestartEnabled: fields.crashAutoRestartEnabled
            ?? DEFAULT_PLAYER_PREFERENCES.crashAutoRestartEnabled,
        crashRestartDelaySec: fields.crashRestartDelaySec
            ?? DEFAULT_PLAYER_PREFERENCES.crashRestartDelaySec,
        pbGhostEnabled: fields.pbGhostEnabled ?? DEFAULT_PLAYER_PREFERENCES.pbGhostEnabled,
    };
}

export function parseStoredPlayerProfile(raw: string | null | undefined): DailyGpPlayerProfile | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.playerId !== 'string' || !parsed.playerId) {
            return null;
        }

        return {
            playerId: parsed.playerId,
            leaderboardIdentity: normalizeLeaderboardIdentityPreference(parsed.leaderboardIdentity),
            redditUsername: sanitizeRedditUsername(parsed.redditUsername),
            preferences: salvagePlayerPreferences(parsed.preferences),
            hasSeenGame: parsed.hasSeenGame !== false,
            hasAnyData: Boolean(parsed.hasAnyData),
            firstSeenAt: typeof parsed.firstSeenAt === 'string' && parsed.firstSeenAt
                ? parsed.firstSeenAt
                : new Date(0).toISOString(),
            lastSeenAt: typeof parsed.lastSeenAt === 'string' && parsed.lastSeenAt
                ? parsed.lastSeenAt
                : new Date(0).toISOString(),
            updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt
                ? parsed.updatedAt
                : new Date(0).toISOString(),
        };
    } catch (_error) {
        return null;
    }
}

export function createRedisPlayerProfileKey(playerId: string): string {
    const playerKey = createHash('sha256')
        .update(playerId, 'utf8')
        .digest('base64url');
    return `dailygp:player-profile:${playerKey}`;
}

function createPlayerProfileExpiration(
    playerId: string,
): { expiration: Date } | undefined {
    const ttlSeconds = playerId.startsWith('guest:')
        ? DAILY_GP_GUEST_PROFILE_TTL_SECONDS
        : DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS;
    return ttlSeconds === null
        ? undefined
        : { expiration: new Date(Date.now() + ttlSeconds * 1000) };
}

async function writePlayerProfile(profile: DailyGpPlayerProfile): Promise<void> {
    await redis.set(
        createRedisPlayerProfileKey(profile.playerId),
        JSON.stringify(profile),
        createPlayerProfileExpiration(profile.playerId),
    );
}

function resolveStoredLeaderboardIdentity(
    leaderboardIdentity: unknown,
    previousProfile: DailyGpPlayerProfile | null,
): 'constructed' | 'reddit' {
    if (leaderboardIdentity === 'reddit' || leaderboardIdentity === 'constructed') {
        return leaderboardIdentity;
    }

    return previousProfile?.leaderboardIdentity || 'constructed';
}

function normalizeGuestPlayerId(playerId: unknown): string | null {
    return typeof playerId === 'string' && playerId.trim()
        ? playerId.trim()
        : null;
}

export async function resolveAuthorizedPlayerIdentity({
    playerId,
    redditUsername,
    guestToken,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
}): Promise<ResolvedPlayerIdentity> {
    const safeUsername = sanitizeRedditUsername(redditUsername);
    if (safeUsername) {
        return {
            canonicalPlayerId: `reddit:${safeUsername.toLowerCase()}`,
            guestPlayerId: null,
            guestToken: null,
        };
    }

    const normalizedGuestToken = typeof guestToken === 'string' && guestToken.trim()
        ? guestToken.trim()
        : null;
    if (normalizedGuestToken) {
        const verifiedGuestPlayerId = await verifyGuestPlayerToken(normalizedGuestToken);
        if (!verifiedGuestPlayerId) {
            return {
                canonicalPlayerId: null,
                guestPlayerId: null,
                guestToken: null,
            };
        }

        const normalizedGuestPlayerId = normalizeGuestPlayerId(playerId);
        if (normalizedGuestPlayerId && normalizedGuestPlayerId !== verifiedGuestPlayerId) {
            return {
                canonicalPlayerId: null,
                guestPlayerId: null,
                guestToken: null,
            };
        }

        return {
            canonicalPlayerId: `guest:${verifiedGuestPlayerId}`,
            guestPlayerId: verifiedGuestPlayerId,
            guestToken: normalizedGuestToken,
        };
    }

    return {
        canonicalPlayerId: null,
        guestPlayerId: null,
        guestToken: null,
    };
}

export async function readPlayerProfile(playerId: string): Promise<DailyGpPlayerProfile | null> {
    const rawProfile = await redis.get(createRedisPlayerProfileKey(playerId));
    return parseStoredPlayerProfile(rawProfile);
}

export function buildPlayerProfile({
    playerId,
    leaderboardIdentity,
    redditUsername,
    preferences,
    hasAnyData,
    previousProfile,
}: {
    playerId: string;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    preferences?: unknown;
    hasAnyData?: boolean;
    previousProfile?: DailyGpPlayerProfile | null;
}): DailyGpPlayerProfile {
    const nowIso = new Date().toISOString();
    return {
        playerId,
        leaderboardIdentity: resolveStoredLeaderboardIdentity(leaderboardIdentity, previousProfile || null),
        redditUsername: sanitizeRedditUsername(redditUsername) || previousProfile?.redditUsername || null,
        preferences: preferences === undefined
            ? previousProfile?.preferences || null
            : normalizePlayerPreferences(preferences),
        hasSeenGame: true,
        hasAnyData: Boolean(hasAnyData || previousProfile?.hasAnyData),
        firstSeenAt: previousProfile?.firstSeenAt || nowIso,
        lastSeenAt: nowIso,
        updatedAt: nowIso,
    };
}

export async function claimNewGuestPlayerProfile({
    playerId,
    leaderboardIdentity,
}: {
    playerId?: unknown;
    leaderboardIdentity?: unknown;
}): Promise<{
    canonicalPlayerId: string;
    guestPlayerId: string;
    guestToken: string;
    profile: DailyGpPlayerProfile;
} | null> {
    const guestPlayerId = normalizeGuestPlayerId(playerId);
    if (!guestPlayerId) {
        return null;
    }

    const guestToken = await mintGuestPlayerToken(guestPlayerId);
    if (!guestToken) {
        return null;
    }

    const canonicalPlayerId = `guest:${guestPlayerId}`;
    const profile = buildPlayerProfile({
        playerId: canonicalPlayerId,
        leaderboardIdentity,
        hasAnyData: false,
        previousProfile: null,
    });
    const claimed = await redis.set(
        createRedisPlayerProfileKey(canonicalPlayerId),
        JSON.stringify(profile),
        { nx: true, ...createPlayerProfileExpiration(canonicalPlayerId) },
    );
    if (!claimed) {
        return null;
    }

    return {
        canonicalPlayerId,
        guestPlayerId,
        guestToken,
        profile,
    };
}

/** A guest whose token is lost keeps their player id; without re-issuing one, every ghost, unlock and stage keyed to that id is unreachable for good. */
export async function adoptExistingGuestPlayerProfile({
    playerId,
}: {
    playerId?: unknown;
}): Promise<{
    canonicalPlayerId: string;
    guestPlayerId: string;
    guestToken: string;
    profile: DailyGpPlayerProfile;
} | null> {
    const guestPlayerId = normalizeGuestPlayerId(playerId);
    if (!guestPlayerId) {
        return null;
    }

    const canonicalPlayerId = `guest:${guestPlayerId}`;
    const profile = await readPlayerProfile(canonicalPlayerId);
    if (!profile) {
        return null;
    }

    const guestToken = await mintGuestPlayerToken(guestPlayerId);
    if (!guestToken) {
        return null;
    }

    return {
        canonicalPlayerId,
        guestPlayerId,
        guestToken,
        profile,
    };
}

export async function upsertPlayerProfile({
    playerId,
    leaderboardIdentity,
    redditUsername,
    preferences,
    hasAnyData,
    previousProfile,
}: {
    playerId: string;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    preferences?: unknown;
    hasAnyData?: boolean;
    previousProfile?: DailyGpPlayerProfile | null;
}): Promise<DailyGpPlayerProfile> {
    const resolvedPreviousProfile = previousProfile ?? await readPlayerProfile(playerId);
    const nextProfile = buildPlayerProfile({
        playerId,
        leaderboardIdentity,
        redditUsername,
        preferences,
        hasAnyData,
        previousProfile: resolvedPreviousProfile,
    });

    await writePlayerProfile(nextProfile);
    return nextProfile;
}

export async function readPlayerProfileMap(playerIds: string[]): Promise<Map<string, DailyGpPlayerProfile>> {
    const uniquePlayerIds = [...new Set(playerIds.filter((playerId) => typeof playerId === 'string' && playerId))];
    if (!uniquePlayerIds.length) {
        return new Map();
    }

    const rawProfiles = await redis.mGet(uniquePlayerIds.map(createRedisPlayerProfileKey));
    const profileMap = new Map<string, DailyGpPlayerProfile>();

    uniquePlayerIds.forEach((playerId, index) => {
        const parsed = parseStoredPlayerProfile(rawProfiles[index]);
        if (parsed) {
            profileMap.set(playerId, parsed);
        }
    });

    return profileMap;
}
