import { TRACKS } from '../game/track/tracks.js';
import {
  getConstructedLeaderboardName,
} from '../src/shared/leaderboard-identity.js';
import { normalizeCheckpointTimesSec } from '../src/shared/checkpoint-times.js';
import {
  buildDailyGpChallenge,
  buildDailyGpPlaylist,
  createDailyGpChallengeMode,
  DAILY_GP_DEFAULT_LIMIT,
  DAILY_GP_NEARBY_RADIUS,
  DAILY_GP_TOP_ROWS_LIMIT,
  formatRankLabel,
  getDailyGpPlayableChallengeById,
  isValidDailyGpTime,
  toBestTimeMs,
  type DailyGpChallenge,
  type DailyGpLeaderboardEntry,
  type DailyGpPlayerProfile,
} from './daily-gp-model.ts';
import { validateDailyGpReplayDetailed } from './daily-gp-replay-validator.ts';

type SnapshotRow = {
  rank: number;
  rankLabel: string;
  playerId: string;
  displayName: string;
  bestTime: number;
  bestTimeMs: number;
  updatedAt: string;
  isCurrentPlayer: boolean;
  completedLaps: null;
  checkpointTimesSec: number[] | null;
};

type SnapshotPayload = {
  topRows: SnapshotRow[];
  nearbyRows: SnapshotRow[];
  currentPlayerRow: SnapshotRow | null;
  totalCount: number;
  leaderboardEntryCount: number;
  objectiveType: string;
  playerRank: number | null;
  playerRankLabel: string | null;
};

type PlayerBootstrapPayload = {
  playerId: string | null;
  redditUsername: string | null;
  leaderboardIdentity: 'constructed';
  hasAnyData: boolean;
  isReturningPlayer: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

type LeaderboardRecord = {
  player_id: string;
  best_time_ms: number;
  updated_at: string;
};

type PlayerProfileRecord = {
  player_id: string;
  leaderboard_identity?: 'constructed' | null;
  updated_at?: string | null;
};

const SCOREBOARD_TABLE = 'scoreboard_best_times';
const PLAYER_PROFILE_TABLE = 'scoreboard_players';
const RETURNING_PLAYER_DELAY_MS = 24 * 60 * 60 * 1000;

function createEmptySnapshot(challenge: DailyGpChallenge): SnapshotPayload {
  return {
    topRows: [],
    nearbyRows: [],
    currentPlayerRow: null,
    totalCount: 0,
    leaderboardEntryCount: 0,
    objectiveType: challenge.objectiveType,
    playerRank: null,
    playerRankLabel: null,
  };
}

function normalizeCommunityMemberTotal(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) {
    return null;
  }
  return Math.min(Math.trunc(n), 1_000_000);
}

function normalizeLimit(limit: unknown): number {
  if (!Number.isFinite(limit)) {
    return DAILY_GP_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(Number(limit)), 1), 100);
}

function toStoredProfile(record: PlayerProfileRecord | null, playerId: string): DailyGpPlayerProfile | null {
  if (!record?.player_id) return null;
  const updatedAt = typeof record.updated_at === 'string' && record.updated_at
    ? record.updated_at
    : null;
  if (!updatedAt) return null;

  return {
    playerId: record.player_id,
    leaderboardIdentity: 'constructed',
    redditUsername: null,
    hasSeenGame: true,
    hasAnyData: false,
    firstSeenAt: updatedAt,
    lastSeenAt: updatedAt,
    updatedAt,
  };
}

function resolveStoredLeaderboardIdentity(
  _leaderboardIdentity: unknown,
  _previousProfile: DailyGpPlayerProfile | null,
): 'constructed' {
  return 'constructed';
}

function resolveWebPlayerId(playerId?: unknown): string | null {
  if (typeof playerId === 'string' && playerId.trim()) {
    return `guest:${playerId.trim()}`;
  }

  return null;
}

async function readPlayerProfile(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  playerId: string,
): Promise<DailyGpPlayerProfile | null> {
  const { data, error } = await supabase
    .from(PLAYER_PROFILE_TABLE)
    .select('player_id,leaderboard_identity,updated_at')
    .eq('player_id', playerId)
    .maybeSingle();

  if (error) {
    console.error('Supabase player profile read failed:', error.message);
    return null;
  }

  return toStoredProfile(data as PlayerProfileRecord | null, playerId);
}

async function hasAnyPlayerData(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  playerId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from(SCOREBOARD_TABLE)
    .select('player_id', { count: 'exact', head: true })
    .eq('player_id', playerId);

  if (error) {
    console.error('Supabase player data count failed:', error.message);
    return false;
  }

  return Number(count) > 0;
}

async function upsertPlayerProfile(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  {
    playerId,
    leaderboardIdentity,
    hasAnyData,
    previousProfile,
  }: {
    playerId: string;
    leaderboardIdentity?: unknown;
    hasAnyData?: boolean;
    previousProfile?: DailyGpPlayerProfile | null;
  },
): Promise<DailyGpPlayerProfile> {
  const resolvedPreviousProfile = previousProfile ?? await readPlayerProfile(supabase, playerId);
  const nowIso = resolvedPreviousProfile?.updatedAt || new Date().toISOString();
  const nextProfile: DailyGpPlayerProfile = {
    playerId,
    leaderboardIdentity: resolveStoredLeaderboardIdentity(leaderboardIdentity, resolvedPreviousProfile),
    redditUsername: null,
    hasSeenGame: true,
    hasAnyData: Boolean(hasAnyData || resolvedPreviousProfile?.hasAnyData),
    firstSeenAt: resolvedPreviousProfile?.firstSeenAt || nowIso,
    lastSeenAt: nowIso,
    updatedAt: nowIso,
  };

  const { error } = await supabase
    .from(PLAYER_PROFILE_TABLE)
    .upsert({
      player_id: playerId,
      leaderboard_identity: nextProfile.leaderboardIdentity,
      updated_at: nowIso,
    }, {
      onConflict: 'player_id',
    });

  if (error) {
    console.error('Supabase player profile upsert failed:', error.message);
  }

  return nextProfile;
}

async function readPlayerProfileMap(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  playerIds: string[],
): Promise<Map<string, DailyGpPlayerProfile>> {
  const uniquePlayerIds = [...new Set(playerIds.filter((playerId) => typeof playerId === 'string' && playerId))];
  if (!uniquePlayerIds.length) {
    return new Map();
  }

  const { data, error } = await supabase
    .from(PLAYER_PROFILE_TABLE)
    .select('player_id,leaderboard_identity,updated_at')
    .in('player_id', uniquePlayerIds);

  if (error) {
    console.error('Supabase player profile batch read failed:', error.message);
    return new Map();
  }

  const profileMap = new Map<string, DailyGpPlayerProfile>();
  for (const raw of (Array.isArray(data) ? data : []) as PlayerProfileRecord[]) {
    const parsed = toStoredProfile(raw, raw.player_id);
    if (parsed) {
      profileMap.set(parsed.playerId, parsed);
    }
  }
  return profileMap;
}

function toSnapshotRow(
  entry: DailyGpLeaderboardEntry,
  rank: number,
  currentPlayerId: string | null,
  profileMap: Map<string, DailyGpPlayerProfile>,
): SnapshotRow {
  return {
    rank,
    rankLabel: formatRankLabel(rank) || '--',
    playerId: entry.playerId,
    displayName: getConstructedLeaderboardName(entry.playerId),
    bestTime: entry.bestTimeMs / 1000,
    bestTimeMs: entry.bestTimeMs,
    updatedAt: entry.updatedAt,
    isCurrentPlayer: entry.playerId === currentPlayerId,
    completedLaps: null,
    checkpointTimesSec: entry.checkpointTimesSec ?? null,
  };
}

function toLeaderboardEntry(
  row: LeaderboardRecord | null | undefined,
  extras: Partial<DailyGpLeaderboardEntry> = {},
): DailyGpLeaderboardEntry | null {
  if (!row?.player_id || !Number.isFinite(Number(row.best_time_ms)) || typeof row.updated_at !== 'string') {
    return null;
  }

  return {
    playerId: row.player_id,
    bestTimeMs: Number(row.best_time_ms),
    updatedAt: row.updated_at,
    completedLaps: null,
    checkpointTimesSec: extras.checkpointTimesSec ?? null,
    validationMethod: extras.validationMethod,
    strictReplayFailureReason: extras.strictReplayFailureReason ?? null,
  };
}

async function readLeaderboardRows(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  challengeId: string,
): Promise<DailyGpLeaderboardEntry[]> {
  const { data, error } = await supabase
    .from(SCOREBOARD_TABLE)
    .select('player_id,best_time_ms,updated_at')
    .eq('mode', createDailyGpChallengeMode(challengeId))
    .order('best_time_ms', { ascending: true })
    .order('updated_at', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (Array.isArray(data) ? data : [])
    .map((row) => toLeaderboardEntry(row as LeaderboardRecord))
    .filter((entry): entry is DailyGpLeaderboardEntry => Boolean(entry));
}

async function readRowsByRankRange(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  challengeId: string,
  start: number,
  stop: number,
  currentPlayerId: string | null,
): Promise<SnapshotRow[]> {
  if (stop < start || start < 0) {
    return [];
  }

  const rows = await readLeaderboardRows(supabase, challengeId);
  const slicedRows = rows.slice(start, stop + 1);
  if (!slicedRows.length) {
    return [];
  }
  const profileMap = await readPlayerProfileMap(
    supabase,
    slicedRows.map((entry) => entry.playerId),
  );

  return slicedRows.map((entry, index) => {
    return toSnapshotRow(entry, start + index + 1, currentPlayerId, profileMap);
  });
}

async function readEntryByPlayerId(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  challengeId: string,
  playerId: string,
): Promise<DailyGpLeaderboardEntry | null> {
  const { data, error } = await supabase
    .from(SCOREBOARD_TABLE)
    .select('player_id,best_time_ms,updated_at')
    .eq('player_id', playerId)
    .eq('mode', createDailyGpChallengeMode(challengeId))
    .maybeSingle();

  if (error) {
    console.error('Supabase leaderboard entry read failed:', error.message);
    return null;
  }

  return toLeaderboardEntry(data as LeaderboardRecord | null);
}

function getReplayRaceClockFrameCount(replay: unknown): number | null {
  if (!replay || typeof replay !== 'object') return null;
  const inputs = (replay as { inputs?: unknown }).inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) return null;

  let frameCount = 0;
  let raceClockFrameCount = 0;
  for (const rawSegment of inputs) {
    if (!rawSegment || typeof rawSegment !== 'object') return null;
    const segment = rawSegment as Record<string, unknown>;
    const frames = Number(segment.frames);
    if (!Number.isInteger(frames) || frames < 1) return null;
    if (typeof segment.left !== 'boolean') return null;
    if (typeof segment.right !== 'boolean') return null;
    if (typeof segment.relaunchDelay !== 'boolean') return null;
    frameCount += frames;
    if (frameCount > 20_000) return null;
    if (!segment.relaunchDelay) {
      raceClockFrameCount += frames;
    }
  }
  return raceClockFrameCount;
}

function validateBasicDailyGpSubmission({
  challenge,
  bestTime,
  replay,
  checkpointTimesSec,
}: {
  challenge: DailyGpChallenge;
  bestTime?: unknown;
  replay?: unknown;
  checkpointTimesSec?: unknown;
}): { ok: true; bestTimeSec: number; bestTimeMs: number; checkpointTimesSec: number[] | null } | { ok: false; reason: string } {
  if (!isValidDailyGpTime(bestTime)) {
    return { ok: false, reason: 'invalid_time' };
  }

  const bestTimeSec = Number(bestTime);
  const replayRaceClockFrameCount = getReplayRaceClockFrameCount(replay);
  if (replayRaceClockFrameCount === null || !Number.isFinite(replayRaceClockFrameCount)) {
    return { ok: false, reason: 'invalid_replay' };
  }

  const replayRaceClockSec = replayRaceClockFrameCount / 60;
  if (Math.abs(replayRaceClockSec - bestTimeSec) > 0.25) {
    return { ok: false, reason: 'time_replay_mismatch' };
  }

  const track = TRACKS[challenge.trackKey as keyof typeof TRACKS];
  const requiredCheckpointCount = Array.isArray(track?.checkpoints)
    ? track.checkpoints.length
    : 0;
  const normalizedCheckpoints = normalizeCheckpointTimesSec(bestTimeSec, checkpointTimesSec);
  if (requiredCheckpointCount > 0) {
    if (!normalizedCheckpoints || normalizedCheckpoints.length !== requiredCheckpointCount) {
      return { ok: false, reason: 'checkpoint_mismatch' };
    }
  }

  return {
    ok: true,
    bestTimeSec,
    bestTimeMs: toBestTimeMs(bestTimeSec),
    checkpointTimesSec: normalizedCheckpoints ?? null,
  };
}

export async function getServerDailyGpChallenge(): Promise<DailyGpChallenge> {
  return buildDailyGpChallenge();
}

export async function getServerDailyGpPlayableChallenge(challengeId?: string | null): Promise<DailyGpChallenge | null> {
  return getDailyGpPlayableChallengeById(challengeId);
}

export async function getServerPlayerBootstrap(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  {
    playerId,
    leaderboardIdentity,
  }: {
    playerId?: unknown;
    leaderboardIdentity?: unknown;
  } = {},
): Promise<PlayerBootstrapPayload> {
  const canonicalPlayerId = resolveWebPlayerId(playerId);

  if (!canonicalPlayerId) {
    return {
      playerId: null,
      redditUsername: null,
      leaderboardIdentity: 'constructed',
      hasAnyData: false,
      isReturningPlayer: false,
      firstSeenAt: null,
      lastSeenAt: null,
    };
  }

  const previousProfile = await readPlayerProfile(supabase, canonicalPlayerId);
  const hasAnyData = await hasAnyPlayerData(supabase, canonicalPlayerId);
  const profile = await upsertPlayerProfile(supabase, {
    playerId: canonicalPlayerId,
    leaderboardIdentity,
    hasAnyData,
    previousProfile,
  });
  const firstSeenMs = Date.parse(profile.firstSeenAt);
  const isReturningPlayer = hasAnyData
    || (
      Number.isFinite(firstSeenMs)
      && (Date.now() - firstSeenMs) > RETURNING_PLAYER_DELAY_MS
    );

  return {
    playerId: canonicalPlayerId,
    redditUsername: null,
    leaderboardIdentity: 'constructed',
    hasAnyData,
    isReturningPlayer,
    firstSeenAt: profile.firstSeenAt,
    lastSeenAt: profile.lastSeenAt,
  };
}

export async function updateServerPlayerIdentity(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  {
    playerId,
    leaderboardIdentity,
  }: {
    playerId?: unknown;
    leaderboardIdentity?: unknown;
  } = {},
): Promise<{ playerId: string | null; leaderboardIdentity: 'constructed' }> {
  const canonicalPlayerId = resolveWebPlayerId(playerId);
  if (!canonicalPlayerId) {
    return {
      playerId: null,
      leaderboardIdentity: 'constructed',
    };
  }

  const profile = await upsertPlayerProfile(supabase, {
    playerId: canonicalPlayerId,
    leaderboardIdentity,
    hasAnyData: false,
  });

  return {
    playerId: canonicalPlayerId,
    leaderboardIdentity: 'constructed',
  };
}

export async function getServerDailyGpSnapshot(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  {
    challengeId,
    playerId,
    leaderboardIdentity,
    limit = DAILY_GP_DEFAULT_LIMIT,
    communityMemberTotal,
  }: {
    challengeId?: string | null;
    playerId?: string | null;
    leaderboardIdentity?: unknown;
    limit?: unknown;
    communityMemberTotal?: unknown;
  } = {},
): Promise<SnapshotPayload> {
  const activeChallenge = await getServerDailyGpChallenge();
  const challenge = challengeId
    ? await getServerDailyGpPlayableChallenge(challengeId)
    : activeChallenge;
  if (!challenge) {
    return createEmptySnapshot(activeChallenge);
  }

  const safeLimit = normalizeLimit(limit);
  const allRows = await readLeaderboardRows(supabase, challenge.id);
  const leaderboardEntryCount = allRows.length;
  const communityFloor = normalizeCommunityMemberTotal(communityMemberTotal);
  const totalCount = communityFloor != null
    ? Math.max(leaderboardEntryCount, communityFloor)
    : leaderboardEntryCount;

  if (leaderboardEntryCount === 0 && totalCount === 0) {
    return createEmptySnapshot(challenge);
  }

  const normalizedPlayerId = resolveWebPlayerId(playerId);
  if (normalizedPlayerId) {
    await upsertPlayerProfile(supabase, {
      playerId: normalizedPlayerId,
      leaderboardIdentity,
      hasAnyData: false,
    });
  }

  const topRows = leaderboardEntryCount
    ? await readRowsByRankRange(supabase, challenge.id, 0, safeLimit - 1, normalizedPlayerId)
    : [];
  const playerRankZeroBased = normalizedPlayerId
    ? allRows.findIndex((entry) => entry.playerId === normalizedPlayerId)
    : -1;
  const playerRank = playerRankZeroBased >= 0 ? playerRankZeroBased + 1 : null;

  const playerInTop = normalizedPlayerId
    ? topRows.find((row) => row.playerId === normalizedPlayerId) || null
    : null;

  if (playerInTop) {
    return {
      topRows,
      nearbyRows: [],
      currentPlayerRow: {
        ...playerInTop,
        isCurrentPlayer: true,
      },
      totalCount,
      leaderboardEntryCount,
      objectiveType: challenge.objectiveType,
      playerRank,
      playerRankLabel: formatRankLabel(playerRank),
    };
  }

  let currentPlayerRow: SnapshotRow | null = null;
  if (normalizedPlayerId && playerRank) {
    const storedEntry = await readEntryByPlayerId(supabase, challenge.id, normalizedPlayerId);
    if (storedEntry) {
      const profileMap = await readPlayerProfileMap(supabase, [normalizedPlayerId]);
      currentPlayerRow = toSnapshotRow(storedEntry, playerRank, normalizedPlayerId, profileMap);
      currentPlayerRow.isCurrentPlayer = true;
    }
  }

  let nearbyRows: SnapshotRow[] = [];
  if (playerRank && playerRank > safeLimit && leaderboardEntryCount) {
    const nearbyStart = Math.max(0, playerRank - DAILY_GP_NEARBY_RADIUS - 1);
    const nearbyStop = nearbyStart + (DAILY_GP_NEARBY_RADIUS * 2);
    nearbyRows = await readRowsByRankRange(supabase, challenge.id, nearbyStart, nearbyStop, normalizedPlayerId);
  }

  return {
    topRows: playerRank && playerRank > safeLimit
      ? topRows.slice(0, DAILY_GP_TOP_ROWS_LIMIT)
      : topRows,
    nearbyRows,
    currentPlayerRow,
    totalCount,
    leaderboardEntryCount,
    objectiveType: challenge.objectiveType,
    playerRank,
    playerRankLabel: formatRankLabel(playerRank),
  };
}

export async function submitServerDailyGpRun(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  {
    playerId,
    challengeId,
    leaderboardIdentity,
    bestTime,
    replay,
    checkpointTimesSec,
    trackKey,
  }: {
    playerId?: unknown;
    challengeId?: unknown;
    leaderboardIdentity?: unknown;
    bestTime?: unknown;
    replay?: unknown;
    checkpointTimesSec?: unknown;
    trackKey?: unknown;
  },
) {
  const challenge = await getServerDailyGpPlayableChallenge(
    typeof challengeId === 'string' ? challengeId : null,
  );
  if (!challenge) {
    const activeChallenge = await getServerDailyGpChallenge();
    return {
      status: 409,
      body: {
        accepted: false,
        error: 'Daily challenge is no longer playable.',
        challengeId: activeChallenge.id,
      },
    };
  }

  if (trackKey !== challenge.trackKey) {
    return {
      status: 422,
      body: {
        accepted: false,
        error: 'Submission track does not match challenge.',
        reason: 'track_mismatch',
      },
    };
  }

  if (!resolveWebPlayerId(playerId)) {
    return {
      status: 400,
      body: {
        accepted: false,
        error: 'Invalid Mini Racer submission.',
      },
    };
  }

  const strictReplayOutcome = validateDailyGpReplayDetailed({ challenge, replay });
  const strictReplayPassed = strictReplayOutcome.ok;
  const basicValidation = strictReplayPassed
    ? null
    : validateBasicDailyGpSubmission({
      challenge,
      bestTime,
      replay,
      checkpointTimesSec,
    });
  if (!strictReplayPassed && !basicValidation?.ok) {
    return {
      status: 422,
      body: {
        accepted: false,
        error: 'Submission sanity checks failed.',
        reason: basicValidation?.reason || strictReplayOutcome.failure.reason,
        strictReplayFailureReason: strictReplayOutcome.failure.reason,
      },
    };
  }

  const normalizedPlayerId = resolveWebPlayerId(playerId);
  if (!normalizedPlayerId) {
    return {
      status: 400,
      body: {
        accepted: false,
        error: 'Player identity is unavailable.',
      },
    };
  }
  await upsertPlayerProfile(supabase, {
    playerId: normalizedPlayerId,
    leaderboardIdentity,
    hasAnyData: true,
  });
  const validatedBasicRun = basicValidation && basicValidation.ok ? basicValidation : null;
  const nextBestTimeSec = strictReplayPassed
    ? strictReplayOutcome.run.bestTimeSec
    : validatedBasicRun!.bestTimeSec;
  const nextBestTimeMs = strictReplayPassed
    ? strictReplayOutcome.run.bestTimeMs
    : validatedBasicRun!.bestTimeMs;
  const previousEntry = await readEntryByPlayerId(supabase, challenge.id, normalizedPlayerId);
  if (previousEntry && previousEntry.bestTimeMs <= nextBestTimeMs) {
    return {
      status: 200,
      body: {
        accepted: true,
        bestTimeMs: previousEntry.bestTimeMs,
        completedLaps: null,
        checkpointTimesSec: previousEntry.checkpointTimesSec ?? null,
      },
    };
  }

  const normalizedCheckpointTimesSec = normalizeCheckpointTimesSec(
    nextBestTimeSec,
    strictReplayPassed ? strictReplayOutcome.run.checkpointTimesSec : validatedBasicRun!.checkpointTimesSec,
  ) ?? validatedBasicRun?.checkpointTimesSec ?? null;

  const validationMethod = strictReplayPassed ? 'strict-replay' : 'basic-sanity';
  const strictReplayFailureReason = strictReplayPassed ? null : strictReplayOutcome.failure.reason;

  const { error } = await supabase
    .from(SCOREBOARD_TABLE)
    .upsert({
      player_id: normalizedPlayerId,
      track_key: challenge.trackKey,
      mode: createDailyGpChallengeMode(challenge.id),
      best_time_ms: nextBestTimeMs,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'player_id,track_key,mode',
    });

  if (error) {
    return {
      status: 500,
      body: {
        accepted: false,
        error: error.message,
      },
    };
  }

  return {
    status: 200,
    body: {
      accepted: true,
      bestTimeMs: nextBestTimeMs,
      completedLaps: strictReplayPassed ? strictReplayOutcome.run.completedLaps : null,
      checkpointTimesSec: normalizedCheckpointTimesSec,
      validationMethod,
      strictReplayFailureReason,
    },
  };
}

export function getServerDailyGpChallengeForTrack(trackKey?: string | null): DailyGpChallenge | null {
  if (typeof trackKey !== 'string' || !trackKey) {
    return null;
  }

  const activeChallenge = buildDailyGpChallenge();
  if (activeChallenge.trackKey === trackKey) {
    return activeChallenge;
  }

  return buildDailyGpPlaylist().find((entry) => entry.trackKey === trackKey) || null;
}
