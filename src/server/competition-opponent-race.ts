import { redis } from '@devvit/redis';
import type { Competition } from './competition.js';
import {
    isCompleteOpponentRecord,
    parseStoredEntry,
    readEntryByPlayerId,
    readPlayerRank,
} from './competition-leaderboard.js';
import { readPlayerProfileMap } from './competition-identity.js';
import { getPlayerTrackPbRecord, getPlayerTrackPbRecords } from './pb-ghost-store.js';
import { resolveLeaderboardDisplayName } from '../../game/shared/leaderboard-identity.js';
import { TRACKS } from '../../game/track/tracks.js';

const OPPONENT_WINDOW_SIZE = 10;
const OPPONENT_WINDOW_LIMIT = 6;

export type OpponentRowSelection = {
    kind: 'row';
    rank: number;
    displayName: string;
    bestTimeMs: number;
    updatedAt: string;
};

export type NextFasterSelection = {
    kind: 'next-faster';
    benchmarkTimeMs?: number;
};

export type OpponentSelection = OpponentRowSelection | NextFasterSelection;

export function normalizeOpponentSelection(value: unknown): OpponentSelection | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const selection = value as Record<string, unknown>;
    if (selection.kind === 'row') {
        if (
            !Number.isInteger(selection.rank)
            || Number(selection.rank) < 1
            || typeof selection.displayName !== 'string'
            || !selection.displayName
            || !Number.isSafeInteger(selection.bestTimeMs)
            || Number(selection.bestTimeMs) <= 0
            || typeof selection.updatedAt !== 'string'
            || !selection.updatedAt
        ) return null;
        return {
            kind: 'row',
            rank: Number(selection.rank),
            displayName: selection.displayName,
            bestTimeMs: Number(selection.bestTimeMs),
            updatedAt: selection.updatedAt,
        };
    }
    if (selection.kind === 'next-faster') {
        const benchmarkTimeMs = Number(selection.benchmarkTimeMs);
        return {
            kind: 'next-faster',
            benchmarkTimeMs: Number.isSafeInteger(benchmarkTimeMs) && benchmarkTimeMs > 0
                ? benchmarkTimeMs
                : undefined,
        };
    }
    return null;
}

async function readDisplayName(playerId: string): Promise<string> {
    const profileMap = await readPlayerProfileMap([playerId]);
    return resolveLeaderboardDisplayName({
        playerId,
        preference: profileMap.get(playerId)?.leaderboardIdentity,
        redditUsername: profileMap.get(playerId)?.redditUsername,
    });
}

function noFasterOpponent() {
    return { status: 404, body: { error: 'No faster opponent ghost is available.', reason: 'no_faster_opponent' } };
}

export async function prepareCompetitionOpponentRace({
    competition,
    playerId,
    race,
    selection: rawSelection,
}: {
    competition: Competition;
    playerId: string | null;
    race: unknown;
    selection?: unknown;
}) {
    if (!playerId) {
        return {
            status: 401,
            body: { error: 'Player identity is required to race an opponent.', reason: 'identity_required' },
        };
    }
    const selection = normalizeOpponentSelection(rawSelection);
    if (!selection) {
        return { status: 400, body: { error: 'Opponent selection is invalid.', reason: 'invalid_selection' } };
    }

    if (selection.kind === 'row') {
        return prepareRowOpponentRace({
            competition,
            playerId,
            race,
            selection,
        });
    }
    return prepareNextFasterOpponentRace({
        competition,
        playerId,
        race,
        selection,
    });
}

async function prepareRowOpponentRace({
    competition,
    playerId,
    race,
    selection,
}: {
    competition: Competition;
    playerId: string;
    race: unknown;
    selection: OpponentRowSelection;
}) {
    const ranked = await redis.zRange(
        competition.leaderboardKey,
        selection.rank - 1,
        selection.rank - 1,
    );
    const rankedCandidates = ranked.map((row) => ({ member: row.member, rank: selection.rank }));

    for (const candidate of rankedCandidates) {
        if (candidate.member === playerId) {
            return { status: 409, body: { error: 'Choose another player to race.', reason: 'self_selection' } };
        }
        const entry = await readEntryByPlayerId(competition, candidate.member);
        if (!entry) continue;
        const displayName = await readDisplayName(candidate.member);
        if (
            displayName !== selection.displayName
            || entry.bestTimeMs !== selection.bestTimeMs
            || entry.updatedAt !== selection.updatedAt
        ) {
            return { status: 409, body: { error: 'Leaderboard row changed. Refresh and choose again.', reason: 'selection_changed' } };
        }
        const record = await getPlayerTrackPbRecord({
            playerId: candidate.member,
            competition,
            track: TRACKS[competition.trackKey],
        });
        if (!isCompleteOpponentRecord(entry, record, competition)) {
            return { status: 409, body: { error: 'That opponent ghost is unavailable.', reason: 'ghost_unavailable' } };
        }
        return {
            status: 200,
            body: {
                mode: competition.mode,
                race,
                target: {
                    rank: candidate.rank,
                    displayName,
                    bestTimeMs: entry.bestTimeMs,
                    checkpointTimesSec: record!.checkpointTimesSec,
                    lapCompletionTimesSec: record!.lapCompletionTimesSec,
                    updatedAt: entry.updatedAt,
                    ghost: record!.ghost,
                },
            },
        };
    }
    return noFasterOpponent();
}

async function prepareNextFasterOpponentRace({
    competition,
    playerId,
    race,
    selection,
}: {
    competition: Competition;
    playerId: string;
    race: unknown;
    selection: NextFasterSelection;
}) {
    const ownEntry = await readEntryByPlayerId(competition, playerId);
    const benchmarkTimeMs = ownEntry?.bestTimeMs ?? selection.benchmarkTimeMs;
    if (!Number.isFinite(benchmarkTimeMs) || !benchmarkTimeMs) {
        return { status: 409, body: { error: 'Set a time before choosing the next opponent.', reason: 'benchmark_required' } };
    }

    const track = TRACKS[competition.trackKey];
    let fullWindows = 0;

    for (let window = 0; window < OPPONENT_WINDOW_LIMIT; window += 1) {
        // Devvit keeps start as the low bound and stop as the high bound.
        // reverse only turns the answer around. High-then-low returns nothing.
        const ranked = await redis.zRange(
            competition.leaderboardKey,
            0,
            benchmarkTimeMs - 1,
            {
                by: 'score',
                reverse: true,
                limit: { offset: window * OPPONENT_WINDOW_SIZE, count: OPPONENT_WINDOW_SIZE },
            },
        );
        if (!ranked.length) break;

        if (ranked.length === OPPONENT_WINDOW_SIZE) fullWindows += 1;

        const members = ranked.map((row) => row.member);
        const rawEntries = await redis.hMGet(competition.entryHashKey, members);
        const pbRecords = await getPlayerTrackPbRecords({
            playerIds: members,
            competition,
            track,
        });

        for (let index = 0; index < ranked.length; index += 1) {
            const member = ranked[index].member;
            if (member === playerId) continue;
            const entry = parseStoredEntry(rawEntries[index], competition.trackKey);
            if (!entry) continue;
            if (entry.bestTimeMs >= benchmarkTimeMs) continue;
            const record = pbRecords.get(member) ?? null;
            if (!isCompleteOpponentRecord(entry, record, competition)) continue;

            const displayName = await readDisplayName(member);
            const rank = await readPlayerRank(competition, member);
            return {
                status: 200,
                body: {
                    mode: competition.mode,
                    race,
                    target: {
                        rank,
                        displayName,
                        bestTimeMs: entry.bestTimeMs,
                        checkpointTimesSec: record!.checkpointTimesSec,
                        lapCompletionTimesSec: record!.lapCompletionTimesSec,
                        updatedAt: entry.updatedAt,
                        ghost: record!.ghost,
                    },
                },
            };
        }

        if (ranked.length < OPPONENT_WINDOW_SIZE) break;
    }

    if (fullWindows === OPPONENT_WINDOW_LIMIT) {
        console.info('Next-rival lookup reached the 60-rival cap with no raceable opponent.');
    }
    return noFasterOpponent();
}
