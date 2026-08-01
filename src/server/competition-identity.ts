/**
 * Who is submitting, and the profile that names them on a leaderboard —
 * shared across every ranked mode, moved out of daily-gp-store unchanged so
 * Campaign resolves players the same way. Profile keys, TTLs and the guest
 * token contract are untouched; they address live production rows.
 */
import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    DAILY_GP_GUEST_PROFILE_TTL_SECONDS,
    DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS,
    type DailyGpPlayerPreferences,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { mintGuestPlayerToken, verifyGuestPlayerToken } from './player-token.js';
import {
    normalizeLeaderboardIdentityPreference,
    sanitizeRedditUsername,
} from '../../game/shared/leaderboard-identity.js';

export type ResolvedPlayerIdentity = {
    canonicalPlayerId: string | null;
    guestPlayerId: string | null;
    guestToken: string | null;
};

export function normalizePlayerPreferences(value: unknown): DailyGpPlayerPreferences | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const preferences = value as Record<string, unknown>;
    const carSkin = typeof preferences.carSkin === 'string' ? preferences.carSkin.trim() : '';
    const trailId = typeof preferences.trailId === 'string' ? preferences.trailId.trim() : '';
    const crashRestartDelaySec = Number(preferences.crashRestartDelaySec);
    if (
        !carSkin
        || carSkin.length > 160
        || !trailId
        || trailId.length > 32
        || typeof preferences.musicEnabled !== 'boolean'
        || typeof preferences.carAudioEnabled !== 'boolean'
        || typeof preferences.crashAutoRestartEnabled !== 'boolean'
        || (
            preferences.pbGhostEnabled !== undefined
            && typeof preferences.pbGhostEnabled !== 'boolean'
        )
        || !Number.isFinite(crashRestartDelaySec)
        || crashRestartDelaySec < 0
        || crashRestartDelaySec > 1
    ) {
        return null;
    }

    return {
        carSkin,
        trailId,
        musicEnabled: preferences.musicEnabled,
        carAudioEnabled: preferences.carAudioEnabled,
        crashAutoRestartEnabled: preferences.crashAutoRestartEnabled,
        crashRestartDelaySec: Math.round(crashRestartDelaySec * 10) / 10,
        pbGhostEnabled: preferences.pbGhostEnabled !== false,
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
            preferences: normalizePlayerPreferences(parsed.preferences),
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

function createPlayerProfileExpirationDate(playerId: string): Date {
    const ttlSeconds = playerId.startsWith('guest:')
        ? DAILY_GP_GUEST_PROFILE_TTL_SECONDS
        : DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS;
    return new Date(Date.now() + ttlSeconds * 1000);
}

async function writePlayerProfile(profile: DailyGpPlayerProfile): Promise<void> {
    await redis.set(
        createRedisPlayerProfileKey(profile.playerId),
        JSON.stringify(profile),
        { expiration: createPlayerProfileExpirationDate(profile.playerId) },
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
        { nx: true, expiration: createPlayerProfileExpirationDate(canonicalPlayerId) },
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
