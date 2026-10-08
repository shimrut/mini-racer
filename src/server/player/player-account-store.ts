import { redis } from '@devvit/redis';
import { TRACKS } from '../../../game/track/tracks.js';
import { hasTrack } from '../../../game/track/catalog.js';
import { confirmStoredTracks } from '../tracks/stored-catalog.js';
import {
    sanitizeRedditUsername,
} from '../../../game/shared/leaderboard-identity.js';
import {
    DAILY_GP_PLAYLIST_DAYS,
    type DailyGpChallenge,
    type DailyGpPlayerPreferences,
    type DailyGpPlayerProfile,
} from '../daily/daily-gp-model.js';
import { toDailyCompetition } from '../competition/competition.js';
import {
    readEntryByPlayerId,
} from '../competition/competition-leaderboard.js';
import {
    adoptExistingGuestPlayerProfile,
    claimNewGuestPlayerProfile,
    normalizePlayerPreferences,
    readPlayerProfile,
    resolveAuthorizedPlayerIdentity,
    upsertPlayerProfile,
} from '../competition/competition-identity.js';
import {
    getPlayerTrackPbRecord,
    seedPlayerTrackPersonalBest,
} from '../competition/pb-ghost-store.js';
import {
    readGuestPromotionTarget,
    hasRecordedCompletedRace,
    recordCompletedRace,
    retireEmptyGuestIdentity,
    settleOwedRewards,
    type CarUnlockSnapshot,
} from './car-unlock-store.js';
import {
    STOCK_CAR_ASSET_NAME,
    isCarAssetUnlocked,
} from '../../../game/car/car-unlock-policy.js';
import { getCarAssetGround } from '../../../game/car/car-skin-grounds.js';
import { verifyGuestPlayerToken } from './player-token.js';
import {
    isGuestProgressSelectionPending,
    isProgressTransferPending,
    resolveGuestIdentityStatus,
} from './guest-retirement.js';
import {
    getGuestProgressSelection,
    getServerDailyGpPlayableChallenge,
    getServerDailyGpPlaylistContracts,
    guestProgressRecoveryRequiredError,
    guestProgressSelectionKey,
    pendingSelectionPayload,
    readPlayerCarUnlocks,
    resolveAccountTransferState,
    selectGuestProgress,
    type GuestProgressSelection,
} from '../daily/daily-gp-store.js';

type PlayerBootstrapPayload = {
    playerId: string | null;
    guestToken: string | null;
    redditUsername: string | null;
    leaderboardIdentity: 'constructed' | 'reddit';
    playerPreferences: DailyGpPlayerPreferences | null;
    hasAnyData: boolean;
    isReturningPlayer: boolean;
    firstSeenAt: string | null;
    carUnlocks: CarUnlockSnapshot | null;
    retireGuestIdentity: boolean;
    guestJoinedAccount?: boolean;
    progressSelection?: GuestProgressSelection | null;
};

const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;

function isAllowedGroundCarSkin(
    assetName: string | undefined,
    ground: 'tarmac' | 'grip' | 'dirt' | 'snow' | 'water' | 'space',
    carUnlocks: CarUnlockSnapshot,
): assetName is string {
    return typeof assetName === 'string'
        && getCarAssetGround(assetName) === ground
        && isCarAssetUnlocked(assetName, carUnlocks);
}

// A skin must be unlocked and on its own ground; a bad tarmac skin falls back to stock, others are dropped.
function preferencesAllowedByCarUnlocks(
    preferences: DailyGpPlayerPreferences | null,
    carUnlocks: CarUnlockSnapshot,
): DailyGpPlayerPreferences | null {
    if (!preferences) return null;
    const { carSkinGrip, carSkinDirt, carSkinSnow, carSkinWater, carSkinSpace, ...rest } = preferences;
    return {
        ...rest,
        carSkin: isAllowedGroundCarSkin(preferences.carSkin, 'tarmac', carUnlocks)
            ? preferences.carSkin
            : STOCK_CAR_ASSET_NAME,
        ...(isAllowedGroundCarSkin(carSkinGrip, 'grip', carUnlocks) ? { carSkinGrip } : {}),
        ...(isAllowedGroundCarSkin(carSkinDirt, 'dirt', carUnlocks) ? { carSkinDirt } : {}),
        ...(isAllowedGroundCarSkin(carSkinSnow, 'snow', carUnlocks) ? { carSkinSnow } : {}),
        ...(isAllowedGroundCarSkin(carSkinWater, 'water', carUnlocks) ? { carSkinWater } : {}),
        ...(isAllowedGroundCarSkin(carSkinSpace, 'space', carUnlocks) ? { carSkinSpace } : {}),
    };
}

function carSkinsDiffer(a: DailyGpPlayerPreferences, b: DailyGpPlayerPreferences): boolean {
    return a.carSkin !== b.carSkin
        || a.carSkinGrip !== b.carSkinGrip
        || a.carSkinDirt !== b.carSkinDirt
        || a.carSkinSnow !== b.carSkinSnow
        || a.carSkinWater !== b.carSkinWater
        || a.carSkinSpace !== b.carSkinSpace;
}

export async function selectServerGuestProgress({
    playerId,
    redditUsername,
    guestToken,
    choice,
    action,
    transferId,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    choice?: unknown;
    action?: unknown;
    transferId?: unknown;
}): Promise<PlayerBootstrapPayload> {
    const safeUsername = sanitizeRedditUsername(redditUsername);
    if (action === 'resume' || action === 'status') {
        if (!safeUsername || typeof transferId !== 'string' || !transferId) {
            throw guestProgressRecoveryRequiredError();
        }
        const redditPlayerId = `reddit:${safeUsername.toLowerCase()}`;
        const known = await resolveAccountTransferState(redditPlayerId, { transferId });
        if (known?.state === 'completed' && known.transferId === transferId) {
            const state = await getServerPlayerBootstrap({ redditUsername: safeUsername });
            return { ...state, progressSelection: known };
        }
        if (action === 'status') {
            const state = await getServerPlayerBootstrap({ redditUsername: safeUsername });
            return known ? { ...state, progressSelection: known } : state;
        }
        if (!known
            || known.state !== 'resume_required'
            || !known.sourceGuestPlayerId
            || transferId !== known.transferId) {
            throw guestProgressRecoveryRequiredError();
        }
        const result = await selectGuestProgress({
            guestPlayerId: known.sourceGuestPlayerId,
            redditPlayerId,
            choice: known.choice,
            resume: true,
            transferId,
        });
        const state = await getServerPlayerBootstrap({ redditUsername: safeUsername });
        return {
            ...state,
            progressSelection: pendingSelectionPayload({
                guestPlayerId: result.sourceGuestPlayerId,
                redditPlayerId,
                choice: result.choice,
                state: 'completed',
                completedAt: result.completedAt,
            }),
        };
    }
    const verifiedGuestPlayerId = await verifyGuestPlayerToken(guestToken);
    if (!safeUsername || !verifiedGuestPlayerId) {
        const error = new Error('Guest progress selection requires a signed-in Reddit account and valid guest token.');
        (error as Error & { statusCode?: number }).statusCode = 401;
        throw error;
    }
    const normalizedPlayerId = typeof playerId === 'string' ? playerId.trim() : '';
    if (normalizedPlayerId && normalizedPlayerId !== verifiedGuestPlayerId) {
        const error = new Error('Guest progress selection identity changed.');
        (error as Error & { statusCode?: number }).statusCode = 401;
        throw error;
    }
    await selectGuestProgress({
        guestPlayerId: `guest:${verifiedGuestPlayerId}`,
        redditPlayerId: `reddit:${safeUsername.toLowerCase()}`,
        choice,
    });
    return getServerPlayerBootstrap({
        playerId: normalizedPlayerId || verifiedGuestPlayerId,
        redditUsername: safeUsername,
        guestToken,
    });
}

async function readOrSeedTrackPersonalBest({
    playerId,
    challenge,
}: {
    playerId: string;
    challenge: DailyGpChallenge;
}) {
    const track = TRACKS[challenge.trackKey];
    if (!track) return null;

    const competition = toDailyCompetition(challenge);
    const existing = await getPlayerTrackPbRecord({
        playerId,
        competition,
        track,
    });
    if (existing) return existing;

    const retainedEntry = await readEntryByPlayerId(competition, playerId);
    if (!retainedEntry || retainedEntry.validationMethod !== 'strict-replay') {
        return null;
    }
    // A transfer owns the player's rows until it ends.
    if (await isProgressTransferPending(playerId)) return null;

    try {
        const seeded = await seedPlayerTrackPersonalBest({
            playerId,
            competition,
            track,
            bestTimeMs: retainedEntry.bestTimeMs,
            checkpointTimesSec: retainedEntry.checkpointTimesSec,
            updatedAt: retainedEntry.updatedAt,
        });
        return seeded.record;
    } catch (error) {
        console.error('Challenge PB seed from a retained leaderboard entry failed:', error);
        return null;
    }
}

export async function getServerPlayerTrackPbSummaries({
    challengeIds,
    playerId,
    redditUsername,
    guestToken,
}: {
    challengeIds?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
}): Promise<{
    playerId: string | null;
    trackPbs: Record<string, {
        trackKey: string;
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        lapCompletionTimesSec: number[] | null;
        ghostAvailable: boolean;
    } | null>;
}> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    if (!identity.canonicalPlayerId) {
        return { playerId: null, trackPbs: {} };
    }
    const requestedIds = Array.isArray(challengeIds)
        ? [...new Set(challengeIds.filter((value): value is string => (
            typeof value === 'string' && Boolean(value)
        )))].slice(0, DAILY_GP_PLAYLIST_DAYS)
        : [];
    if (requestedIds.length === 0) {
        return { playerId: identity.canonicalPlayerId, trackPbs: {} };
    }
    const playlist = await getServerDailyGpPlaylistContracts(new Date(), requestedIds);
    const challengeById = new Map(playlist.map((challenge) => [challenge.id, challenge]));
    await confirmStoredTracks([...new Set(requestedIds.flatMap((challengeId) => {
        const challenge = challengeById.get(challengeId);
        return challenge ? [challenge.trackKey] : [];
    }))]);
    const trackPbs: Record<string, {
        trackKey: string;
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        lapCompletionTimesSec: number[] | null;
        ghostAvailable: boolean;
    } | null> = {};

    for (const challengeId of requestedIds) {
        const challenge = challengeById.get(challengeId);
        if (!challenge || !hasTrack(challenge.trackKey)) {
            trackPbs[challengeId] = null;
            continue;
        }
        const record = await readOrSeedTrackPersonalBest({
            playerId: identity.canonicalPlayerId,
            challenge,
        });
        trackPbs[challengeId] = record
            ? {
                trackKey: record.trackKey,
                bestTimeMs: record.bestTimeMs,
                checkpointTimesSec: record.checkpointTimesSec,
                lapCompletionTimesSec: record.lapCompletionTimesSec,
                ghostAvailable: Boolean(record.ghost),
            }
            : null;
    }

    return {
        playerId: identity.canonicalPlayerId,
        trackPbs,
    };
}

export async function getServerPlayerPbGhost({
    challengeId,
    playerId,
    redditUsername,
    guestToken,
}: {
    challengeId?: unknown;
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
}): Promise<{
    playerId: string | null;
    challengeId: string | null;
    trackKey: string | null;
    personalBest: {
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        lapCompletionTimesSec: number[] | null;
        updatedAt: string;
        ghost: import('../competition/pb-ghost-trace.js').PbGhostTrace | null;
    } | null;
}> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    if (!identity.canonicalPlayerId) {
        return {
            playerId: null,
            challengeId: null,
            trackKey: null,
            personalBest: null,
        };
    }
    const challenge = await getServerDailyGpPlayableChallenge(
        typeof challengeId === 'string' ? challengeId : null,
    );
    if (!challenge) {
        return {
            playerId: identity.canonicalPlayerId,
            challengeId: null,
            trackKey: null,
            personalBest: null,
        };
    }

    const record = await readOrSeedTrackPersonalBest({
        playerId: identity.canonicalPlayerId,
        challenge,
    });
    return {
        playerId: identity.canonicalPlayerId,
        challengeId: challenge.id,
        trackKey: challenge.trackKey,
        personalBest: record
            ? {
                bestTimeMs: record.bestTimeMs,
                checkpointTimesSec: record.checkpointTimesSec,
                lapCompletionTimesSec: record.lapCompletionTimesSec,
                updatedAt: record.updatedAt,
                ghost: record.ghost,
            }
            : null,
    };
}

export async function getServerPlayerBootstrap({
    playerId,
    redditUsername,
    leaderboardIdentity,
    guestToken,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    leaderboardIdentity?: unknown;
    guestToken?: unknown;
} = {}): Promise<PlayerBootstrapPayload> {
    const safeRequestRedditUsername = sanitizeRedditUsername(redditUsername);
    const suppliedGuestToken = typeof guestToken === 'string' && Boolean(guestToken.trim());
    let identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    let previousProfile: DailyGpPlayerProfile | null = null;
    let profile: DailyGpPlayerProfile | null = null;
    let retireGuestIdentity = identity.guestStatus === 'guest_identity_retired';
    let progressSelection: GuestProgressSelection | null = null;
    let guestJoinedAccount = false;

    const bareGuestId = !identity.canonicalPlayerId
        && !safeRequestRedditUsername
        && typeof playerId === 'string'
        && playerId.trim()
        ? `guest:${playerId.trim()}`
        : null;
    const bareGuestStatus = bareGuestId
        ? await resolveGuestIdentityStatus(bareGuestId)
        : null;
    const retiredGuestId = bareGuestStatus?.status === 'guest_identity_retired';
    retireGuestIdentity ||= retiredGuestId;

    if (!identity.canonicalPlayerId && !safeRequestRedditUsername && !suppliedGuestToken && !retiredGuestId) {
        const claimedGuest = await claimNewGuestPlayerProfile({
            playerId,
            leaderboardIdentity,
        });
        if (claimedGuest) {
            identity = {
                canonicalPlayerId: claimedGuest.canonicalPlayerId,
                guestPlayerId: claimedGuest.guestPlayerId,
                guestToken: claimedGuest.guestToken,
                guestSelectionPending: bareGuestStatus?.selectionPending,
            };
            profile = claimedGuest.profile;
        } else {
            const adoptedGuest = await adoptExistingGuestPlayerProfile({ playerId });
            if (adoptedGuest) {
                identity = {
                    canonicalPlayerId: adoptedGuest.canonicalPlayerId,
                    guestPlayerId: adoptedGuest.guestPlayerId,
                    guestToken: adoptedGuest.guestToken,
                    guestSelectionPending: bareGuestStatus?.selectionPending,
                };
                previousProfile = adoptedGuest.profile;
            }
        }
    }

    if (!identity.canonicalPlayerId) {
        return {
            playerId: null,
            guestToken: null,
            redditUsername: safeRequestRedditUsername,
            leaderboardIdentity: 'constructed',
            playerPreferences: null,
            hasAnyData: false,
            isReturningPlayer: false,
            firstSeenAt: null,
            carUnlocks: null,
            retireGuestIdentity,
        };
    }

    if (!profile) {
        previousProfile ??= await readPlayerProfile(identity.canonicalPlayerId);
    }

    let accountTransfer: GuestProgressSelection | null = null;
    if (identity.canonicalPlayerId.startsWith('reddit:')) {
        accountTransfer = await resolveAccountTransferState(identity.canonicalPlayerId);
        const transferBlocksSignIn = accountTransfer?.state === 'resume_required'
            || accountTransfer?.state === 'recovery_required';
        if (transferBlocksSignIn) {
            return {
                playerId: identity.canonicalPlayerId,
                guestToken: typeof guestToken === 'string' ? guestToken.trim() : null,
                redditUsername: safeRequestRedditUsername,
                leaderboardIdentity: 'reddit',
                playerPreferences: null,
                hasAnyData: false,
                isReturningPlayer: false,
                firstSeenAt: null,
                carUnlocks: null,
                retireGuestIdentity: false,
                progressSelection: accountTransfer,
            };
        }
        if (accountTransfer?.state === 'completed') {
            progressSelection = accountTransfer;
        }
        const guestPlayerId = await verifyGuestPlayerToken(guestToken);
        if (guestPlayerId) {
            const promotedTo = await readGuestPromotionTarget(`guest:${guestPlayerId}`);
            if (promotedTo) {
                retireGuestIdentity = true;
                guestJoinedAccount = promotedTo === identity.canonicalPlayerId
                    && !await redis.get(guestProgressSelectionKey(
                        `guest:${guestPlayerId}`,
                        identity.canonicalPlayerId,
                    ));
            } else {
                progressSelection = await getGuestProgressSelection({
                    guestPlayerId: `guest:${guestPlayerId}`,
                    redditPlayerId: identity.canonicalPlayerId,
                });
                if (!progressSelection.required) {
                    if (progressSelection.guestHasProgress === false && !progressSelection.choice) {
                        await retireEmptyGuestIdentity({
                            guestPlayerId: `guest:${guestPlayerId}`,
                            redditPlayerId: identity.canonicalPlayerId,
                        });
                        guestJoinedAccount = await readGuestPromotionTarget(`guest:${guestPlayerId}`)
                            === identity.canonicalPlayerId;
                    }
                    retireGuestIdentity = true;
                } else {
                    return {
                        playerId: identity.canonicalPlayerId,
                        guestToken: typeof guestToken === 'string' ? guestToken.trim() : null,
                        redditUsername: safeRequestRedditUsername,
                        leaderboardIdentity: 'reddit',
                        playerPreferences: null,
                        hasAnyData: false,
                        isReturningPlayer: false,
                        firstSeenAt: null,
                        carUnlocks: null,
                        retireGuestIdentity: false,
                        progressSelection,
                    };
                }
            }
        }
    }

    if (!profile) {
        profile = await upsertPlayerProfile({
            playerId: identity.canonicalPlayerId,
            leaderboardIdentity,
            redditUsername,
            hasAnyData: false,
        });
    }
    const firstSeenMs = Date.parse(profile.firstSeenAt);
    const isReturningPlayer = profile.hasSeenGame
        && Number.isFinite(firstSeenMs)
        && (Date.now() - firstSeenMs) > RETURNING_PLAYER_DELAY_MS;
    const backfillBlockedByTransfer = identity.canonicalPlayerId.startsWith('reddit:')
        ? Boolean(accountTransfer) && accountTransfer.state !== 'completed'
        : identity.guestSelectionPending ?? await isGuestProgressSelectionPending(
            identity.canonicalPlayerId,
        );
    const carUnlocks = await readPlayerCarUnlocks(
        identity.canonicalPlayerId,
        profile.hasAnyData,
    );
    if (!backfillBlockedByTransfer) {
        try {
            if (
                carUnlocks?.progress?.completedRace
                && !await hasRecordedCompletedRace(identity.canonicalPlayerId)
            ) {
                await recordCompletedRace(identity.canonicalPlayerId);
            }
        } catch (error) {
            console.error('Completed-race unlock backfill failed:', error);
        }
        await settleOwedRewards(identity.canonicalPlayerId);
    }
    const playerPreferences = preferencesAllowedByCarUnlocks(profile.preferences, carUnlocks);
    if (
        playerPreferences
        && profile.preferences
        && carSkinsDiffer(playerPreferences, profile.preferences)
    ) {
        profile = await upsertPlayerProfile({
            playerId: identity.canonicalPlayerId,
            redditUsername,
            preferences: playerPreferences,
            hasAnyData: false,
        });
    }

    return {
        playerId: identity.canonicalPlayerId,
        guestToken: identity.guestToken,
        redditUsername: safeRequestRedditUsername,
        leaderboardIdentity: profile.leaderboardIdentity,
        playerPreferences,
        hasAnyData: previousProfile ? (profile.hasSeenGame || profile.hasAnyData) : false,
        isReturningPlayer,
        firstSeenAt: profile.firstSeenAt,
        carUnlocks,
        retireGuestIdentity,
        ...(guestJoinedAccount ? { guestJoinedAccount } : {}),
        ...(progressSelection?.required ? { progressSelection } : {}),
    };
}

export async function updateServerPlayerPreferences({
    playerId,
    redditUsername,
    guestToken,
    playerPreferences,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    guestToken?: unknown;
    playerPreferences?: unknown;
} = {}): Promise<{
    playerId: string | null;
    guestToken: string | null;
    playerPreferences: DailyGpPlayerPreferences | null;
}> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    if (!identity.canonicalPlayerId) {
        return { playerId: null, guestToken: null, playerPreferences: null };
    }

    const normalizedPreferences = normalizePlayerPreferences(playerPreferences);
    if (!normalizedPreferences) {
        return {
            playerId: identity.canonicalPlayerId,
            guestToken: identity.guestToken,
            playerPreferences: null,
        };
    }
    const carUnlocks = await readPlayerCarUnlocks(identity.canonicalPlayerId);
    const allowedPreferences = preferencesAllowedByCarUnlocks(normalizedPreferences, carUnlocks);

    const profile = await upsertPlayerProfile({
        playerId: identity.canonicalPlayerId,
        redditUsername,
        preferences: allowedPreferences,
        hasAnyData: false,
    });
    return {
        playerId: identity.canonicalPlayerId,
        guestToken: identity.guestToken,
        playerPreferences: profile.preferences,
    };
}

export async function updateServerPlayerIdentity({
    playerId,
    redditUsername,
    leaderboardIdentity,
    guestToken,
}: {
    playerId?: unknown;
    redditUsername?: unknown;
    leaderboardIdentity?: unknown;
    guestToken?: unknown;
} = {}): Promise<{ playerId: string | null; guestToken: string | null; leaderboardIdentity: 'constructed' | 'reddit' }> {
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId,
        redditUsername,
        guestToken,
    });
    const canonicalPlayerId = identity.canonicalPlayerId;
    if (!canonicalPlayerId) {
        return {
            playerId: null,
            guestToken: null,
            leaderboardIdentity: 'constructed',
        };
    }

    const profile = await upsertPlayerProfile({
        playerId: canonicalPlayerId,
        leaderboardIdentity,
        redditUsername,
        hasAnyData: false,
    });

    return {
        playerId: canonicalPlayerId,
        guestToken: identity.guestToken,
        leaderboardIdentity: profile.leaderboardIdentity,
    };
}
