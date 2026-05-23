import { describe, expect, it, vi } from 'vitest';
import { DailyChallengeUi } from '../game/daily-challenge/ui.js?v=1.91';

describe('ui daily challenge helpers', () => {
    it('sets leaderboard menu aria-label without rank details', () => {
        const originalDocument = global.document;
        const dailyChallengeRankBtn = {
            disabled: false,
            dataset: { rank: '3' },
            setAttribute: vi.fn()
        };
        global.document = {
            getElementById: (id) => ({
                'daily-challenge-rank-btn': dailyChallengeRankBtn
            }[id] || null),
            querySelector: vi.fn(() => null),
            createElement: vi.fn(() => ({
                className: '',
                textContent: '',
                dataset: {},
                setAttribute: vi.fn()
            }))
        };

        const component = new DailyChallengeUi();
        component.setDailyChallengeSummary({
            available: true,
            trackName: 'Desert Sprint',
            scoreboardSnapshot: { rank: 3, playerRankLabel: '#3' }
        });

        expect(dailyChallengeRankBtn.dataset.rank).toBeUndefined();
        expect(dailyChallengeRankBtn.setAttribute).toHaveBeenCalledWith(
            'aria-label',
            'Open leaderboard for Desert Sprint.'
        );

        global.document = originalDocument;
    });

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
                    nextAttemptAt: Date.now(),
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
            verifiedBestLabel: '15.00s',
            verifiedRankLabel: '#12',
            verifiedScoreboardSnapshot: { playerRankLabel: '#12' }
        };
        vi.spyOn(component, 'setDailyChallengeSummary').mockImplementation(() => {});
        
        component.refreshDailyChallengeVerificationState();

        expect(component.setDailyChallengeSummary).toHaveBeenCalledWith(expect.objectContaining({
            challengeId: 'challenge-1',
            bestTime: 12.34,
            bestLabel: '12.34s',
            rankLabel: '#12'
        }));

        global.document = originalDocument;
        global.window = originalWindow;
    });

    it('shows best-race wording for multi-lap summaries', () => {
        const originalDocument = global.document;
        const nodes = {
            'daily-challenge-title': { textContent: '' },
            'daily-challenge-track': { textContent: '', style: {} },
            'daily-challenge-objective': { textContent: '', style: {} },
            'daily-challenge-modifiers': {
                children: [],
                style: {},
                replaceChildren() {
                    this.children = [];
                },
                appendChild(node) {
                    this.children.push(node);
                }
            },
            'daily-challenge-best-label': { textContent: '' },
            'daily-challenge-best': { textContent: '' },
            'daily-challenge-rank-btn': { disabled: false, dataset: {}, setAttribute: vi.fn(), querySelector: vi.fn(() => null) },
            'daily-challenge-start-btn': { disabled: false },
            'daily-challenge-reset': { textContent: '' },
            'daily-challenge-car-name': { textContent: '' },
            'daily-challenge-car-image': { src: '' }
        };
        global.document = {
            getElementById: (id) => nodes[id] || null,
            querySelector: vi.fn(() => null),
            createElement: vi.fn(() => ({
                className: '',
                textContent: '',
                dataset: {},
                setAttribute: vi.fn()
            }))
        };
        const component = new DailyChallengeUi();
        vi.spyOn(component, 'updateDailyChallengeCountdown').mockImplementation(() => {});
        component.setDailyChallengeSummary({
            available: true,
            objectiveType: 'multi_lap_total',
            objectiveLabel: '2 laps',
            bestLabel: '48.35s'
        });

        expect(nodes['daily-challenge-title'].textContent).toBe('Daily challenge');
        expect(nodes['daily-challenge-track'].textContent).toBe("Beat today's challenge and climb the leaderboard.");
        expect(nodes['daily-challenge-objective'].textContent).toBe('2 laps');
        expect(nodes['daily-challenge-best-label'].textContent).toBe('Best Race');
        expect(nodes['daily-challenge-car-name'].textContent).toBe('2 laps');
        expect(nodes['daily-challenge-car-image'].src).toBe('assets/cars/mr_mr_red.webp');
        expect(nodes['daily-challenge-modifiers'].children.map((node) => node.textContent)).toEqual([
            'Verified runs',
            'UTC reset'
        ]);

        global.document = originalDocument;
    });

    it('updates the countdown label and daily challenge hud state', () => {
        const originalDocument = global.document;
        const originalDateNow = Date.now;
        Date.now = () => Date.parse('2026-05-02T10:00:00.000Z');

        const dailyChallengeReset = { textContent: '' };
        const progressNode = { textContent: '' };
        const dailyChallengeHudInline = {
            hidden: false,
            querySelector: vi.fn(() => progressNode)
        };
        const hudLapCluster = {
            classList: {
                toggle: vi.fn()
            }
        };
        global.document = {
            getElementById: (id) => ({
                'daily-challenge-reset': dailyChallengeReset,
                'daily-challenge-hud-inline': dailyChallengeHudInline
            }[id] || null),
            querySelector: vi.fn((selector) =>
                selector === '.hud-lap-cluster' ? hudLapCluster : null
            )
        };
        const component = new DailyChallengeUi();
        component._dailyChallengeSummary = {
            available: true,
            endsAt: '2026-05-02T11:15:00.000Z'
        };
        component.updateDailyChallengeCountdown();
        expect(dailyChallengeReset.textContent).toBe('1h 15m');

        const component2 = new DailyChallengeUi();
        component2.setDailyChallengeHud({ visible: true, progressText: '2 / 3 laps' });

        expect(dailyChallengeHudInline.hidden).toBe(false);
        expect(progressNode.textContent).toBe('2 / 3 laps');
        expect(hudLapCluster.classList.toggle).toHaveBeenCalledWith('hud-lap-cluster--daily-active', true);

        global.document = originalDocument;
        Date.now = originalDateNow;
    });
});
