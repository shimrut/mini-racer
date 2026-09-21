import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import {
    DAILY_GP_GUEST_PROFILE_TTL_SECONDS,
    DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS,
    type DailyGpPlayerPreferences,
    type DailyGpPlayerProfile,
} from './daily-gp-model.js';
import { mintGuestPlayerToken, verifyGuestPlayerToken } from './player-token.js';
import { resolveGuestIdentityStatus, type GuestIdentityStatus } from './guest-retirement.js';
import { STOCK_CAR_ASSET_NAME } from '../../game/car/car-unlock-policy.js';
import {
    DEFAULT_PAUSE_PLACEMENT,
    PAUSE_PLACEMENT_SEPARATE,
    PAUSE_PLACEMENT_TIMER,
    normalizePausePlacement,
} from '../../game/settings/pause-placement-preference.js';
import {
    normalizeLeaderboardIdentityPreference,
    sanitizeRedditUsername,
} from '../../game/shared/leaderboard-identity.js';
import { isRedisTransactionConflict } from './redis-transaction-conflict.js';

export type ResolvedPlayerIdentity = {
    canonicalPlayerId: string | null;
    guestPlayerId: string | null;
    guestToken: string | null;
    guestStatus?: GuestIdentityStatus;
    /**
     * Whether this guest's transfer flag is set. Absent means this request has not read it.
     * The status above is not a substitute: a promoted guest can be pending while the flag is false.
     */
    guestSelectionPending?: boolean;
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
    pausePlacement: DEFAULT_PAUSE_PLACEMENT,
    pauseOnTimerEnabled: true,
    hideHudEnabled: false,
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

function readOptionalBooleanPreference(value: unknown, defaultValue: boolean): boolean | null {
    if (value === undefined) return defaultValue;
    return readBooleanPreference(value);
}

function readPausePlacement(preferences: Record<string, unknown>): 'separate' | 'timer' | 'speedo' | null {
    if (preferences.pausePlacement !== undefined) {
        return normalizePausePlacement(preferences.pausePlacement);
    }
    const timerEnabled = readOptionalBooleanPreference(
        preferences.pauseOnTimerEnabled,
        DEFAULT_PLAYER_PREFERENCES.pauseOnTimerEnabled,
    );
    if (timerEnabled === null) return null;
    return timerEnabled ? PAUSE_PLACEMENT_TIMER : PAUSE_PLACEMENT_SEPARATE;
}

function readPlayerPreferenceFields(value: unknown): {
    carSkin: string | null;
    trailId: string | null;
    musicEnabled: boolean | null;
    carAudioEnabled: boolean | null;
    crashAutoRestartEnabled: boolean | null;
    crashRestartDelaySec: number | null;
    pbGhostEnabled: boolean | null;
    pausePlacement: 'separate' | 'timer' | 'speedo' | null;
    hideHudEnabled: boolean | null;
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
        pbGhostEnabled: readOptionalBooleanPreference(
            preferences.pbGhostEnabled,
            DEFAULT_PLAYER_PREFERENCES.pbGhostEnabled,
        ),
        pausePlacement: readPausePlacement(preferences),
        hideHudEnabled: readOptionalBooleanPreference(
            preferences.hideHudEnabled,
            DEFAULT_PLAYER_PREFERENCES.hideHudEnabled,
        ),
    };
}

function withDerivedPauseFields(pausePlacement: 'separate' | 'timer' | 'speedo') {
    return {
        pausePlacement,
        pauseOnTimerEnabled: pausePlacement === PAUSE_PLACEMENT_TIMER,
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
        pausePlacement,
        hideHudEnabled,
    } = fields;
    if (
        carSkin === null
        || trailId === null
        || musicEnabled === null
        || carAudioEnabled === null
        || crashAutoRestartEnabled === null
        || crashRestartDelaySec === null
        || pbGhostEnabled === null
        || pausePlacement === null
        || hideHudEnabled === null
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
        ...withDerivedPauseFields(pausePlacement),
        hideHudEnabled,
    };
}

export function salvagePlayerPreferences(value: unknown): DailyGpPlayerPreferences | null {
    const fields = readPlayerPreferenceFields(value);
    if (!fields) return null;

    const pausePlacement = fields.pausePlacement ?? DEFAULT_PLAYER_PREFERENCES.pausePlacement;
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
        ...withDerivedPauseFields(pausePlacement),
        hideHudEnabled: fields.hideHudEnabled
            ?? DEFAULT_PLAYER_PREFERENCES.hideHudEnabled,
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

function playerProfileTtlSeconds(playerId: string): number | null {
    return playerId.startsWith('guest:')
        ? DAILY_GP_GUEST_PROFILE_TTL_SECONDS
        : DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS;
}

function createPlayerProfileExpiration(
    playerId: string,
): { expiration: Date } | undefined {
    const ttlSeconds = playerProfileTtlSeconds(playerId);
    return ttlSeconds === null
        ? undefined
        : { expiration: new Date(Date.now() + ttlSeconds * 1000) };
}

const PLAYER_PROFILE_WRITE_ATTEMPTS = 3;

/**
 * Parse and build list the same keys in the same order, and parse drops anything else stored, so
 * equal strings mean equal profiles. A difference in preference key order only costs a write.
 */
function sameProfile(stored: DailyGpPlayerProfile, next: DailyGpPlayerProfile): boolean {
    return JSON.stringify(stored) === JSON.stringify(next);
}

/**
 * A skipped write must still give an active guest another year, as the rewrite it replaces did.
 * EXPIRE is one command, not a transaction. It is extra to a write that was not needed, so its
 * failure must not fail the request that skipped.
 */
async function renewSkippedProfileExpiry(profileKey: string, playerId: string): Promise<void> {
    const ttlSeconds = playerProfileTtlSeconds(playerId);
    if (ttlSeconds === null) return;
    try {
        await redis.expire(profileKey, ttlSeconds);
    } catch (error) {
        console.error('Player profile expiry renewal failed:', error);
    }
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
        const normalizedGuestToken = typeof guestToken === 'string' && guestToken.trim()
            ? guestToken.trim()
            : null;
        const verifiedGuestPlayerId = normalizedGuestToken
            ? await verifyGuestPlayerToken(normalizedGuestToken)
            : null;
        const guestIdentity = verifiedGuestPlayerId
            ? `guest:${verifiedGuestPlayerId}`
            : null;
        const guestStatus = guestIdentity
            ? (await resolveGuestIdentityStatus(guestIdentity)).status
            : undefined;
        return {
            canonicalPlayerId: `reddit:${safeUsername.toLowerCase()}`,
            guestPlayerId: verifiedGuestPlayerId,
            guestToken: verifiedGuestPlayerId ? normalizedGuestToken : null,
            guestStatus,
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

        const canonicalPlayerId = `guest:${verifiedGuestPlayerId}`;
        // A promoted guest's credential is spent: honouring it would write this browser's races into the account it was merged into.
        const { status, selectionPending } = await resolveGuestIdentityStatus(canonicalPlayerId);
        if (status === 'guest_identity_retired') {
            return {
                canonicalPlayerId: null,
                guestPlayerId: null,
                guestToken: null,
                guestStatus: status,
                guestSelectionPending: selectionPending,
            };
        }

        return {
            canonicalPlayerId,
            guestPlayerId: verifiedGuestPlayerId,
            guestToken: normalizedGuestToken,
            guestStatus: status,
            guestSelectionPending: selectionPending,
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
    return {
        playerId,
        leaderboardIdentity: resolveStoredLeaderboardIdentity(leaderboardIdentity, previousProfile || null),
        redditUsername: sanitizeRedditUsername(redditUsername) || previousProfile?.redditUsername || null,
        preferences: preferences === undefined
            ? previousProfile?.preferences || null
            : normalizePlayerPreferences(preferences),
        hasSeenGame: true,
        hasAnyData: Boolean(hasAnyData || previousProfile?.hasAnyData),
        firstSeenAt: previousProfile?.firstSeenAt || new Date().toISOString(),
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
}: {
    playerId: string;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
    preferences?: unknown;
    hasAnyData?: boolean;
}): Promise<DailyGpPlayerProfile> {
    const profileKey = createRedisPlayerProfileKey(playerId);
    // Every start-up and every Daily finish reaches here. A WATCH holds one of the transactions
    // Reddit allows an installation at a time (20 to 30), and on 2026-09-16 these writes filled
    // the limit: start-ups and saved runs failed for an hour and a half. Most calls change nothing,
    // and a new profile can be created without a transaction, so only a real change takes one.
    const rawProfile = await redis.get(profileKey);
    const storedProfile = parseStoredPlayerProfile(rawProfile);
    const nextProfile = buildPlayerProfile({
        playerId,
        leaderboardIdentity,
        redditUsername,
        preferences,
        hasAnyData,
        previousProfile: storedProfile,
    });
    if (storedProfile && sameProfile(storedProfile, nextProfile)) {
        // Skipping writes nothing, so a writer racing this read loses nothing to it.
        await renewSkippedProfileExpiry(profileKey, playerId);
        return storedProfile;
    }
    if (!rawProfile) {
        // NX never overwrites. If another request created the profile first, the loop below
        // reads that profile and merges this request onto it.
        const created = await redis.set(
            profileKey,
            JSON.stringify(nextProfile),
            { nx: true, ...createPlayerProfileExpiration(playerId) },
        );
        if (created) return nextProfile;
    }
    for (let attempt = 0; attempt < PLAYER_PROFILE_WRITE_ATTEMPTS; attempt += 1) {
        const transaction = await redis.watch(profileKey);
        try {
            // Read through the base client after WATCH; EXEC rejects any write that raced this snapshot.
            const currentProfile = parseStoredPlayerProfile(await redis.get(profileKey));
            const nextProfile = buildPlayerProfile({
                playerId,
                leaderboardIdentity,
                redditUsername,
                preferences,
                hasAnyData,
                previousProfile: currentProfile,
            });
            await transaction.multi();
            await transaction.set(
                profileKey,
                JSON.stringify(nextProfile),
                createPlayerProfileExpiration(playerId),
            );
            const results = await transaction.exec();
            if (Array.isArray(results) && results.length > 0) return nextProfile;
            // An empty EXEC is a lost race. Read the winner's profile and build on it.
        } catch (error) {
            try {
                await transaction.discard();
            } catch (_discardError) {
                // EXEC may already have closed the transaction.
            }
            if (!isRedisTransactionConflict(error)) throw error;
            // Reddit throws the lost race instead of returning an empty EXEC. Same answer: retry.
        }
    }
    throw new Error('Player profile update was interrupted. Try again.');
}

/**
 * What a profile read already found. `profile: null` means a value is stored and does not parse,
 * which shows the constructed name. Missing means this call did not keep a body to reuse.
 */
export type LoadedPlayerProfile = {
    profile: DailyGpPlayerProfile | null;
};

/**
 * A read path has no new identity to store. It creates the profile if it is missing and otherwise
 * leaves it alone, so parallel reads never race each other on the one profile key.
 * A stored body is returned so the caller does not read the same key again. A create is not:
 * the copy in hand loses when another request wins the create.
 */
export async function ensurePlayerProfileExists({
    playerId,
    leaderboardIdentity,
    redditUsername,
}: {
    playerId: string;
    leaderboardIdentity?: unknown;
    redditUsername?: unknown;
}): Promise<LoadedPlayerProfile | undefined> {
    const profileKey = createRedisPlayerProfileKey(playerId);
    const rawProfile = await redis.get(profileKey);
    if (rawProfile) {
        return { profile: parseStoredPlayerProfile(rawProfile) };
    }
    await redis.set(
        profileKey,
        JSON.stringify(buildPlayerProfile({
            playerId,
            leaderboardIdentity,
            redditUsername,
            hasAnyData: false,
            previousProfile: null,
        })),
        { nx: true, ...createPlayerProfileExpiration(playerId) },
    );
    return undefined;
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
