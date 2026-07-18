import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildModalDeltaDisplay,
    buildModalStatsPlan,
    buildScoreboardRankDisplay,
    getCombinedRankNumber,
    isNewBestResult,
} from '../game/race/result-flow.js';

describe('result-flow wave 2', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('treats tiny positive deltas as zero', () => {
        expect(buildModalDeltaDisplay({ deltaToBest: 0.004 })).toEqual({
            text: '0.00s',
            valueClass: '',
        });
        expect(buildModalDeltaDisplay({ deltaToBest: 0.006 })).toEqual({
            text: '+0.01s',
            valueClass: 'modal-stat-value--delta-positive',
        });
    });

    it('uses custom empty delta text and class', () => {
        expect(buildModalDeltaDisplay({
            emptyText: 'n/a',
            emptyValueClass: 'muted',
        })).toEqual({
            text: 'n/a',
            valueClass: 'muted',
        });
    });

    it('parses combined rank numbers from labels and current player rows', () => {
        expect(getCombinedRankNumber({
            isLoading: false,
            playerRank: 4,
        })).toBe(4);
        expect(getCombinedRankNumber({
            isLoading: false,
            currentPlayerRow: { rank: 7 },
        })).toBe(7);
        expect(getCombinedRankNumber({
            isLoading: false,
            playerRankLabel: '#12',
        })).toBe(12);
        expect(getCombinedRankNumber({
            isLoading: true,
            playerRank: 2,
        })).toBeNull();
    });

    it('labels pending, retrying, and submitting verification stages distinctly', () => {
        expect(buildScoreboardRankDisplay({
            playerRankLabel: '#3',
            submissionStage: 'pending',
        }).labelText).toBe('Rank pending');
        expect(buildScoreboardRankDisplay({
            playerRankLabel: '#3',
            statusText: 'Queued for retry',
        }).labelText).toBe('Retrying rank');
        expect(buildScoreboardRankDisplay({
            playerRankLabel: '#3',
            submissionStage: 'submitting',
        }).labelText).toBe('Submitting rank');
    });

    it('hides daily-pause stats and empty-run plans', () => {
        expect(buildModalStatsPlan({ variant: 'daily-pause' })).toEqual({
            kind: 'hide',
            display: 'none',
            hasRuns: null,
            args: [],
            rankSnapshot: null,
        });
        expect(buildModalStatsPlan(null)).toBeNull();
    });

    it('rejects equal-time bests and non-finite candidate times', () => {
        const policy = { bestResultComparator: 'time' };

        expect(isNewBestResult(policy, { bestTime: 20 }, { bestTime: 20 })).toBe(false);
        expect(isNewBestResult(policy, { bestTime: Number.POSITIVE_INFINITY }, { bestTime: 30 })).toBe(false);
        expect(isNewBestResult(policy, { bestTime: 19.9 }, { bestTime: 20 })).toBe(true);
    });
});
