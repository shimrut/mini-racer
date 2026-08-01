/**
 * Picks a rival off a leaderboard and hands back their ghost, shared across
 * modes (Daily and Campaign previously kept identical copies). A `row`
 * selection must still match its named standings row exactly — a board that
 * moved under the player is refused rather than silently racing someone
 * else. A `next-faster` selection walks up to the closest rival above them.
 */
import { redis } from '@devvit/redis';
import type { Competition } from './competition.js';
import {
    isCompleteOpponentRecord,
    readEntryByPlayerId,
} from './competition-leaderboard.js';
import { readPlayerProfileMap } from './competition-identity.js';
import { getPlayerTrackPbRecord } from './pb-ghost-store.js';
import { resolveLeaderboardDisplayName } from '../../game/shared/leaderboard-identity.js';
import { TRACKS } from '../../game/track/tracks.js';

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

export async function prepareCompetitionOpponentRace({
    competition,
    playerId,
    race,
    selection: rawSelection,
}: {
    competition: Competition;
    playerId: string | null;
    /** Echoed back to the client as the race to start. */
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

    const leaderboardKey = competition.leaderboardKey;
    let rankedCandidates: Array<{ member: string; rank: number }> = [];
    let benchmarkTimeMs: number | undefined;
    if (selection.kind === 'row') {
        const ranked = await redis.zRange(leaderboardKey, selection.rank - 1, selection.rank - 1);
        rankedCandidates = ranked.map((row) => ({ member: row.member, rank: selection.rank }));
    } else {
        const ownRankZeroBased = await redis.zRank(leaderboardKey, playerId);
        const ownEntry = await readEntryByPlayerId(competition, playerId);
        benchmarkTimeMs = ownEntry?.bestTimeMs ?? selection.benchmarkTimeMs;
        if (!Number.isFinite(benchmarkTimeMs)) {
            return { status: 409, body: { error: 'Set a time before choosing the next opponent.', reason: 'benchmark_required' } };
        }
        const totalCount = await redis.zCard(leaderboardKey);
        const stop = Number.isFinite(ownRankZeroBased)
            ? Number(ownRankZeroBased) - 1
            : totalCount - 1;
        const ranked = stop >= 0 ? await redis.zRange(leaderboardKey, 0, stop) : [];
        rankedCandidates = ranked
            .map((row, index) => ({ member: row.member, rank: index + 1 }))
            .reverse();
    }

    for (const candidate of rankedCandidates) {
        if (candidate.member === playerId) {
            if (selection.kind === 'row') {
                return { status: 409, body: { error: 'Choose another player to race.', reason: 'self_selection' } };
            }
            continue;
        }
        const entry = await readEntryByPlayerId(competition, candidate.member);
        if (!entry) continue;
        if (selection.kind === 'next-faster' && (!benchmarkTimeMs || entry.bestTimeMs >= benchmarkTimeMs)) {
            continue;
        }
        const displayName = await readDisplayName(candidate.member);
        if (
            selection.kind === 'row'
            && (
                displayName !== selection.displayName
                || entry.bestTimeMs !== selection.bestTimeMs
                || entry.updatedAt !== selection.updatedAt
            )
        ) {
            return { status: 409, body: { error: 'Leaderboard row changed. Refresh and choose again.', reason: 'selection_changed' } };
        }
        const record = await getPlayerTrackPbRecord({
            playerId: candidate.member,
            competition,
            track: TRACKS[competition.trackKey],
        });
        if (!isCompleteOpponentRecord(entry, record, competition)) {
            if (selection.kind === 'row') {
                return { status: 409, body: { error: 'That opponent ghost is unavailable.', reason: 'ghost_unavailable' } };
            }
            continue;
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
    return { status: 404, body: { error: 'No faster opponent ghost is available.', reason: 'no_faster_opponent' } };
}
