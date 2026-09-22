import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildModalDeltaDisplay,
    buildScoreboardRankDisplay,
    isNewBestResult,
} from '../game/race/result-flow.js';

describe('result-flow wave 2', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('treats sub-millisecond positive deltas as zero', () => {
        expect(buildModalDeltaDisplay({ deltaToBest: 0.0004 })).toEqual({
            text: '0.000s',
            valueClass: '',
        });
        expect(buildModalDeltaDisplay({ deltaToBest: 0.0006 })).toEqual({
            text: '+0.001s',
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

    it('rejects equal-time bests and non-finite candidate times', () => {
        const policy = { bestResultComparator: 'time' };

        expect(isNewBestResult(policy, { bestTime: 20 }, { bestTime: 20 })).toBe(false);
        expect(isNewBestResult(policy, { bestTime: Number.POSITIVE_INFINITY }, { bestTime: 30 })).toBe(false);
        expect(isNewBestResult(policy, { bestTime: 19.9 }, { bestTime: 20 })).toBe(true);
    });
});
