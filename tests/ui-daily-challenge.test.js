import { describe, expect, it, vi } from 'vitest';
import { DailyChallengeUi } from '../game/daily-challenge/ui.js';

describe('ui daily challenge helpers', () => {
    it('overlays pending verification onto the current summary', () => {
        const originalDocument = global.document;
        const originalWindow = global.window;
        const queueState = JSON.stringify({
            scoreboard: {},
            daily: {
                'challenge-1': {
                    challengeId: 'challenge-1',
                    bestTime: 12.34,
                    completedLaps: null,
                    replay: { frames: [] },
                    verificationState: 'pending',
                    submissionStage: 'retrying',
                    statusText: 'Retrying...',
                    nextAttemptAt: Date.now(),
                    expiresAt: '2099-01-01T00:00:00.000Z',
                    updatedAt: '2026-04-17T15:00:00.000Z'
                }
            }
        });
        global.window = {
            localStorage: {
                getItem: (key) => key === 'VectorGpVerificationQueue' ? queueState : null,
                setItem: vi.fn()
            }
        };
        global.document = {
            getElementById: vi.fn(() => null),
            querySelector: vi.fn(() => null),
            createElement: vi.fn(() => ({
                className: '',
                textContent: '',
                dataset: {},
                setAttribute: vi.fn()
            }))
        };
        const component = new DailyChallengeUi();
        component._dailyChallengeSummary = {
            available: true,
            challengeId: 'challenge-1',
            objectiveType: 'fastest_lap',
            bestTime: 15,
            bestLabel: '15.00s',
            rankLabel: '#12',
            scoreboardSnapshot: { playerRankLabel: '#12' },
            verifiedBestTime: 15,
            verifiedBestLabel: '15.000s',
            verifiedRankLabel: '#12',
            verifiedScoreboardSnapshot: { playerRankLabel: '#12' }
        };
        vi.spyOn(component, 'setDailyChallengeSummary').mockImplementation(() => {});

        component.refreshDailyChallengeVerificationState();

        expect(component.setDailyChallengeSummary).toHaveBeenCalledWith(expect.objectContaining({
            challengeId: 'challenge-1',
            bestTime: 12.34,
            bestLabel: '12.340s',
            rankLabel: '#12',
            scoreboardSnapshot: expect.objectContaining({
                verificationState: 'pending',
                submissionStage: 'retrying',
                statusText: 'Retrying...',
                isLoading: true,
                playerRankLabel: null
            })
        }));

        global.document = originalDocument;
        global.window = originalWindow;
    });

    it('overlays submission errors onto the current summary', () => {
        const originalDocument = global.document;
        const originalWindow = global.window;
        const queueState = JSON.stringify({
            scoreboard: {},
            daily: {
                'challenge-error': {
                    challengeId: 'challenge-error',
                    bestTime: 11.9,
                    completedLaps: null,
                    replay: { frames: [] },
                    verificationState: 'error',
                    submissionStage: 'error',
                    statusText: 'Daily challenge is no longer playable.',
                    nextAttemptAt: null,
                    expiresAt: '2099-01-01T00:00:00.000Z',
                    updatedAt: '2026-04-17T16:00:00.000Z'
                }
            }
        });
        global.window = {
            localStorage: {
                getItem: (key) => key === 'VectorGpVerificationQueue' ? queueState : null,
                setItem: vi.fn()
            }
        };
        global.document = {
            getElementById: vi.fn(() => null),
            querySelector: vi.fn(() => null),
            createElement: vi.fn(() => ({
                className: '',
                textContent: '',
                dataset: {},
                setAttribute: vi.fn()
            }))
        };
        const component = new DailyChallengeUi();
        component._dailyChallengeSummary = {
            available: true,
            challengeId: 'challenge-error',
            objectiveType: 'fastest_lap',
            bestTime: 15,
            bestLabel: '15.00s',
            rankLabel: '#12',
            scoreboardSnapshot: { playerRankLabel: '#12' },
            verifiedBestTime: 15,
            verifiedBestLabel: '15.000s',
            verifiedRankLabel: '#12',
            verifiedScoreboardSnapshot: { playerRankLabel: '#12' }
        };
        vi.spyOn(component, 'setDailyChallengeSummary').mockImplementation(() => {});

        component.refreshDailyChallengeVerificationState();

        expect(component.setDailyChallengeSummary).toHaveBeenCalledWith(expect.objectContaining({
            challengeId: 'challenge-error',
            bestTime: 11.9,
            bestLabel: '11.900s',
            scoreboardSnapshot: expect.objectContaining({
                verificationState: 'error',
                submissionStage: 'error',
                statusText: 'Daily challenge is no longer playable.',
                isLoading: false,
                playerRankLabel: null
            })
        }));

        global.document = originalDocument;
        global.window = originalWindow;
    });

    it('shows lap progress without a laps label', () => {
        const originalDocument = global.document;
        const progressNode = { textContent: '' };
        const dailyChallengeHudInline = {
            hidden: true,
            querySelector: vi.fn((selector) => (
                selector === '.daily-challenge-hud__progress' ? progressNode : null
            )),
        };
        global.document = {
            getElementById: (id) => (
                id === 'daily-challenge-hud-inline' ? dailyChallengeHudInline : null
            ),
        };
        const component = new DailyChallengeUi();
        component.setDailyChallengeHud({ visible: true, progressText: '1 / 2' });

        expect(dailyChallengeHudInline.hidden).toBe(false);
        expect(progressNode.textContent).toBe('1 / 2');

        global.document = originalDocument;
    });
});
