import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const campaignServiceMocks = vi.hoisted(() => ({
    getCampaignBootstrap: vi.fn(),
    getCampaignChallenge: vi.fn(),
    getCampaignPbGhost: vi.fn(),
    getCampaignSnapshot: vi.fn(),
    deriveCampaignProgress: vi.fn(() => ({
        campaignId: 'numbered-v1',
        startedAt: null,
        resultsByRaceId: {},
        unlockedRaceIds: ['numbered-v1-00'],
        complete: false,
        continueRaceId: 'numbered-v1-00',
    })),
    startServerCampaignRace: vi.fn(),
    submitCampaignChallengeRun: vi.fn(),
    submitCampaignRun: vi.fn(),
}));

vi.mock('../game/campaign/service.js', () => ({
    createCampaignChallenge: vi.fn(),
    getCampaignBootstrap: campaignServiceMocks.getCampaignBootstrap,
    getCampaignChallenge: campaignServiceMocks.getCampaignChallenge,
    getCampaignPbGhost: campaignServiceMocks.getCampaignPbGhost,
    getCampaignSnapshot: campaignServiceMocks.getCampaignSnapshot,
    previewCampaignChallenge: vi.fn(),
    deriveCampaignProgress: campaignServiceMocks.deriveCampaignProgress,
    startServerCampaignRace: campaignServiceMocks.startServerCampaignRace,
    submitCampaignChallengeRun: campaignServiceMocks.submitCampaignChallengeRun,
    submitCampaignRun: campaignServiceMocks.submitCampaignRun,
}));

import {
    buildCampaignLeaderboardOptions,
    campaignEngineMethods,
    normalizeCampaignLeaderboardSnapshot,
} from '../game/campaign/engine-methods.js';
import { DailyChallengeUi } from '../game/daily-challenge/ui.js';
import { LobbyUi } from '../game/lobby/ui.js';
import { GarageUi } from '../game/settings/garage-ui.js';

function createClassList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        contains: (name) => values.has(name),
        toggle: (name, force) => {
            const shouldAdd = force === undefined ? !values.has(name) : Boolean(force);
            if (shouldAdd) values.add(name);
            else values.delete(name);
            return shouldAdd;
        },
    };
}

function createElement(tagName = 'div') {
    const listeners = new Map();
    const element = {
        tagName,
        children: [],
        className: '',
        classList: createClassList(),
        dataset: {},
        disabled: false,
        hidden: false,
        textContent: '',
        listeners,
        addEventListener: vi.fn((name, handler) => listeners.set(name, handler)),
        append(...children) {
            this.children.push(...children);
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        replaceChildren(...children) {
            this.children = children;
        },
        setAttribute: vi.fn(),
        toggleAttribute: vi.fn(),
        querySelector(selector) {
            if (selector === '.main-menu__label') {
                return this.children.find((child) => child.className === 'main-menu__label') || null;
            }
            if (selector === '.main-menu__spinner' || selector === '.modal-rank-spinner') {
                return this.children.find((child) => String(child.className).includes('spinner')) || null;
            }
            return null;
        },
        remove() {
            // no-op for detached spinner stubs
        },
    };
    return element;
}

function campaignDocument(list) {
    return {
        getElementById: (id) => (id === 'daily-playlist-list' ? list : null),
        createElement,
        createElementNS: (_namespace, tagName) => createElement(tagName),
    };
}

function findByClass(parent, className) {
    return parent?.children?.find((child) => String(child.className).split(' ').includes(className));
}

function textOf(parent, className) {
    return findByClass(parent, className)?.textContent;
}

function heroBody(board) {
    return findByClass(findByClass(board, 'campaign-hero'), 'campaign-hero__body');
}

function campaignState() {
    return {
        progressLabel: '1 / 3 Gold',
        complete: false,
        nextStage: { id: 'numbered-v1-01' },
        stages: [
            {
                id: 'numbered-v1-00',
                index: 0,
                numberLabel: '00',
                trackName: 'Number Zero',
                laps: 1,
                unlocked: true,
                bestTimeLabel: '0:06.200',
                medal: 'Gold',
                needsAuthor: true,
                authorTargetLabel: '0:06.100',
                authorGapLabel: '+0.100',
            },
            {
                id: 'numbered-v1-01',
                index: 1,
                numberLabel: '01',
                trackName: 'Number One',
                laps: 1,
                unlocked: true,
                bestTimeLabel: '0:09.800',
                medal: 'Silver',
                isNext: true,
                needsGold: true,
                goldTargetLabel: '0:09.520',
                goldGapLabel: '+0.280',
            },
            {
                id: 'numbered-v1-02',
                index: 2,
                numberLabel: '02',
                trackName: 'Number Two',
                laps: 1,
                unlocked: false,
                bestTimeLabel: 'No time',
                medal: null,
                unlock: { type: 'medal_on_race', raceId: 'numbered-v1-01', minimumMedal: 'gold' },
                unlockRequirementLabel: 'Gold on Number One to unlock',
            },
        ],
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    campaignServiceMocks.getCampaignBootstrap.mockReset();
    campaignServiceMocks.getCampaignChallenge.mockReset();
    campaignServiceMocks.getCampaignPbGhost.mockReset();
    campaignServiceMocks.getCampaignSnapshot.mockReset();
    campaignServiceMocks.deriveCampaignProgress.mockReset();
    campaignServiceMocks.deriveCampaignProgress.mockReturnValue({
        campaignId: 'numbered-v1',
        startedAt: null,
        resultsByRaceId: {},
        unlockedRaceIds: ['numbered-v1-00'],
        complete: false,
        continueRaceId: 'numbered-v1-00',
    });
    campaignServiceMocks.startServerCampaignRace.mockReset();
    campaignServiceMocks.submitCampaignChallengeRun.mockReset();
    campaignServiceMocks.submitCampaignRun.mockReset();
});

describe('Campaign lobby and shared modal adapters', () => {
    function createCampaignFinishContext(overrides = {}) {
        const modalMsg = { style: {}, textContent: '' };
        return {
            ...campaignEngineMethods,
            activeCampaignStage: {
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                lapCount: 1,
                rulesRevision: 1,
            },
            currentChallengeRun: {},
            currentTime: 8.25,
            bestLapTime: null,
            campaignBootstrap: { ranked: true,
            signedIn: true, progress: {} },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: {
                overflowed: false,
                getPayload: vi.fn(() => ({ revision: 1, segments: [] })),
            },
            rankedSubmissionBlockedReason: null,
            getInvalidWinDataReason: vi.fn(() => null),
            pbGhost: { prepare: vi.fn() },
            trackPersonalBestByTrackKey: {},
            hud: {
                setPauseVisible: vi.fn(),
                setHudPersonalBestsOpenAllowed: vi.fn(),
            },
            loadCampaignLobby: vi.fn().mockResolvedValue({}),
            processVerificationQueue: vi.fn(),
            scheduleVerificationQueueProcessing: vi.fn(),
            modal: {
                modalMsg,
                showModal: vi.fn(),
                updateModalScoreboardSnapshot: vi.fn(),
                matchesModalScoreboardContext: vi.fn(() => true),
                setCombinedWinMedal: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
            ...overrides,
        };
    }

    it('still awards the medal and queues the run when the bootstrap never answered', () => {
        // An unreachable bootstrap reports nothing rankable. That says nothing
        // about this run: the medal comes from the track's own table, and the
        // durable queue is what a dropped connection is for.
        const context = createCampaignFinishContext({
            campaignBootstrap: { ranked: false, signedIn: false, progress: {} },
        });

        context.handleCampaignWin({ lapTime: 7.3 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                lapMedal: 'silver',
                scoreboardSnapshot: expect.objectContaining({
                    submissionStage: 'submitting',
                }),
            }),
            expect.anything(),
        );
        expect(context.processVerificationQueue).toHaveBeenCalled();
    });

    it('opens the finish modal once and queues the run before submission settles', async () => {
        const context = createCampaignFinishContext();

        context.handleCampaignWin({ lapTime: 8.25 });

        expect(context.status).toBe('won');
        expect(context.modal.showModal).toHaveBeenCalledTimes(1);
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                lapTime: 8.25,
                scoreboardSnapshot: expect.objectContaining({
                    isLoading: true,
                    submissionStage: 'submitting',
                }),
            }),
            expect.objectContaining({
                modalKind: 'win',
                shareRequest: {
                    kind: 'campaign-challenge',
                    source: 'campaign',
                    raceId: 'numbered-v1-00',
                },
            }),
        );
        expect(context.modal.modalMsg.textContent).toBe('Number Zero · 1 lap');
        // The queue owns the submission now, so the finish path never calls it directly.
        expect(campaignServiceMocks.submitCampaignRun).not.toHaveBeenCalled();
        expect(context.processVerificationQueue).toHaveBeenCalled();
    });

    it.each([
        ['equal', 8],
        ['slower', 8.25],
    ])('does not verify an %s Campaign finish', (_case, finalTime) => {
        const configureLeaderboardOpponentFinish = vi.fn();
        const context = createCampaignFinishContext({
            campaignBootstrap: {
                ranked: true,
            signedIn: true,
                progress: {
                    resultsByRaceId: {
                        'numbered-v1-00': {
                            raceId: 'numbered-v1-00',
                            bestTimeMs: 8000,
                            medal: 'gold',
                        },
                    },
                },
                standingsByRaceId: {
                    'numbered-v1-00': {
                        rank: 12,
                        totalCount: 84,
                    },
                },
            },
            configureLeaderboardOpponentFinish,
        });

        context.handleCampaignWin({ lapTime: finalTime });

        expect(context.scoreboardReplay.getPayload).not.toHaveBeenCalled();
        expect(context.processVerificationQueue).not.toHaveBeenCalled();
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                lapTime: finalTime,
                scoreboardSnapshot: expect.objectContaining({
                    playerRank: 12,
                    playerRankLabel: '#12',
                    totalCount: 84,
                    currentPlayerRow: expect.objectContaining({
                        rank: 12,
                        bestTime: 8,
                    }),
                }),
            }),
            expect.objectContaining({
                shareRequest: {
                    kind: 'campaign-challenge',
                    source: 'campaign',
                    raceId: 'numbered-v1-00',
                },
            }),
        );
        expect(configureLeaderboardOpponentFinish).toHaveBeenCalledWith(
            expect.objectContaining({ waitForVerification: false }),
        );
    });

    it('still verifies a strictly faster Campaign finish', () => {
        const context = createCampaignFinishContext({
            campaignBootstrap: {
                ranked: true,
            signedIn: true,
                progress: {
                    resultsByRaceId: {
                        'numbered-v1-00': {
                            raceId: 'numbered-v1-00',
                            bestTimeMs: 8000,
                            medal: 'gold',
                        },
                    },
                },
            },
        });

        context.handleCampaignWin({ lapTime: 7.999 });

        expect(context.scoreboardReplay.getPayload).toHaveBeenCalledWith(1);
        expect(context.processVerificationQueue).toHaveBeenCalledTimes(1);
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                lapTime: 7.999,
                scoreboardSnapshot: expect.objectContaining({
                    submissionStage: 'submitting',
                }),
            }),
            expect.anything(),
        );
    });

    it('sends the finish rank tap to Campaign standings, not the Daily leaderboard', () => {
        const context = createCampaignFinishContext({
            openCampaignStandings: vi.fn(),
        });

        context.handleCampaignWin({ lapTime: 8.25 });

        const lapData = context.modal.showModal.mock.calls[0][2];
        expect(typeof lapData.onOpenStandings).toBe('function');
        lapData.onOpenStandings();
        expect(context.openCampaignStandings).toHaveBeenCalledWith(
            'numbered-v1-00',
            { returnMode: 'back' },
        );
    });

    it('rejects a finish that fails win validation without submitting or scoring it', () => {
        const context = createCampaignFinishContext({
            getInvalidWinDataReason: vi.fn(() => 'Checkpoint count did not match the loaded track.'),
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        context.handleCampaignWin({ lapTime: 8.25 });

        expect(context.status).toBe('ready');
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'RUN REJECTED',
            null,
            expect.not.objectContaining({ lapMedal: expect.anything() }),
            expect.objectContaining({ modalKind: 'rejected' }),
        );
        expect(context.modal.modalMsg.textContent).toBe(
            'Checkpoint count did not match the loaded track.',
        );
        expect(campaignServiceMocks.submitCampaignRun).not.toHaveBeenCalled();
        expect(context.processVerificationQueue).not.toHaveBeenCalled();
    });

    it('does not queue or score a run blocked by a timing anomaly', () => {
        const context = createCampaignFinishContext({
            rankedSubmissionBlockedReason:
                'Leaderboard rank disabled because the run had severe frame stalls.',
        });

        context.handleCampaignWin({ lapTime: 8.25 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                scoreboardSnapshot: expect.objectContaining({
                    verificationState: 'error',
                    statusText: 'Leaderboard rank disabled because the run had severe frame stalls.',
                }),
            }),
            expect.anything(),
        );
        expect(context.processVerificationQueue).not.toHaveBeenCalled();
    });

    it('reports an overflowed replay as too long rather than unverifiable', () => {
        const context = createCampaignFinishContext({
            scoreboardReplay: {
                overflowed: true,
                getPayload: vi.fn(() => null),
            },
        });

        context.handleCampaignWin({ lapTime: 41.5 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                scoreboardSnapshot: expect.objectContaining({
                    statusText: 'Run too long to rank.',
                }),
            }),
            expect.anything(),
        );
        expect(context.modal.modalMsg.textContent).toBe('Run too long to rank.');
        expect(context.processVerificationQueue).not.toHaveBeenCalled();
    });

    it('hands the finish sheet the medal this stage had banked before the run', () => {
        const context = createCampaignFinishContext({
            campaignBootstrap: {
                ranked: true,
            signedIn: true,
                progress: {
                    resultsByRaceId: {
                        'numbered-v1-00': { raceId: 'numbered-v1-00', bestTimeMs: 8000, medal: 'silver' },
                    },
                },
            },
        });

        context.handleCampaignWin({ lapTime: 8.25 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({ previousTrackMedal: 'silver' }),
            expect.anything(),
        );
    });

    it('reads the banked stage medal before this finish is verified', () => {
        const context = createCampaignFinishContext({
            campaignBootstrap: {
                ranked: true,
                signedIn: true,
                progress: {
                    resultsByRaceId: {
                        'numbered-v1-00': { raceId: 'numbered-v1-00', bestTimeMs: 8300, medal: 'bronze' },
                    },
                },
            },
        });
        // Verification writes this finish into progress, so a late read would
        // hand back this run's own medal and skip its celebration.

        context.handleCampaignWin({ lapTime: 8.25 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({ previousTrackMedal: 'bronze' }),
            expect.anything(),
        );
    });

    it('leaves the previous medal empty on a stage with nothing banked yet', () => {
        const context = createCampaignFinishContext();

        context.handleCampaignWin({ lapTime: 8.25 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({ previousTrackMedal: null }),
            expect.anything(),
        );
    });

    it('keeps medal-free Campaign PB pace frozen through finish and late refreshes', () => {
        const context = createCampaignFinishContext({
            activeDailyChallenge: { id: 'numbered-v1-00', trackKey: 'numberZero' },
            getLapCheckpointTimesSec: vi.fn(() => [3.9, 7.8]),
            getActiveRacePaceBaseline() {
                return this.activePersonalBestPaceBaseline;
            },
        });
        const stage = context.activeCampaignStage;

        context.applyCampaignPersonalBest(stage, {
            bestTimeMs: 8_000,
            medal: null,
            checkpointTimesSec: [4, 7.9],
            lapCompletionTimesSec: [8],
            ghost: null,
        });
        context.activePersonalBestPaceBaseline =
            context.personalBestPaceBaselineByRaceId[stage.raceId];

        // A verification/PB refresh after GO may prepare the next retry, but it
        // cannot rewrite the comparison already frozen for this run.
        context.applyCampaignPersonalBest(stage, {
            bestTimeMs: 7_500,
            medal: null,
            checkpointTimesSec: [3.7, 7.4],
            lapCompletionTimesSec: [7.5],
            ghost: null,
        });
        context.showCampaignFinish(stage, {
            finalTime: 8.25,
            medal: null,
        });

        expect(context.modal.showModal.mock.calls[0][2]).toMatchObject({
            bestTime: 8,
            previousPersonalBestSec: 8,
            deltaToPersonalBest: 0.25,
            lapCheckpointTimes: [3.9, 7.8],
            pbCheckpointTimes: [4, 7.9],
            pbFinishSec: 8,
        });
        expect(context.personalBestPaceBaselineByRaceId[stage.raceId].finishTimeSec)
            .toBe(7.5);
    });

    it('still shows the accepted result when PB ghost and lobby refreshes fail', async () => {
        const context = createCampaignFinishContext();
        campaignServiceMocks.submitCampaignRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                progress: { unlockedRaceIds: ['numbered-v1-00'] },
            },
        });
        campaignServiceMocks.getCampaignSnapshot.mockResolvedValue({
            ok: true,
            body: {
                topRows: [{ rank: 1, displayName: 'You', bestTimeMs: 8250, bestTime: 8.25, isCurrentPlayer: true }],
                currentPlayerRow: {
                    rank: 1,
                    displayName: 'You',
                    bestTimeMs: 8250,
                    bestTime: 8.25,
                    isCurrentPlayer: true,
                },
                totalCount: 3,
                leaderboardEntryCount: 3,
                playerRank: 1,
                playerRankLabel: '#1',
                pageOffset: 0,
                pageLimit: 50,
                hasMore: false,
                nextOffset: null,
            },
        });
        campaignServiceMocks.getCampaignPbGhost.mockRejectedValue(new Error('ghost offline'));
        context.loadCampaignLobby.mockRejectedValue(new Error('bootstrap offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await context.processCampaignVerificationEntry({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime: 8.25,
            replay: { revision: 1, segments: [] },
        });

        expect(context.modal.updateModalScoreboardSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ playerRankLabel: '#1', totalCount: 3 }),
        );
        expect(context.campaignBootstrap.progress).toEqual({
            unlockedRaceIds: ['numbered-v1-00'],
        });
        // The already-open finish sheet is patched in place, never remounted.
        expect(context.modal.showModal).not.toHaveBeenCalled();
    });

    it('retries instead of stranding the run when confirmation fails', async () => {
        const context = createCampaignFinishContext();
        campaignServiceMocks.submitCampaignRun.mockRejectedValue(
            new Error('response interrupted'),
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await context.processCampaignVerificationEntry({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime: 8.25,
            replay: { revision: 1, segments: [] },
        });

        expect(context.modal.updateModalScoreboardSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({
                verificationState: 'pending',
                submissionStage: 'retrying',
                isLoading: true,
            }),
        );
        expect(context.modal.showModal).not.toHaveBeenCalled();
    });

    it('stops retrying a run the server refuses outright', async () => {
        const context = createCampaignFinishContext();
        campaignServiceMocks.submitCampaignRun.mockResolvedValue({
            ok: false,
            status: 422,
            body: { accepted: false, error: 'Campaign race was not completed.' },
        });

        await context.processCampaignVerificationEntry({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime: 8.25,
            replay: { revision: 1, segments: [] },
        });

        expect(context.modal.updateModalScoreboardSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({
                verificationState: 'error',
                statusText: 'Campaign race was not completed.',
            }),
        );
        // No progression was written, so the sheet must not still show a medal.
        expect(context.modal.setCombinedWinMedal).toHaveBeenCalledWith(null);
    });

    it('keeps the medal while a refused run is still being retried', async () => {
        const context = createCampaignFinishContext();
        campaignServiceMocks.submitCampaignRun.mockResolvedValue({
            ok: false,
            status: 503,
            body: { accepted: false, error: 'Service unavailable.' },
        });

        await context.processCampaignVerificationEntry({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime: 8.25,
            replay: { revision: 1, segments: [] },
        });

        expect(context.modal.setCombinedWinMedal).not.toHaveBeenCalled();
        expect(context.modal.updateModalScoreboardSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({ submissionStage: 'retrying' }),
        );
    });

    it('does not strand a Campaign challenge finish when confirmation fails', async () => {
        const modalMsg = { style: {}, textContent: '' };
        const updateChallengeFinishHero = vi.fn();
        const context = {
            activeCampaignChallenge: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg,
                showModal: vi.fn(),
                updateChallengeFinishHero,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        campaignServiceMocks.submitCampaignChallengeRun.mockRejectedValue(
            new Error('response interrupted'),
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await campaignEngineMethods.handleCampaignChallengeWin.call(
            context,
            { lapTime: 8.25 },
        );

        expect(context.modal.showModal).toHaveBeenCalledTimes(1);
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            expect.objectContaining({
                lapTime: 8.25,
                lapMedal: null,
                challengeFinish: true,
                challengeConfirmPhase: 'pending',
            }),
            expect.objectContaining({
                modalKind: 'win',
                shareRequest: {
                    kind: 'challenge-brag',
                    challengeId: 'challenge-1',
                },
                shareEnabled: false,
                restartAction: expect.any(Function),
            }),
        );
        await vi.waitFor(() => {
            expect(updateChallengeFinishHero).toHaveBeenCalledWith(
                expect.objectContaining({
                    phase: 'error',
                    error: 'Race finished, but the challenge result could not be confirmed.',
                }),
            );
        });
        expect(context.modal.showModal).toHaveBeenCalledTimes(1);
    });

    it('patches medal hero in place: pending then won/lost/tie; Brag only after verified win', async () => {
        const modalMsg = { style: {}, textContent: '' };
        const baseContext = {
            activeCampaignChallenge: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };

        const pendingLap = expect.objectContaining({
            lapMedal: null,
            challengeFinish: true,
            challengeConfirmPhase: 'pending',
            showGlobalLeaderboard: false,
        });
        const pendingOptions = expect.objectContaining({
            shareRequest: {
                kind: 'challenge-brag',
                challengeId: 'challenge-1',
            },
            shareEnabled: false,
            restartAction: expect.any(Function),
        });

        const winShowModal = vi.fn();
        const winUpdateHero = vi.fn();
        campaignServiceMocks.submitCampaignChallengeRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'won',
                resultLabel: 'Challenge Won',
                differenceMs: -500,
            },
        });
        await campaignEngineMethods.handleCampaignChallengeWin.call(
            {
                ...baseContext,
                modal: {
                    modalMsg,
                    showModal: winShowModal,
                    updateChallengeFinishHero: winUpdateHero,
                },
            },
            { lapTime: 7.5 },
        );
        expect(winShowModal).toHaveBeenCalledTimes(1);
        expect(winShowModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            pendingLap,
            pendingOptions,
        );
        await vi.waitFor(() => {
            expect(winUpdateHero).toHaveBeenCalledWith({ phase: 'won' });
        });
        expect(winUpdateHero).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'pending', statusText: expect.any(String) }),
        );
        expect(winShowModal).toHaveBeenCalledTimes(1);

        const lossShowModal = vi.fn();
        const lossUpdateHero = vi.fn();
        campaignServiceMocks.submitCampaignChallengeRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'lost',
                resultLabel: 'Challenge Lost',
                differenceMs: 400,
            },
        });
        await campaignEngineMethods.handleCampaignChallengeWin.call(
            {
                ...baseContext,
                modal: {
                    modalMsg,
                    showModal: lossShowModal,
                    updateChallengeFinishHero: lossUpdateHero,
                },
            },
            { lapTime: 8.4 },
        );
        expect(lossShowModal).toHaveBeenCalledTimes(1);
        expect(lossShowModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            pendingLap,
            pendingOptions,
        );
        await vi.waitFor(() => {
            expect(lossUpdateHero).toHaveBeenCalledWith({ phase: 'lost' });
        });
        expect(lossShowModal).toHaveBeenCalledTimes(1);

        const tieShowModal = vi.fn();
        const tieUpdateHero = vi.fn();
        campaignServiceMocks.submitCampaignChallengeRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'tie',
                resultLabel: 'Tie',
                differenceMs: 0,
            },
        });
        await campaignEngineMethods.handleCampaignChallengeWin.call(
            {
                ...baseContext,
                modal: {
                    modalMsg,
                    showModal: tieShowModal,
                    updateChallengeFinishHero: tieUpdateHero,
                },
            },
            { lapTime: 8 },
        );
        expect(tieShowModal).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
            expect(tieUpdateHero).toHaveBeenCalledWith({ phase: 'tie' });
        });
        expect(tieShowModal).toHaveBeenCalledTimes(1);
    });

    it('places Back, a 50% primary, and Garage only across Start Race rows', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        const css = readFileSync(new URL('../styles/lobby-modes.css', import.meta.url), 'utf8');

        for (const mode of ['daily', 'campaign']) {
            const backMarkup = html.match(
                new RegExp(`<button id="lobby-${mode}-back-btn"[\\s\\S]*?</button>`),
            )?.[0];
            const garageMarkup = html.match(
                new RegExp(`<button id="lobby-${mode}-garage-btn"[\\s\\S]*?</button>`),
            )?.[0];
            expect(backMarkup).toContain('class="lobby-primary-utility"');
            expect(backMarkup).toContain('data-lobby-back');
            expect(backMarkup).toContain('aria-label="Back to modes"');
            expect(garageMarkup).toContain('class="lobby-primary-utility"');
            expect(garageMarkup).toContain('aria-label="Garage"');
            expect(garageMarkup).toContain('aria-controls="garage-modal"');
            expect(garageMarkup).toContain('viewBox="0 0 576 512"');
        }

        expect(html).toMatch(
            /id="lobby-daily-back-btn"[\s\S]*id="daily-challenge-start-btn"[\s\S]*id="lobby-daily-garage-btn"/,
        );
        expect(html).toMatch(
            /id="lobby-campaign-back-btn"[\s\S]*id="campaign-primary-btn"[\s\S]*id="lobby-campaign-garage-btn"/,
        );
        expect(html).toMatch(/id="challenge-accept-btn"[\s\S]*main-menu__label">Accept</);
        expect(html).not.toContain('id="lobby-challenge-back-btn"');
        expect(html).not.toContain('id="lobby-challenge-garage-btn"');
        const headerBack = html.match(/<button id="lobby-back-btn"[\s\S]*?<\/button>/)?.[0];
        expect(headerBack).toContain('class="lobby-back-btn"');
        expect(headerBack).toContain('aria-label="Back to modes"');
        expect(html).not.toContain('Accept Challenge');
        expect(html).not.toMatch(
            /id="lobby-challenge-pane"[\s\S]*lobby-pane-heading__eyebrow/,
        );
        expect(css).toMatch(
            /\.lobby-mode-menu\s*\{[^}]*align-items:\s*flex-end;/s,
        );
        expect(css).toMatch(
            /\.lobby-pane\.main-menu\s*\{[^}]*margin-top:\s*auto;/s,
        );
        expect(css).toMatch(
            /\.lobby-panes\s*\{[^}]*flex-direction:\s*column;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row\s*\{[^}]*width:\s*95%;[^}]*margin-inline:\s*auto;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row--race\s*\{[^}]*grid-template-columns:\s*2\.75rem\s*50%\s*2\.75rem;[^}]*justify-content:\s*center;[^}]*column-gap:\s*clamp\(0\.85rem,\s*3vw,\s*1\.25rem\);/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-utility\s*\{[^}]*width:\s*2\.75rem;[^}]*height:\s*2\.75rem;[^}]*color:\s*#fff;[^}]*background:\s*transparent;[^}]*border:\s*0;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-utility svg\s*\{[^}]*width:\s*clamp\(1\.15rem,\s*4vw,\s*1\.4rem\);/s,
        );
        expect(css).not.toMatch(
            /\.lobby-primary-row\s*\{[^}]*margin-top:\s*auto;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row--race \.main-menu__item--primary\s*\{[^}]*font-size:\s*clamp\(1rem,\s*4\.5vw,\s*1\.25rem\);/s,
        );
        expect(css).not.toContain('width: min(94vw, 60rem)');
        expect(css).toMatch(
            /\.lobby-pane\s*\{[^}]*animation:\s*lobbyPaneIn 180ms ease-out both;/s,
        );
        expect(css).toMatch(
            /@keyframes lobbyPaneIn\s*\{[\s\S]*opacity:\s*0;[\s\S]*translate3d\(0,\s*0\.5rem,\s*0\);[\s\S]*opacity:\s*1;[\s\S]*translate3d\(0,\s*0,\s*0\);[\s\S]*\}/,
        );
        expect(css).toMatch(
            /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.lobby-pane\s*\{[^}]*animation:\s*none;/,
        );
    });

    it('preserves the Home menu and adds a separate mode-screen Settings icon', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        const css = readFileSync(new URL('../styles/lobby-modes.css', import.meta.url), 'utf8');
        const lobbyCss = readFileSync(
            new URL('../styles/lobby-and-garage.css', import.meta.url),
            'utf8',
        );

        for (const buttonId of [
            'lobby-home-daily-btn',
            'lobby-home-campaign-btn',
            'menu-btn-garage',
            'menu-btn-settings',
        ]) {
            const buttonMarkup = html.match(
                new RegExp(`<button id="${buttonId}"[\\s\\S]*?</button>`),
            )?.[0];
            expect(buttonMarkup).toContain('class="lobby-mode-action"');
            expect(buttonMarkup).toContain('lobby-mode-action__label');
            expect(buttonMarkup).not.toContain('lobby-mode-action__eyebrow');
            expect(buttonMarkup).not.toContain('class="main-menu__icon"');
        }

        const settingsMarkup = html.match(
            /<button id="lobby-mode-settings-btn"[\s\S]*?<\/button>/,
        )?.[0];
        expect(settingsMarkup).toContain('class="lobby-header-action"');
        expect(settingsMarkup).toContain('aria-label="Settings"');
        expect(settingsMarkup).toContain('aria-controls="settings-modal"');
        expect(settingsMarkup).toContain('viewBox="0 0 512 512"');
        expect(settingsMarkup).not.toContain('lobby-mode-action__label');

        expect(css).toContain('.lobby-mode-action');
        expect(css).not.toContain('.lobby-utility-row');
        expect(css).not.toContain('lobby-mode-action::after');
        expect(lobbyCss).toContain('.lobby-header-action');
        expect(lobbyCss).toMatch(
            /\.lobby-header-action\s*\{[^}]*display:\s*none;/s,
        );
        expect(lobbyCss).toMatch(
            /\.lobby-header-action\s*\{[^}]*color:\s*#fff;[^}]*background:\s*transparent;[^}]*border:\s*0;/s,
        );
        expect(lobbyCss).toMatch(
            /\.lobby-back-btn\s*\{[^}]*color:\s*#fff;[^}]*background:\s*none;[^}]*border:\s*0;/s,
        );
        expect(css).not.toMatch(
            /\.lobby-mode-action\s*\{[^}]*border-bottom:/s,
        );
    });

    it('binds every lobby Garage entry point to the shared Garage modal', () => {
        const buttons = [
            createElement('button'),
            createElement('button'),
            createElement('button'),
        ];
        const togglePanel = vi.fn();

        GarageUi.prototype.bind.call({
            buildSkinGrid: vi.fn(),
            buildTrailGrid: vi.fn(),
            syncSkinSelection: vi.fn(),
            syncTrailSelection: vi.fn(),
            setGarageTab: vi.fn(),
            garageModal: null,
            garageToggleButtons: buttons,
            togglePanel,
            tabSkin: null,
            tabTrails: null,
            prefetchCarSpriteAsset: null,
        });

        for (const button of buttons) {
            button.listeners.get('click')();
        }
        expect(togglePanel).toHaveBeenCalledTimes(buttons.length);
    });

    it('routes each pane Back icon through the active lobby mode', () => {
        const originalDocument = global.document;
        const backButtons = [
            createElement('button'),
            createElement('button'),
        ];
        global.document = {
            getElementById: vi.fn(() => null),
            querySelectorAll: vi.fn(() => backButtons),
            addEventListener: vi.fn(),
        };
        const onBack = vi.fn();
        const lobby = new LobbyUi({ onBack });
        lobby.mode = 'campaign';

        lobby.bind();
        backButtons[1].listeners.get('click')();

        expect(onBack).toHaveBeenCalledWith('campaign');
        global.document = originalDocument;
    });

    it('keeps Home unchanged and anchors mode-screen branding left with Settings right', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        expect(html).toMatch(
            /class="lobby-title"[\s\S]*id="lobby-mode-settings-btn"[\s\S]*data-lobby-subhead[\s\S]*data-lobby-mode-label[\s\S]*data-lobby-mode-track/,
        );
        expect(html).not.toMatch(
            /id="lobby-daily-pane"[\s\S]*lobby-pane-heading__title">Daily</,
        );
        expect(html).not.toMatch(
            /id="lobby-campaign-pane"[\s\S]*lobby-pane-heading__title">Campaign</,
        );

        const lobbyCss = readFileSync(
            new URL('../styles/lobby-and-garage.css', import.meta.url),
            'utf8',
        );
        const modeCss = readFileSync(
            new URL('../styles/lobby-modes.css', import.meta.url),
            'utf8',
        );
        const responsiveCss = readFileSync(
            new URL('../styles/responsive-layout.css', import.meta.url),
            'utf8',
        );
        expect(lobbyCss).toMatch(
            /\.lobby-header\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-start;/s,
        );
        expect(modeCss).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-header,[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto;/,
        );
        expect(modeCss).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-title,[\s\S]*align-items:\s*flex-start;[\s\S]*text-align:\s*left;/,
        );
        expect(lobbyCss).toMatch(
            /\.lobby-subhead\s*\{[^}]*margin-top:\s*0\.45rem;/s,
        );
        expect(responsiveCss).not.toMatch(
            /^\s*header\s*\{/m,
        );

        const originalDocument = global.document;
        const subhead = createElement('div');
        subhead.hidden = true;
        const label = createElement('p');
        const track = createElement('p');
        track.hidden = true;
        const overlay = createElement('div');
        const panes = {
            home: createElement('section'),
            daily: createElement('section'),
            campaign: createElement('section'),
            challenge: createElement('section'),
        };
        const body = { dataset: {} };
        global.document = {
            body,
            getElementById: (id) => {
                if (id === 'start-overlay') return overlay;
                const match = id.match(/^lobby-(home|daily|campaign|challenge)-pane$/);
                return match ? panes[match[1]] : null;
            },
            querySelector: (selector) => {
                if (selector === '[data-lobby-subhead]') return subhead;
                if (selector === '[data-lobby-mode-label]') return label;
                if (selector === '[data-lobby-mode-track]') return track;
                return null;
            },
            addEventListener: vi.fn(),
        };
        const lobby = new LobbyUi();
        lobby.resetKeyboardNav = vi.fn();
        lobby.focus = vi.fn();
        vi.stubGlobal('requestAnimationFrame', (cb) => cb());

        // Daily's track name lives on the carousel card, so the subhead is the
        // mode name and nothing else.
        lobby.showDaily();
        expect(subhead.hidden).toBe(false);
        expect(label.textContent).toBe('Daily');
        expect(track.hidden).toBe(true);
        expect(track.textContent).toBe('');
        expect(body.dataset.lobbyMode).toBe('daily');

        lobby.showCampaign();
        expect(subhead.hidden).toBe(false);
        expect(label.textContent).toBe('Campaign');
        expect(track.hidden).toBe(true);
        expect(track.textContent).toBe('');
        expect(body.dataset.lobbyMode).toBe('campaign');

        lobby.showChallenge({
            ranked: true,
            signedIn: true,
            available: true,
            challengerName: 'shimroot',
            trackName: 'Number One',
            laps: 1,
            targetTimeMs: 9478,
            medal: 'gold',
        });
        expect(subhead.hidden).toBe(false);
        expect(label.textContent).toBe('Challenge');
        expect(track.hidden).toBe(false);
        expect(track.textContent).toBe('u/shimroot challenges you');
        expect(track.classList.contains('lobby-mode-track--challenge')).toBe(true);
        expect(body.dataset.lobbyMode).toBe('challenge');

        lobby.showHome();
        expect(subhead.hidden).toBe(true);
        expect(label.textContent).toBe('');
        expect(track.hidden).toBe(true);
        expect(track.classList.contains('lobby-mode-track--challenge')).toBe(false);
        expect(body.dataset.lobbyMode).toBe('home');

        global.document = originalDocument;
    });


    it('races whichever stage the carousel has centred', () => {
        const originalDocument = global.document;
        const label = createElement('span');
        label.className = 'main-menu__label';
        const primary = createElement('button');
        primary.children.push(label);
        global.document = {
            getElementById: (id) => (id === 'campaign-primary-btn' ? primary : null),
            querySelector: () => null,
            addEventListener: vi.fn(),
            createElement,
        };
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        global.requestAnimationFrame = vi.fn();
        const onStartCampaign = vi.fn();
        const lobby = new LobbyUi({ onStartCampaign });

        lobby.bind();
        lobby.showCampaign({
            stages: [
                { id: 'numbered-v1-00', unlocked: true, medal: null },
                { id: 'numbered-v1-01', unlocked: true, medal: null },
                { id: 'numbered-v1-02', unlocked: false, medal: null },
            ],
        });

        // Every unlocked stage reads the same: the button races what is centred.
        lobby.setCampaignSelectedStage({ id: 'numbered-v1-00', unlocked: true });
        expect(label.textContent).toBe('Start Race');
        expect(primary.disabled).toBe(false);

        lobby.setCampaignSelectedStage({ id: 'numbered-v1-01', unlocked: true });
        expect(label.textContent).toBe('Start Race');
        expect(primary.disabled).toBe(false);

        // A locked stage cannot be started.
        lobby.setCampaignSelectedStage({ id: 'numbered-v1-02', unlocked: false });
        expect(label.textContent).toBe('Locked');
        expect(primary.disabled).toBe(true);

        lobby.setCampaignSelectedStage({ id: 'numbered-v1-01', unlocked: true });
        primary.listeners.get('click')();
        expect(onStartCampaign).toHaveBeenCalledTimes(1);

        global.requestAnimationFrame = originalRequestAnimationFrame;
        global.document = originalDocument;
    });

    it('passes the per-stage standings payload through unchanged', () => {
        expect(normalizeCampaignLeaderboardSnapshot({
            topRows: [{
                rank: 1,
                displayName: 'Racer',
                bestTimeMs: 12_345,
                isCurrentPlayer: true,
            }],
            currentPlayerRow: {
                rank: 1,
                displayName: 'Racer',
                bestTimeMs: 12_345,
                isCurrentPlayer: true,
            },
            totalCount: 1,
            leaderboardEntryCount: 1,
            playerRank: 1,
            playerRankLabel: '#1',
            pageOffset: 0,
            pageLimit: 50,
            hasMore: false,
            nextOffset: null,
        })).toMatchObject({
            topRows: [{
                rank: 1,
                displayName: 'Racer',
                bestTime: 12.345,
            }],
            currentPlayerRow: {
                rank: 1,
                bestTime: 12.345,
            },
            playerRank: 1,
            playerRankLabel: '#1',
            totalCount: 1,
        });
    });

    it('shows only unlocked stage selectors and loads each stage independently', async () => {
        campaignServiceMocks.getCampaignSnapshot.mockResolvedValue({
            ok: true,
            body: {
                topRows: [],
                currentPlayerRow: null,
                totalCount: 0,
                pageOffset: 0,
                pageLimit: 50,
                hasMore: false,
                nextOffset: null,
            },
        });
        const state = campaignState();
        const modal = {
            showRunsModal: vi.fn(),
            isRunsViewActive: vi.fn(() => true),
            updateModalScoreboardSnapshot: vi.fn(),
        };
        const context = {
            campaignLobbyState: state,
            modal,
            _campaignStandingsRequestId: 0,
            activeRaceMode: 'campaign',
            ensureCampaignBootstrap: vi.fn().mockResolvedValue({}),
        };

        expect(buildCampaignLeaderboardOptions(state).map((option) => option.challengeId))
            .toEqual(['numbered-v1-00', 'numbered-v1-01']);

        await campaignEngineMethods.openCampaignStandings.call(context);

        expect(campaignServiceMocks.getCampaignSnapshot).toHaveBeenCalledWith(
            'numbered-v1-01',
            { limit: 50, offset: 0 },
        );
        const modalOptions = modal.showRunsModal.mock.calls[0][4];
        expect(modalOptions.scoreboardMode).toBe('campaign');
        expect(modalOptions.leaderboardRailLabel).toBe('Campaign stages');
        expect(modalOptions.selectedLeaderboardDayId).toBe('numbered-v1-01');
        expect(modalOptions.scoreboardSnapshot).toEqual({ isLoading: true });
        expect(modal.updateModalScoreboardSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ topRows: [], totalCount: 0 }),
        );
    });

    it('keeps a Back route to the finish sheet when standings open from it', async () => {
        campaignServiceMocks.getCampaignSnapshot.mockResolvedValue({
            ok: true,
            body: { rows: [], currentPlayerRow: null, totalCount: 0 },
        });
        const modal = {
            showRunsModal: vi.fn(),
            isRunsViewActive: vi.fn(() => true),
            updateModalScoreboardSnapshot: vi.fn(),
        };
        const context = {
            ...campaignEngineMethods,
            campaignLobbyState: campaignState(),
            modal,
            _campaignStandingsRequestId: 0,
            activeRaceMode: 'campaign',
            ensureCampaignBootstrap: vi.fn().mockResolvedValue({}),
        };

        await campaignEngineMethods.openCampaignStandings.call(
            context,
            'numbered-v1-00',
            { returnMode: 'back' },
        );

        expect(modal.showRunsModal.mock.calls[0][3]).toBe('back');
        // Switching stages from that screen must not lose the way back.
        const { onSelectLeaderboardDay } = modal.showRunsModal.mock.calls[0][4];
        onSelectLeaderboardDay('numbered-v1-01');
        await vi.waitFor(() => {
            expect(modal.showRunsModal).toHaveBeenCalledTimes(2);
        });
        expect(modal.showRunsModal.mock.calls[1][3]).toBe('back');
    });

    it('loads later rows from the selected stage leaderboard only', async () => {
        campaignServiceMocks.getCampaignSnapshot
            .mockResolvedValueOnce({
                ok: true,
                body: {
                    topRows: [{ rank: 1, displayName: 'Leader', bestTimeMs: 12_000, bestTime: 12 }],
                    currentPlayerRow: null,
                    totalCount: 51,
                    pageOffset: 0,
                    pageLimit: 50,
                    hasMore: true,
                    nextOffset: 50,
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                body: {
                    topRows: [{ rank: 51, displayName: 'Racer', bestTimeMs: 15_000, bestTime: 15 }],
                    currentPlayerRow: null,
                    totalCount: 51,
                    pageOffset: 50,
                    pageLimit: 50,
                    hasMore: false,
                    nextOffset: null,
                },
            });
        const modal = {
            showRunsModal: vi.fn(),
            isRunsViewActive: vi.fn(() => true),
            updateModalScoreboardSnapshot: vi.fn(),
        };
        const context = {
            campaignLobbyState: campaignState(),
            modal,
            _campaignStandingsRequestId: 0,
            activeRaceMode: 'campaign',
            ensureCampaignBootstrap: vi.fn().mockResolvedValue({}),
        };

        await campaignEngineMethods.openCampaignStandings.call(context, 'numbered-v1-00');
        const modalOptions = modal.showRunsModal.mock.calls[0][4];
        await modalOptions.onLoadMoreLeaderboard();

        expect(campaignServiceMocks.getCampaignSnapshot).toHaveBeenNthCalledWith(
            2,
            'numbered-v1-00',
            { limit: 50, offset: 50 },
        );
        expect(modal.updateModalScoreboardSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({
                topRows: [
                    expect.objectContaining({ rank: 1, displayName: 'Leader' }),
                    expect.objectContaining({ rank: 51, displayName: 'Racer' }),
                ],
                hasMore: false,
            }),
        );
    });

    it('ignores a stale stage response after the player switches standings', async () => {
        let resolveFirst;
        let resolveSecond;
        campaignServiceMocks.getCampaignSnapshot
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirst = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveSecond = resolve;
            }));
        const modal = {
            showRunsModal: vi.fn(),
            isRunsViewActive: vi.fn(() => true),
            updateModalScoreboardSnapshot: vi.fn(),
        };
        const context = {
            campaignLobbyState: campaignState(),
            modal,
            _campaignStandingsRequestId: 0,
            activeRaceMode: 'campaign',
            ensureCampaignBootstrap: vi.fn().mockResolvedValue({}),
        };

        const firstOpen = campaignEngineMethods.openCampaignStandings.call(
            context,
            'numbered-v1-00',
        );
        const secondOpen = campaignEngineMethods.openCampaignStandings.call(
            context,
            'numbered-v1-01',
        );
        await vi.waitFor(() => {
            expect(typeof resolveFirst).toBe('function');
            expect(typeof resolveSecond).toBe('function');
        });
        resolveFirst({
            ok: true,
            body: {
                topRows: [{ rank: 1, displayName: 'Stale', bestTimeMs: 10_000, bestTime: 10 }],
                totalCount: 1,
            },
        });
        await firstOpen;
        expect(modal.updateModalScoreboardSnapshot).not.toHaveBeenCalled();

        resolveSecond({
            ok: true,
            body: {
                topRows: [{ rank: 1, displayName: 'Current', bestTimeMs: 11_000, bestTime: 11 }],
                totalCount: 1,
            },
        });
        await secondOpen;
        expect(modal.updateModalScoreboardSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                topRows: [expect.objectContaining({ displayName: 'Current' })],
            }),
        );
    });

    it('bounces own challenges to the Campaign lobby without showing Accept', async () => {
        campaignServiceMocks.getCampaignChallenge.mockResolvedValue({
            ok: false,
            status: 403,
            body: {
                status: 'own_challenge',
                error: "You can't accept your own challenge.",
            },
        });
        const showCampaignLobby = vi.fn(async () => undefined);
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            activeCampaignChallenge: { challengeId: 'stale' },
            hasAnyData: true,
            isReturningPlayer: false,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: { showChallenge: vi.fn() },
            reset: vi.fn(),
            showCampaignLobby,
        };

        await campaignEngineMethods.loadChallengeLobby.call(context, 'challenge-1');

        expect(context.activeCampaignChallenge).toBeNull();
        expect(showCampaignLobby).toHaveBeenCalledTimes(1);
        expect(context.lobbyUi.showChallenge).not.toHaveBeenCalled();
        expect(context.startOverlay.showStartOverlay).not.toHaveBeenCalled();
    });

    it('paints the Campaign lobby before bootstrap resolves', async () => {
        const frameCallbacks = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
        }));
        let resolveBootstrap;
        campaignServiceMocks.getCampaignBootstrap.mockReturnValue(new Promise((resolve) => {
            resolveBootstrap = resolve;
        }));
        const lobbyUi = {
            showCampaign: vi.fn(),
            getMode: vi.fn(() => 'campaign'),
            setCampaignPrimaryLoading: vi.fn(),
        };
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            hasAnyData: true,
            isReturningPlayer: false,
            activeRaceMode: 'home',
            campaignBootstrap: null,
            campaignLobbyState: null,
            _campaignBootstrapReady: false,
            _campaignBootstrapPromise: null,
            _campaignBootstrapRequestId: 0,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi,
            reset: vi.fn(),
            applyCampaignLobbyBootstrap: campaignEngineMethods.applyCampaignLobbyBootstrap,
            paintCampaignLobby: campaignEngineMethods.paintCampaignLobby,
            paintCampaignCarousel: vi.fn(),
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
            showCampaignLobby: campaignEngineMethods.showCampaignLobby,
        };

        context.showCampaignLobby();

        expect(lobbyUi.showCampaign).toHaveBeenCalledTimes(1);
        expect(context.activeRaceMode).toBe('campaign');
        expect(context._campaignBootstrapReady).toBe(false);
        expect(campaignServiceMocks.getCampaignBootstrap).toHaveBeenCalledTimes(1);
        expect(context.paintCampaignCarousel).not.toHaveBeenCalled();
        // The provisional paint must not name a primary action it cannot know.
        expect(lobbyUi.showCampaign.mock.calls[0][0].primaryLabel).toBeNull();
        expect(lobbyUi.setCampaignPrimaryLoading).toHaveBeenLastCalledWith(true);

        frameCallbacks.shift()(0);
        expect(context.paintCampaignCarousel).not.toHaveBeenCalled();
        frameCallbacks.shift()(16);
        expect(context.paintCampaignCarousel).toHaveBeenCalledTimes(1);

        resolveBootstrap({
            campaignId: 'numbered-v1',
            ranked: true,
            signedIn: true,
            stages: [
                {
                    raceId: 'numbered-v1-00',
                    stageIndex: 0,
                    stageNumber: '00',
                    trackKey: 'numberZero',
                    lapCount: 1,
                },
                {
                    raceId: 'numbered-v1-01',
                    stageIndex: 1,
                    stageNumber: '01',
                    trackKey: 'numberOne',
                    lapCount: 1,
                },
            ],
            progress: {
                startedAt: '2026-07-01T00:00:00.000Z',
                resultsByRaceId: {
                    'numbered-v1-00': {
                        raceId: 'numbered-v1-00',
                        bestTimeMs: 8000,
                        medal: 'gold',
                    },
                },
                unlockedRaceIds: ['numbered-v1-00', 'numbered-v1-01'],
                complete: false,
            },
        });
        await context._campaignBootstrapPromise;

        expect(context._campaignBootstrapReady).toBe(true);
        expect(context.campaignBootstrap.signedIn).toBe(true);
        expect(lobbyUi.showCampaign).toHaveBeenCalledTimes(2);
        expect(lobbyUi.showCampaign.mock.calls[1][0].primaryLabel).toBe('Start Race');
        expect(lobbyUi.setCampaignPrimaryLoading).toHaveBeenLastCalledWith(false);
    });

    it('leaves the primary spinner to a start that is already running', async () => {
        const lobbyUi = {
            showCampaign: vi.fn(),
            getMode: vi.fn(() => 'campaign'),
            setCampaignPrimaryLoading: vi.fn(),
        };
        const context = {
            ...campaignEngineMethods,
            activeRaceMode: 'campaign',
            // A press is mid-flight: it owns the spinner until its own start ends.
            startButtonPending: true,
            lobbyUi,
        };

        context.applyCampaignLobbyBootstrap({
            campaignId: 'numbered-v1',
            ranked: true,
            signedIn: true,
            stages: [{
                raceId: 'numbered-v1-00',
                stageIndex: 0,
                stageNumber: '00',
                trackKey: 'numberZero',
                lapCount: 1,
            }],
            progress: { resultsByRaceId: {}, unlockedRaceIds: ['numbered-v1-00'], complete: false },
        }, { paint: true });

        expect(lobbyUi.showCampaign).toHaveBeenCalledTimes(1);
        expect(lobbyUi.setCampaignPrimaryLoading).not.toHaveBeenCalled();
    });

    it('waits for bootstrap and uses the server path when Start is pressed early', async () => {
        let resolveBootstrap;
        campaignServiceMocks.getCampaignBootstrap.mockReturnValue(new Promise((resolve) => {
            resolveBootstrap = resolve;
        }));
        campaignServiceMocks.startServerCampaignRace.mockResolvedValue({
            ok: true,
            body: { progress: { unlockedRaceIds: ['numbered-v1-00'] } },
        });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({
            ok: true,
            body: { personalBest: null },
        });
        const lobbyUi = {
            showCampaign: vi.fn(),
            getMode: vi.fn(() => 'campaign'),
            setCampaignPrimaryLoading: vi.fn(),
        };
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            hasAnyData: true,
            isReturningPlayer: false,
            activeRaceMode: 'campaign',
            campaignBootstrap: {
                campaignId: 'numbered-v1',
                signedIn: false,
                stages: [],
                progress: {
                    resultsByRaceId: {},
                    unlockedRaceIds: ['numbered-v1-00'],
                    complete: false,
                },
            },
            campaignLobbyState: {
                complete: false,
                nextStage: { id: 'numbered-v1-00' },
                stages: [{ id: 'numbered-v1-00', unlocked: true }],
            },
            _campaignBootstrapReady: false,
            _campaignBootstrapPromise: null,
            _campaignBootstrapRequestId: 0,
            startButtonPending: false,
            currentTrackKey: 'numberZero',
            pbGhost: { clearTrack: vi.fn(), prepare: vi.fn() },
            trackPersonalBestByTrackKey: {},
            bestLapTime: null,
            journeys: { startAttempt: vi.fn() },
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi,
            reset: vi.fn(),
            loadTrack: vi.fn(),
            applyDailyChallenge: vi.fn(),
            startSequence: vi.fn(),
            loadCampaignLobby: vi.fn(),
            applyCampaignLobbyBootstrap: campaignEngineMethods.applyCampaignLobbyBootstrap,
            paintCampaignCarousel: vi.fn(),
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
            confirmCampaignRaceStart: campaignEngineMethods.confirmCampaignRaceStart,
            applyCampaignPersonalBest: campaignEngineMethods.applyCampaignPersonalBest,
        };

        const startPromise = campaignEngineMethods.startCampaignStage.call(context);
        expect(lobbyUi.setCampaignPrimaryLoading).toHaveBeenCalledWith(true);

        resolveBootstrap({
            campaignId: 'numbered-v1',
            ranked: true,
            signedIn: true,
            stages: [{
                raceId: 'numbered-v1-00',
                stageIndex: 0,
                stageNumber: '00',
                trackKey: 'numberZero',
                lapCount: 1,
            }],
            progress: {
                resultsByRaceId: {},
                unlockedRaceIds: ['numbered-v1-00'],
                complete: false,
            },
        });
        await startPromise;

        expect(campaignServiceMocks.startServerCampaignRace).toHaveBeenCalledWith('numbered-v1-00');
        expect(context.startSequence).toHaveBeenCalledTimes(1);
        expect(lobbyUi.setCampaignPrimaryLoading).toHaveBeenCalledWith(false);
        expect(context.loadCampaignLobby).not.toHaveBeenCalled();
    });

    function createStartContext(overrides = {}) {
        return {
            ...campaignEngineMethods,
            status: 'ready',
            currentChallengeRun: null,
            activeRaceMode: 'campaign',
            startButtonPending: false,
            _campaignBootstrapReady: true,
            campaignBootstrap: { ranked: true,
            signedIn: true, progress: {} },
            campaignLobbyState: {
                complete: false,
                nextStage: { id: 'numbered-v1-00' },
                stages: [{ id: 'numbered-v1-00', unlocked: true }],
            },
            currentTrackKey: 'numberZero',
            pbGhost: { clearTrack: vi.fn(), prepare: vi.fn() },
            trackPersonalBestByTrackKey: {},
            bestLapTime: null,
            activeDailyChallenge: null,
            journeys: { startAttempt: vi.fn() },
            lobbyUi: { setCampaignPrimaryLoading: vi.fn() },
            loadTrack: vi.fn(),
            applyDailyChallenge: vi.fn(function applyDailyChallenge(challenge) {
                this.activeDailyChallenge = challenge;
            }),
            startSequence: vi.fn(),
            syncTrackMedalFromChallengeBest: vi.fn(),
            syncChallengeHudPrimaryStats: vi.fn(),
            loadCampaignLobby: vi.fn().mockResolvedValue({}),
            ...overrides,
        };
    }

    it('starts the lights without waiting on the start stamp or the PB ghost', async () => {
        let resolveStart;
        let resolveGhost;
        campaignServiceMocks.startServerCampaignRace.mockReturnValue(new Promise((resolve) => {
            resolveStart = resolve;
        }));
        campaignServiceMocks.getCampaignPbGhost.mockReturnValue(new Promise((resolve) => {
            resolveGhost = resolve;
        }));
        const context = createStartContext();

        await context.startCampaignStage();

        // Both requests are already on the wire, and neither held up the race.
        expect(campaignServiceMocks.startServerCampaignRace).toHaveBeenCalledWith('numbered-v1-00');
        expect(campaignServiceMocks.getCampaignPbGhost).toHaveBeenCalledWith('numbered-v1-00');
        expect(context.startSequence).toHaveBeenCalledTimes(1);
        expect(context.startButtonPending).toBe(false);

        resolveStart({ ok: true, body: { progress: { startedAt: '2026-07-26T00:00:00.000Z' } } });
        resolveGhost({
            ok: true,
            body: {
                personalBest: {
                    bestTimeMs: 9_400,
                    ghost: { samples: [] },
                    checkpointTimesSec: [4.2],
                    updatedAt: '2026-07-26T00:00:00.000Z',
                },
            },
        });

        // The ghost still lands in time to race against, and the HUD catches up.
        await vi.waitFor(() => {
            expect(context.pbGhost.prepare).toHaveBeenCalled();
        });
        expect(context.bestLapTime).toBe(9.4);
        expect(context.trackPersonalBestByTrackKey['numbered-v1-00']).toMatchObject({
            bestTime: 9.4,
            ghostAvailable: true,
        });
        expect(context.syncChallengeHudPrimaryStats).toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(context.campaignBootstrap.progress).toEqual({
                startedAt: '2026-07-26T00:00:00.000Z',
            });
        });
        expect(context.loadCampaignLobby).not.toHaveBeenCalled();
    });

    it('sends the player back to the lobby when the server refuses the stage', async () => {
        campaignServiceMocks.startServerCampaignRace.mockResolvedValue({
            ok: false,
            status: 403,
            body: { error: 'Campaign race is locked.' },
        });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({ ok: false, body: {} });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const context = createStartContext();

        await context.startCampaignStage();

        await vi.waitFor(() => {
            expect(context.loadCampaignLobby).toHaveBeenCalledWith({ show: true });
        });
    });

    it('keeps racing when the start stamp is refused for a reason that is not the stage', async () => {
        // Unidentified, rate limited, server error: none of these say the stage
        // is unplayable, and the player is already in the countdown.
        campaignServiceMocks.startServerCampaignRace.mockResolvedValue({
            ok: false,
            status: 401,
            body: { error: 'Player identity is required for Campaign competition.' },
        });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({ ok: false, body: {} });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const context = createStartContext();

        await context.startCampaignStage();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.startSequence).toHaveBeenCalledTimes(1);
        expect(context.loadCampaignLobby).not.toHaveBeenCalled();
    });

    it('lets the run continue when the start stamp cannot be delivered', async () => {
        campaignServiceMocks.startServerCampaignRace.mockRejectedValue(new Error('offline'));
        campaignServiceMocks.getCampaignPbGhost.mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const context = createStartContext();

        await context.startCampaignStage();
        await Promise.resolve();
        await Promise.resolve();

        // Bookkeeping is not the gate — submission re-validates the unlock.
        expect(context.startSequence).toHaveBeenCalledTimes(1);
        expect(context.loadCampaignLobby).not.toHaveBeenCalled();
    });

    it('does not repaint Campaign after leaving before bootstrap resolves', async () => {
        let resolveBootstrap;
        campaignServiceMocks.getCampaignBootstrap.mockReturnValue(new Promise((resolve) => {
            resolveBootstrap = resolve;
        }));
        const lobbyUi = {
            showCampaign: vi.fn(),
            getMode: vi.fn(() => 'campaign'),
            setCampaignPrimaryLoading: vi.fn(),
        };
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            hasAnyData: true,
            isReturningPlayer: false,
            activeRaceMode: 'home',
            campaignBootstrap: null,
            campaignLobbyState: null,
            _campaignBootstrapReady: false,
            _campaignBootstrapPromise: null,
            _campaignBootstrapRequestId: 0,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi,
            reset: vi.fn(),
            applyCampaignLobbyBootstrap: campaignEngineMethods.applyCampaignLobbyBootstrap,
            paintCampaignLobby: campaignEngineMethods.paintCampaignLobby,
            paintCampaignCarousel: vi.fn(),
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
            showCampaignLobby: campaignEngineMethods.showCampaignLobby,
        };

        context.showCampaignLobby();
        expect(lobbyUi.showCampaign).toHaveBeenCalledTimes(1);
        context.activeRaceMode = 'home';
        lobbyUi.getMode.mockReturnValue('home');

        resolveBootstrap({
            campaignId: 'numbered-v1',
            signedIn: false,
            stages: [],
            progress: {
                resultsByRaceId: {},
                unlockedRaceIds: ['numbered-v1-00'],
                complete: false,
            },
        });
        await context._campaignBootstrapPromise;

        expect(context._campaignBootstrapReady).toBe(true);
        expect(lobbyUi.showCampaign).toHaveBeenCalledTimes(1);
    });
});
