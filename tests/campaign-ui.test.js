import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const campaignServiceMocks = vi.hoisted(() => ({
    getCampaignBootstrap: vi.fn(),
    getHeadToHead: vi.fn(),
    getCampaignPbGhost: vi.fn(),
    getCampaignSnapshot: vi.fn(),
    startServerCampaignRace: vi.fn(),
    submitHeadToHeadRun: vi.fn(),
    submitCampaignRun: vi.fn(),
}));

vi.mock('../game/campaign/service.js', async (importOriginal) => ({
    ...(await importOriginal()),
    createHeadToHead: vi.fn(),
    previewHeadToHead: vi.fn(),
    getCampaignBootstrap: campaignServiceMocks.getCampaignBootstrap,
    getHeadToHead: campaignServiceMocks.getHeadToHead,
    getCampaignPbGhost: campaignServiceMocks.getCampaignPbGhost,
    getCampaignSnapshot: campaignServiceMocks.getCampaignSnapshot,
    startServerCampaignRace: campaignServiceMocks.startServerCampaignRace,
    submitHeadToHeadRun: campaignServiceMocks.submitHeadToHeadRun,
    submitCampaignRun: campaignServiceMocks.submitCampaignRun,
}));

import {
    buildCampaignLeaderboardOptions,
    campaignEngineMethods,
    normalizeCampaignLeaderboardSnapshot,
} from '../game/campaign/engine-methods.js';
import { CAMPAIGN_STAGES } from '../game/campaign/manifest.js';
import {
    clearCampaignVerification,
    enqueueCampaignVerification,
    getCampaignVerificationEntry,
    markCampaignVerificationError,
} from '../game/scoreboard/verification-queue.js';
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
        attributes: {},
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
        setAttribute: vi.fn((name, value) => {
            element.attributes[name] = value;
        }),
        removeAttribute: vi.fn((name) => {
            delete element.attributes[name];
        }),
        toggleAttribute: vi.fn(),
        querySelector(selector) {
            if (selector === '.main-menu__label') {
                return this.children.find((child) => child.className === 'main-menu__label') || null;
            }
            if (selector === '.main-menu__race-brief') {
                return this.children.find((child) => child.className === 'main-menu__race-brief') || null;
            }
            if (selector === '.main-menu__race-brief-track'
                || selector === '.main-menu__race-brief-separator'
                || selector === '.main-menu__race-brief-laps') {
                return this.children.find((child) => child.className === selector.slice(1)) || null;
            }
            if (selector === '.main-menu__spinner' || selector === '.modal-rank-spinner') {
                return this.children.find((child) => String(child.className).includes('spinner')) || null;
            }
            return null;
        },
        remove() {
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
                unlock: { type: 'medal_total', requiredMedals: 3 },
                unlockRequirementLabel: '2 more medals needed',
            },
        ],
    };
}

function campaignStandingsSnapshot(displayName, bestTimeMs = 12_000) {
    return {
        topRows: [{
            rank: 1,
            displayName,
            bestTimeMs,
            isCurrentPlayer: displayName === 'You',
        }],
        currentPlayerRow: displayName === 'You'
            ? {
                rank: 1,
                displayName,
                bestTimeMs,
                isCurrentPlayer: true,
            }
            : null,
        totalCount: 1,
        leaderboardEntryCount: 1,
        playerRank: displayName === 'You' ? 1 : null,
        playerRankLabel: displayName === 'You' ? '#1' : null,
        pageOffset: 0,
        pageLimit: 50,
        hasMore: false,
        nextOffset: null,
    };
}

beforeEach(() => {
    const values = new Map();
    vi.stubGlobal('window', {
        localStorage: {
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: (key) => values.delete(key),
        },
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    campaignServiceMocks.getCampaignBootstrap.mockReset();
    campaignServiceMocks.getHeadToHead.mockReset();
    campaignServiceMocks.getCampaignPbGhost.mockReset();
    campaignServiceMocks.getCampaignSnapshot.mockReset();
    campaignServiceMocks.startServerCampaignRace.mockReset();
    campaignServiceMocks.submitHeadToHeadRun.mockReset();
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
            campaignVerifiedBootstrap: { ranked: true, signedIn: true, progress: {} },
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
                setCombinedNextRaceEnabled: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
            ...overrides,
        };
    }

    it('still awards the medal and queues the run when the bootstrap never answered', () => {
        const context = createCampaignFinishContext({
            campaignBootstrap: { ranked: false, signedIn: false, progress: {} },
        });

        context.handleCampaignWin({ lapTime: 7.3 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                lapMedal: 'gold',
                scoreboardSnapshot: expect.objectContaining({
                    submissionStage: 'submitting',
                }),
            }),
            expect.anything(),
        );
        expect(context.processVerificationQueue).toHaveBeenCalled();
    });

    it('opens the next stage on the finish rather than a round trip later', () => {
        const context = createCampaignFinishContext({
            campaignBootstrap: { ranked: false, signedIn: false, progress: {} },
        });

        context.handleCampaignWin({ lapTime: 7.0 });

        const progress = context.campaignBootstrap.progress;
        expect(progress.resultsByRaceId['numbered-v1-00']).toMatchObject({
            medal: 'author',
            bestTimeMs: 7000,
        });
        expect(progress.unlockedRaceIds).toContain('numbered-v1-01');
    });

    it('offers the stage this finish opened straight from the sheet', () => {
        const context = createCampaignFinishContext({
            campaignBootstrap: { ranked: false, signedIn: false, progress: {} },
            startCampaignNextStage: vi.fn(),
        });

        context.handleCampaignWin({ lapTime: 7.0 });

        const { nextRace } = context.modal.showModal.mock.calls[0][3];
        expect(nextRace).toMatchObject({ label: 'Next', enabled: true });
        expect(nextRace.ariaLabel).toBe('Race Number One');

        nextRace.action();
        expect(context.startCampaignNextStage).toHaveBeenCalledWith(
            expect.objectContaining({ raceId: 'numbered-v1-01' }),
        );
    });

    it('shows the next stage gated when the run earned nothing to open it', () => {
        const context = createCampaignFinishContext({
            campaignBootstrap: { ranked: false, signedIn: false, progress: {} },
            applyCampaignLobbyBootstrap: vi.fn(),
            campaignLobbyState: {
                stages: [{
                    id: 'numbered-v1-01',
                    unlocked: false,
                    unlockRequirementLabel: 'Earn any medal on Number Zero',
                }],
            },
        });

        context.handleCampaignWin({ lapTime: 10.5 });

        const { nextRace } = context.modal.showModal.mock.calls[0][3];
        expect(nextRace).toMatchObject({
            enabled: false,
            ariaLabel: 'Earn any medal on Number Zero',
        });
    });

    it('offers nothing after the last stage of the campaign', () => {
        const context = createCampaignFinishContext();
        const lastStage = CAMPAIGN_STAGES.at(-1);
        const finalStage = {
            raceId: lastStage.raceId,
            trackKey: lastStage.trackKey,
            lapCount: lastStage.lapCount,
            rulesRevision: lastStage.rulesRevision,
        };

        context.showCampaignFinish(finalStage, { finalTime: 60, medal: 'gold' });

        expect(context.modal.showModal.mock.calls[0][3].nextRace).toBe(null);
    });

    it('closes the stage again when the server refuses the run that opened it', async () => {
        const context = createCampaignFinishContext({
            campaignBootstrap: { ranked: false, signedIn: false, progress: {} },
            updateCampaignFinishSnapshot: vi.fn(),
        });
        context.handleCampaignWin({ lapTime: 7.0 });
        expect(context.campaignBootstrap.progress.unlockedRaceIds)
            .toContain('numbered-v1-01');

        campaignServiceMocks.submitCampaignRun.mockResolvedValue({
            ok: false,
            status: 422,
            body: { error: 'Submission replay validation failed.' },
        });
        await context.processCampaignVerificationEntry({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime: 7.0,
            replay: { revision: 1, segments: [] },
        });

        expect(context.campaignBootstrap.progress.unlockedRaceIds)
            .not.toContain('numbered-v1-01');
        expect(context.modal.setCombinedNextRaceEnabled).toHaveBeenCalledWith(false);
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
                    kind: 'head-to-head',
                    source: 'campaign',
                    raceId: 'numbered-v1-00',
                },
            }),
        );
        expect(context.modal.modalMsg.textContent).toBe('Number Zero · 1 lap');
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
                    kind: 'head-to-head',
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
        const standingsSession = {
            refreshedRaceIds: new Set(['numbered-v1-00']),
            inFlightByRaceId: new Map(),
            snapshotByRaceId: new Map(),
            selectedRaceId: 'numbered-v1-00',
        };
        const context = createCampaignFinishContext({
            _activeCampaignStandingsRefreshSession: standingsSession,
            _lastCampaignStandingsRefreshSession: standingsSession,
        });
        campaignServiceMocks.submitCampaignRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                progress: {
                    resultsByRaceId: {
                        'numbered-v1-00': { bestTimeMs: 8250, medal: 'gold' },
                    },
                },
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
        expect(context.campaignBootstrap.progress).toMatchObject({
            resultsByRaceId: {
                'numbered-v1-00': { bestTimeMs: 8250, medal: 'gold' },
            },
            unlockedRaceIds: ['numbered-v1-00', 'numbered-v1-01'],
        });
        expect(standingsSession.refreshedRaceIds).toContain('numbered-v1-00');
        expect(standingsSession.snapshotByRaceId.get('numbered-v1-00')).toMatchObject({
            playerRankLabel: '#1',
            totalCount: 3,
        });
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

    it('keeps an accepted run queued until the response confirms Campaign progress', async () => {
        const context = createCampaignFinishContext();
        const queued = queueCampaignRun(8.25);
        campaignServiceMocks.submitCampaignRun.mockResolvedValue({
            ok: true,
            body: { accepted: true, progress: { resultsByRaceId: {} } },
        });

        await context.processCampaignVerificationEntry(queued);

        expect(getCampaignVerificationEntry('numbered-v1-00')).toMatchObject({
            verificationState: 'pending',
            submissionStage: 'retrying',
            statusText: 'Saving Campaign progress...',
        });
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

    function queueCampaignRun(bestTime) {
        enqueueCampaignVerification({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime,
            lapCount: 1,
            rulesRevision: 1,
            replay: { revision: 1, segments: [] },
        });
        return getCampaignVerificationEntry('numbered-v1-00');
    }

    it('leaves a faster queued run alone when the slower attempt answers late', async () => {
        const context = createCampaignFinishContext();
        let resolveSubmit;
        campaignServiceMocks.submitCampaignRun.mockReturnValue(
            new Promise((resolve) => { resolveSubmit = resolve; }),
        );

        const slower = queueCampaignRun(8.25);
        const processing = context.processCampaignVerificationEntry(slower);
        queueCampaignRun(7.1);

        resolveSubmit({ ok: true, body: { accepted: true, progress: {} } });
        await processing;

        expect(getCampaignVerificationEntry('numbered-v1-00')?.bestTime).toBe(7.1);
    });

    it('does not strand a faster queued run behind the slower attempt it replaced', async () => {
        const context = createCampaignFinishContext();
        let rejectSubmit;
        campaignServiceMocks.submitCampaignRun.mockReturnValue(
            new Promise((_resolve, reject) => { rejectSubmit = reject; }),
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const slower = queueCampaignRun(8.25);
        const processing = context.processCampaignVerificationEntry(slower);
        queueCampaignRun(7.1);

        rejectSubmit(new Error('response interrupted'));
        await processing;

        const queued = getCampaignVerificationEntry('numbered-v1-00');
        expect(queued?.bestTime).toBe(7.1);
        expect(queued?.submissionStage).not.toBe('retrying');
    });

    it('does not open the next stage when the finish never reached the queue', () => {
        const context = createCampaignFinishContext();
        window.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
        vi.spyOn(console, 'error').mockImplementation(() => {});

        context.handleCampaignWin({ lapTime: 7.3 });

        expect(context.campaignBootstrap.progress?.resultsByRaceId ?? {}).toEqual({});
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                scoreboardSnapshot: expect.objectContaining({
                    verificationState: 'error',
                }),
            }),
            expect.anything(),
        );
    });

    it('reports a settled Campaign verification and gives up on one that is stuck', async () => {
        const context = createCampaignFinishContext();

        await expect(context.awaitCampaignVerificationSettled(null)).resolves.toBe(true);
        await expect(
            context.awaitCampaignVerificationSettled('numbered-v1-00'),
        ).resolves.toBe(true);

        queueCampaignRun(8.25);
        markCampaignVerificationError('numbered-v1-00', 'Campaign race was not completed.');
        await expect(
            context.awaitCampaignVerificationSettled('numbered-v1-00'),
        ).resolves.toBe(false);

        queueCampaignRun(7.1);
        await expect(
            context.awaitCampaignVerificationSettled('numbered-v1-00', {
                timeoutMs: 0,
                pollMs: 0,
            }),
        ).resolves.toBe(false);
    });

    it('places navigation and utilities in the header with a full-width Start Race', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        const css = readFileSync(new URL('../styles/lobby-modes.css', import.meta.url), 'utf8');
        const lobbyCss = readFileSync(
            new URL('../styles/lobby-and-garage.css', import.meta.url),
            'utf8',
        );

        const toolbarMarkup = html.match(
            /<nav class="lobby-mode-toolbar"[\s\S]*?<\/nav>/,
        )?.[0];
        expect(toolbarMarkup).toContain('class="lobby-mode-toolbar__actions"');
        expect(toolbarMarkup).toMatch(
            /<button id="lobby-mode-standings-btn"[\s\S]*id="lobby-mode-garage-btn"[\s\S]*id="lobby-mode-settings-btn"/,
        );
        expect(toolbarMarkup).not.toContain('id="lobby-mode-back-btn"');
        expect(toolbarMarkup).toContain('id="lobby-mode-standings-btn"');
        expect(toolbarMarkup).toContain('aria-label="Standings"');
        expect(toolbarMarkup).toContain('id="lobby-mode-garage-btn"');
        expect(toolbarMarkup).toContain('aria-controls="garage-modal"');
        expect(toolbarMarkup).toContain('id="lobby-mode-settings-btn"');
        expect(toolbarMarkup).toContain('aria-controls="settings-modal"');
        expect(toolbarMarkup).not.toContain('lobby-mode-toolbar__label');

        expect(html).not.toContain('id="lobby-daily-back-btn"');
        expect(html).not.toContain('id="lobby-daily-garage-btn"');
        expect(html).not.toContain('id="lobby-campaign-back-btn"');
        expect(html).not.toContain('id="lobby-campaign-garage-btn"');
        expect(html).toMatch(/id="challenge-accept-btn"[\s\S]*main-menu__label">Start Challenge</);
        expect(html).toMatch(
            /id="daily-challenge-start-btn"[\s\S]*main-menu__label">Start Race<\/span>[\s\S]*class="main-menu__race-brief"/,
        );
        expect(html).toMatch(
            /id="campaign-primary-btn"[\s\S]*main-menu__label">Start Race<\/span>[\s\S]*class="main-menu__race-brief"/,
        );
        expect(html).toMatch(
            /class="main-menu__race-brief"[\s\S]*class="main-menu__race-brief-track"[\s\S]*class="main-menu__race-brief-separator"[\s\S]*class="main-menu__race-brief-laps"/,
        );
        for (const prefix of ['daily', 'campaign']) {
            expect(html).toContain(
                `id="${prefix}-carousel" class="track-carousel track-carousel--lobby"`,
            );
            // Prev/Next flank the schematic, so they leave the count's row and
            // sit alongside it rather than around it.
            expect(html).toMatch(
                new RegExp(
                    `id="${prefix}-carousel-prev"[\\s\\S]*id="${prefix}-carousel-next"[\\s\\S]*id="${prefix}-carousel-navigation"[\\s\\S]*id="${prefix}-carousel-count"`,
                ),
            );
            expect(html).not.toMatch(
                new RegExp(`id="${prefix}-carousel-navigation"[\\s\\S]*id="${prefix}-carousel-prev"`),
            );
        }
        expect(lobbyCss).toMatch(
            /\.main-menu__item--primary \.main-menu__race-brief\s*\{[^}]*font-family:\s*var\(--header-font\);/s,
        );
        expect(lobbyCss).toMatch(
            /\.main-menu__item--primary \.main-menu__race-brief-track\s*\{[^}]*font-weight:\s*900;/s,
        );
        expect(lobbyCss).toMatch(
            /\.main-menu__item--primary \.main-menu__race-brief-track\s*\{[^}]*font-family:\s*inherit;/s,
        );
        expect(lobbyCss).toMatch(
            /\.main-menu__item--primary \.main-menu__race-brief-separator\s*\{[^}]*font-family:\s*inherit;/s,
        );
        expect(lobbyCss).toMatch(
            /\.main-menu__item--primary \.main-menu__race-brief-laps\s*\{[^}]*font-family:\s*inherit;/s,
        );
        expect(lobbyCss).toMatch(
            /\.main-menu__item--primary \.main-menu__race-brief-separator\s*\{[^}]*font-size:\s*0\.78rem;/s,
        );
        expect(lobbyCss).not.toContain('.main-menu__race-brief-laps-number');
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
            /body\[data-lobby-mode="daily"\] \.lobby-header,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*3;[^}]*display:\s*flex;/s,
        );
        expect(css).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-mode-toolbar,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-mode-toolbar\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*width:\s*auto;/s,
        );
        expect(css).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-subhead,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-subhead\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s,
        );
        expect(css).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-panes,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-panes\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s,
        );
        expect(css).toMatch(
            /\.lobby-mode-toolbar__action\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*width:\s*clamp\(2\.6rem,\s*10vw,\s*3rem\);[^}]*height:\s*clamp\(2\.6rem,\s*10vw,\s*3rem\);[^}]*min-width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem;/s,
        );
        expect(css).toMatch(
            /\.lobby-mode-toolbar__action svg\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
        );
        expect(css).toMatch(
            /\.lobby-mode-toolbar__back svg\s*\{[^}]*width:\s*clamp\(1\.5rem,\s*5vw,\s*1\.9rem\);[^}]*height:\s*clamp\(1\.5rem,\s*5vw,\s*1\.9rem\);/s,
        );
        expect(css).toMatch(
            /\.lobby-panes\s*\{[^}]*display:\s*grid;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row\s*\{[^}]*width:\s*95%;[^}]*margin-inline:\s*auto;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row--race\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
        );
        expect(css).not.toContain('.lobby-primary-utility');
        expect(css).not.toMatch(
            /\.lobby-primary-row\s*\{[^}]*margin-top:\s*auto;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row--race \.main-menu__item--primary\s*\{[^}]*font-size:\s*1\.5rem;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row--race \.main-menu__item--primary\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*0\.3rem;/s,
        );
        expect(css).not.toContain('width: min(94vw, 60rem)');
        expect(css).toMatch(
            /\.lobby-pane\s*\{[^}]*animation:\s*lobbyPaneIn var\(--dur-base\) var\(--ease-settle\) both;/s,
        );
        const paneEntrance = css.match(/@keyframes lobbyPaneIn\s*\{[\s\S]*?\n\}/)?.[0];
        expect(paneEntrance).toMatch(/opacity:\s*0;[\s\S]*opacity:\s*1;/);
        expect(paneEntrance).toMatch(/translate:\s*0 var\(--lobby-pane-travel\);[\s\S]*translate:\s*0 0;/);
        expect(css).toMatch(
            /\.lobby-pane\[hidden\]\s*\{[^}]*translate:\s*0 var\(--lobby-pane-travel\);/s,
        );
        expect(css).toMatch(
            /\.lobby-pane\[hidden\]\s*\{[^}]*display:\s*none !important;[^}]*animation:\s*none;/s,
        );
        expect(css).toMatch(
            /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.lobby-pane\s*\{[^}]*animation:\s*none;[^}]*transition:\s*none;/,
        );
    });

    it('preserves the Home menu and uses Font Awesome mode-toolbar icons', () => {
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
        expect(settingsMarkup).toContain('lobby-header-action');
        expect(settingsMarkup).toContain('aria-label="Settings"');
        expect(settingsMarkup).toContain('aria-controls="settings-modal"');
        expect(settingsMarkup).toContain('viewBox="0 0 512 512"');
        expect(settingsMarkup).not.toContain('lobby-mode-action__label');
        const standingsMarkup = html.match(
            /<button id="lobby-mode-standings-btn"[\s\S]*?<\/button>/,
        )?.[0];
        expect(standingsMarkup).toContain('viewBox="0 0 640 640"');
        const garageMarkup = html.match(
            /<button id="lobby-mode-garage-btn"[\s\S]*?<\/button>/,
        )?.[0];
        expect(garageMarkup).toContain('viewBox="0 0 576 512"');

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

    it('sends the wordmark home and leaves it inert once Home is showing', () => {
        const originalDocument = global.document;
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        expect(html).toMatch(
            /<h1 class="lobby-title">\s*<button id="lobby-title-home-btn"[\s\S]*?data-lobby-back disabled>\s*<span class="lobby-title__mini">/,
        );

        const titleHome = createElement('button');
        const label = createElement('p');
        global.document = {
            body: { dataset: {} },
            getElementById: vi.fn((id) => (
                id === 'lobby-title-home-btn' ? titleHome : null
            )),
            querySelector: vi.fn((selector) => (
                selector === '[data-lobby-mode-label]' ? label : null
            )),
            querySelectorAll: vi.fn(() => [titleHome]),
            addEventListener: vi.fn(),
        };
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        global.requestAnimationFrame = vi.fn();

        try {
            const onBack = vi.fn();
            const lobby = new LobbyUi({ onBack });
            lobby.resetKeyboardNav = vi.fn();
            lobby.focus = vi.fn();
            lobby.bind();

            lobby.showPane('campaign');
            expect(titleHome.disabled).toBe(false);

            titleHome.listeners.get('click')();
            expect(onBack).toHaveBeenCalledWith('campaign');

            lobby.showPane('home');
            expect(titleHome.disabled).toBe(true);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
            global.document = originalDocument;
        }
    });

    it('routes Standings through the currently active lobby mode', () => {
        const originalDocument = global.document;
        const standings = createElement('button');
        global.document = {
            getElementById: vi.fn((id) => (
                id === 'lobby-mode-standings-btn' ? standings : null
            )),
            querySelectorAll: vi.fn(() => []),
            addEventListener: vi.fn(),
        };
        const onOpenStandings = vi.fn();
        const lobby = new LobbyUi({ onOpenStandings });
        lobby.mode = 'daily';

        lobby.bind();
        standings.listeners.get('click')();

        expect(onOpenStandings).toHaveBeenCalledWith('daily');
        global.document = originalDocument;
    });

    it('blocks lobby keyboard input while the race-start exit is running', () => {
        const overlay = {
            style: { display: 'flex' },
            classList: { contains: vi.fn((name) => name === 'is-race-start-exiting') },
        };
        const lobbyUi = new LobbyUi({ onBack: vi.fn() });
        Object.defineProperty(lobbyUi, 'overlay', { value: overlay });
        lobbyUi.mode = 'daily';
        const event = {
            key: 'Escape',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };

        lobbyUi.handleKeydown(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(lobbyUi.onBack).not.toHaveBeenCalled();
    });

    it('swaps Daily and Campaign without veiling or view-transitioning the lobby', async () => {
        const originalDocument = global.document;
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const overlay = createElement('div');
        const panes = {
            home: createElement('section'),
            daily: createElement('section'),
            campaign: createElement('section'),
            challenge: createElement('section'),
        };
        const subhead = createElement('div');
        const label = createElement('p');
        const startViewTransition = vi.fn((update) => {
            update();
            return { finished: Promise.resolve() };
        });
        global.document = {
            body: { dataset: {} },
            documentElement: createElement('html'),
            startViewTransition,
            getElementById: (id) => {
                if (id === 'start-overlay') return overlay;
                const match = id.match(/^lobby-(home|daily|challenge|campaign)-pane$/);
                return match ? panes[match[1]] : null;
            },
            querySelector: (selector) => ({
                '[data-lobby-subhead]': subhead,
                '[data-lobby-mode-label]': label,
            }[selector] || null),
            addEventListener: vi.fn(),
        };
        global.requestAnimationFrame = vi.fn();

        try {
            const lobby = new LobbyUi();
            lobby.resetKeyboardNav = vi.fn();
            lobby.focus = vi.fn();
            lobby.mode = 'daily';

            lobby.showPane('campaign');

            expect(overlay.classList.contains('is-lobby-transitioning')).toBe(false);
            expect(startViewTransition).not.toHaveBeenCalled();
            expect(lobby.isKeyboardNavBlocked()).toBe(false);
            expect(panes.daily.hidden).toBe(true);
            expect(panes.campaign.hidden).toBe(false);
            expect(global.document.body.dataset.lobbyMode).toBe('campaign');
            expect(global.document.body.dataset.lobbyPaneSwap).toBe('toggle');

            // The Campaign bootstrap repaints the pane it is already on; that must
            // not move the entrance off the carousel and replay it.
            lobby.showPane('campaign');

            expect(global.document.body.dataset.lobbyPaneSwap).toBe('toggle');
            expect(startViewTransition).not.toHaveBeenCalled();

            lobby.showPane('home');

            expect(overlay.classList.contains('is-lobby-transitioning')).toBe(true);
            expect(startViewTransition).toHaveBeenCalledTimes(1);
            expect(global.document.body.dataset.lobbyPaneSwap).toBe('mode');
            // Let the view transition's cleanup run before `document` is restored.
            await Promise.resolve();
            await Promise.resolve();
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
            global.document = originalDocument;
        }
    });

    it('covers a mode swap and releases the veil after the pane is painted', () => {
        const originalDocument = global.document;
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const frameCallbacks = [];
        const overlay = createElement('div');
        overlay.removeAttribute = vi.fn();
        const panes = {
            home: createElement('section'),
            daily: createElement('section'),
            campaign: createElement('section'),
            challenge: createElement('section'),
        };
        const subhead = createElement('div');
        const label = createElement('p');
        const track = createElement('p');
        const body = { dataset: {} };
        global.document = {
            body,
            getElementById: (id) => {
                if (id === 'start-overlay') return overlay;
                const match = id.match(/^lobby-(home|daily|challenge|campaign)-pane$/);
                return match ? panes[match[1]] : null;
            },
            querySelector: (selector) => ({
                '[data-lobby-subhead]': subhead,
                '[data-lobby-mode-label]': label,
                '[data-lobby-mode-track]': track,
            }[selector] || null),
            addEventListener: vi.fn(),
        };
        global.requestAnimationFrame = vi.fn((callback) => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
        });

        try {
            const lobby = new LobbyUi();
            lobby.resetKeyboardNav = vi.fn();
            lobby.focus = vi.fn();

            lobby.showDaily();

            expect(overlay.classList.contains('is-lobby-transitioning')).toBe(true);
            expect(panes.home.hidden).toBe(true);
            expect(panes.daily.hidden).toBe(false);
            expect(lobby.isKeyboardNavBlocked()).toBe(true);

            frameCallbacks.shift()();
            frameCallbacks.shift()();
            expect(overlay.classList.contains('is-lobby-transitioning')).toBe(true);
            frameCallbacks.shift()();

            expect(overlay.classList.contains('is-lobby-transitioning')).toBe(false);
            expect(overlay.removeAttribute).toHaveBeenCalledWith('aria-busy');
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
            global.document = originalDocument;
        }
    });

    it('keeps Home unchanged and swaps mode-screen branding for the toolbar', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        expect(html).toMatch(
            /class="lobby-title"[\s\S]*class="lobby-mode-toolbar"[\s\S]*id="lobby-mode-settings-btn"[\s\S]*data-lobby-subhead/,
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
            /body\[data-lobby-mode="daily"\] \.lobby-header,[\s\S]*position:\s*relative;[\s\S]*display:\s*flex;/,
        );
        expect(modeCss).not.toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-title,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-title\s*\{[^}]*display:\s*none;/,
        );
        expect(modeCss).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-mode-toolbar,[\s\S]*display:\s*flex;[\s\S]*justify-content:\s*flex-end;/,
        );
        expect(modeCss).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-subhead,[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/,
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
        const rule = createElement('span');
        rule.hidden = true;
        const selection = createElement('p');
        selection.hidden = true;
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
                const match = id.match(/^lobby-(home|daily|challenge|campaign)-pane$/);
                return match ? panes[match[1]] : null;
            },
            querySelector: (selector) => {
                if (selector === '[data-lobby-subhead]') return subhead;
                if (selector === '[data-lobby-mode-label]') return label;
                if (selector === '[data-lobby-mode-track]') return track;
                if (selector === '[data-lobby-subhead-rule]') return rule;
                if (selector === '[data-lobby-mode-selection]') return selection;
                return null;
            },
            addEventListener: vi.fn(),
        };
        const lobby = new LobbyUi();
        lobby.resetKeyboardNav = vi.fn();
        lobby.focus = vi.fn();
        vi.stubGlobal('requestAnimationFrame', (cb) => cb());

        lobby.showDaily();
        expect(subhead.hidden).toBe(false);
        expect(label.hidden).toBe(true);
        expect(track.hidden).toBe(true);
        expect(track.textContent).toBe('');
        expect(rule.hidden).toBe(false);
        expect(selection.hidden).toBe(true);
        expect(body.dataset.lobbyMode).toBe('daily');

        lobby.setDailySelectedChallenge(
            { trackName: 'Classic Circuit', objectiveParams: { lapCount: 1 } },
            { trackName: 'Classic Circuit', laps: 1, billingLabel: 'Today' },
        );
        expect(selection.textContent).toBe('Today');
        expect(selection.hidden).toBe(false);

        lobby.showCampaign();
        expect(subhead.hidden).toBe(false);
        expect(label.hidden).toBe(true);
        expect(track.hidden).toBe(true);
        expect(track.textContent).toBe('');
        expect(rule.hidden).toBe(false);
        expect(selection.hidden).toBe(true);
        expect(body.dataset.lobbyMode).toBe('campaign');

        lobby.setCampaignSelectedStage({
            numberLabel: '10',
            trackName: 'Imaginary Number',
            unlocked: true,
            laps: 1,
        });
        expect(selection.textContent).toBe('Imaginary Number');
        expect(selection.textContent).not.toBe('Stage 10');
        expect(selection.hidden).toBe(false);

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
        expect(track.hidden).toBe(true);
        expect(rule.hidden).toBe(false);
        expect(selection.hidden).toBe(false);
        expect(selection.textContent).toBe('Number One');
        expect(body.dataset.lobbyMode).toBe('challenge');

        lobby.showHome();
        expect(subhead.hidden).toBe(true);
        expect(label.textContent).toBe('');
        expect(track.hidden).toBe(true);
        expect(rule.hidden).toBe(true);
        expect(selection.hidden).toBe(true);
        expect(body.dataset.lobbyMode).toBe('home');
        expect(body.dataset.lobbyHomeReturned).toBe('true');
        expect(modeCss).toMatch(
            /body\[data-lobby-home-returned="true"\] #start-overlay\.is-ready \.lobby-title__mini,[\s\S]*animation:\s*none;/,
        );

        global.document = originalDocument;
    });


    it('races whichever stage the carousel has centred', () => {
        const originalDocument = global.document;
        const label = createElement('span');
        label.className = 'main-menu__label';
        const brief = createElement('span');
        brief.className = 'main-menu__race-brief';
        const track = createElement('span');
        track.className = 'main-menu__race-brief-track';
        const separator = createElement('span');
        separator.className = 'main-menu__race-brief-separator';
        const laps = createElement('span');
        laps.className = 'main-menu__race-brief-laps';
        brief.children.push(track, separator, laps);
        const primary = createElement('button');
        primary.children.push(label, brief);
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

        lobby.setCampaignSelectedStage({
            id: 'numbered-v1-00',
            trackName: 'Number Zero',
            unlocked: true,
            laps: 1,
        });
        expect(label.textContent).toBe('Start Race');
        expect(track.textContent).toBe('Number Zero');
        expect(separator.hidden).toBe(false);
        expect(laps.textContent).toBe('1 Lap');
        expect(laps.attributes['aria-label']).toBe('1 Lap');
        expect(primary.disabled).toBe(false);

        lobby.setCampaignSelectedStage({
            id: 'numbered-v1-01',
            trackName: 'Number One',
            unlocked: true,
            laps: 3,
        });
        expect(label.textContent).toBe('Start Race');
        expect(track.textContent).toBe('Number One');
        expect(separator.hidden).toBe(false);
        expect(laps.textContent).toBe('3 Laps');
        expect(laps.attributes['aria-label']).toBe('3 Laps');
        expect(primary.disabled).toBe(false);

        lobby.setCampaignSelectedStage({
            id: 'numbered-v1-02',
            trackName: 'Number Two',
            unlocked: false,
            laps: 2,
        });
        expect(label.textContent).toBe('Locked');
        expect(track.textContent).toBe('Number Two');
        expect(separator.hidden).toBe(false);
        expect(laps.textContent).toBe('2 Laps');
        expect(laps.attributes['aria-label']).toBe('2 Laps');
        expect(primary.disabled).toBe(true);

        lobby.setCampaignSelectedStage({
            id: 'numbered-v1-01',
            trackName: 'Number One',
            unlocked: true,
            laps: 3,
        });
        primary.listeners.get('click')();
        expect(onStartCampaign).toHaveBeenCalledTimes(1);

        global.requestAnimationFrame = originalRequestAnimationFrame;
        global.document = originalDocument;
    });

    it('replays the primary label fade only when the word actually changes', () => {
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
        const lobby = new LobbyUi({});

        lobby.bind();
        lobby.showCampaign({
            stages: [
                { id: 'numbered-v1-00', unlocked: true, medal: null },
                { id: 'numbered-v1-01', unlocked: true, medal: null },
            ],
        });

        lobby.setCampaignSelectedStage({ id: 'numbered-v1-00', unlocked: true });
        expect(label.textContent).toBe('Start Race');
        expect(label.classList.contains('is-swapping')).toBe(true);

        label.classList.remove('is-swapping');
        lobby.setCampaignSelectedStage({ id: 'numbered-v1-01', unlocked: true });
        expect(label.textContent).toBe('Start Race');
        expect(label.classList.contains('is-swapping')).toBe(false);

        lobby.setCampaignSelectedStage({ id: 'numbered-v1-02', unlocked: false });
        expect(label.textContent).toBe('Locked');
        expect(label.classList.contains('is-swapping')).toBe(true);

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

    it('shows every stage selector, including locked stages without a player rank', async () => {
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
            .toEqual(state.stages.map((stage) => stage.id));

        await campaignEngineMethods.openCampaignStandings.call(context, 'numbered-v1-02');

        expect(campaignServiceMocks.getCampaignSnapshot).toHaveBeenCalledWith(
            'numbered-v1-02',
            { limit: 50, offset: 0 },
        );
        const modalOptions = modal.showRunsModal.mock.calls[0][4];
        expect(modalOptions.scoreboardMode).toBe('campaign');
        expect(modalOptions.leaderboardRailLabel).toBe('Campaign stages');
        expect(modalOptions.selectedLeaderboardDayId).toBe('numbered-v1-02');
        expect(modalOptions.scoreboardSnapshot).toEqual({ isLoading: true });
        expect(modal.updateModalScoreboardSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ topRows: [], totalCount: 0 }),
        );
    });

    it('shows every Campaign standings entry without rank filtering', () => {
        const state = {
            stages: CAMPAIGN_STAGES.map((stage, index) => ({
                id: stage.raceId,
                numberLabel: stage.stageNumber,
                trackName: stage.trackKey,
                unlocked: index === 0,
                playerRank: index === 0 ? 1 : null,
            })),
        };

        const options = buildCampaignLeaderboardOptions(state);

        expect(options).toHaveLength(CAMPAIGN_STAGES.length);
        expect(options.map((option) => option.challengeId)).toEqual(
            CAMPAIGN_STAGES.map((stage) => stage.raceId),
        );
    });

    it('reuses a refreshed stage when switching back within one standings session', async () => {
        campaignServiceMocks.getCampaignSnapshot
            .mockResolvedValueOnce({
                ok: true,
                body: campaignStandingsSnapshot('Stage Zero'),
            })
            .mockResolvedValueOnce({
                ok: true,
                body: campaignStandingsSnapshot('Stage One', 13_000),
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
            activeRaceMode: 'campaign',
            ensureCampaignBootstrap: vi.fn().mockResolvedValue({}),
        };

        await context.openCampaignStandings('numbered-v1-00');
        modal.showRunsModal.mock.calls[0][4].onSelectLeaderboardDay('numbered-v1-01');
        await vi.waitFor(() => expect(modal.showRunsModal).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(campaignServiceMocks.getCampaignSnapshot)
            .toHaveBeenCalledTimes(2));
        modal.showRunsModal.mock.calls[1][4].onSelectLeaderboardDay('numbered-v1-00');
        await vi.waitFor(() => expect(modal.showRunsModal).toHaveBeenCalledTimes(3));

        expect(campaignServiceMocks.getCampaignSnapshot).toHaveBeenCalledTimes(2);
        expect(modal.showRunsModal.mock.calls[2][4].scoreboardSnapshot).toMatchObject({
            topRows: [expect.objectContaining({ displayName: 'Stage Zero' })],
        });
        expect(modal.showRunsModal.mock.calls[2][4].scoreboardSnapshot).not.toHaveProperty(
            'isLoading',
        );
        expect(modal.showRunsModal.mock.calls[2][4].scoreboardSnapshot).not.toHaveProperty(
            'isRefreshing',
        );
    });

    it('starts a new refresh session after standings closes', async () => {
        campaignServiceMocks.getCampaignSnapshot
            .mockResolvedValueOnce({
                ok: true,
                body: campaignStandingsSnapshot('Cached'),
            })
            .mockResolvedValueOnce({
                ok: true,
                body: campaignStandingsSnapshot('Fresh', 11_000),
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
            activeRaceMode: 'campaign',
            ensureCampaignBootstrap: vi.fn().mockResolvedValue({}),
        };

        await context.openCampaignStandings('numbered-v1-00');
        modal.showRunsModal.mock.calls[0][4].onClose();
        await context.openCampaignStandings('numbered-v1-00');

        expect(campaignServiceMocks.getCampaignSnapshot).toHaveBeenCalledTimes(2);
        expect(modal.showRunsModal.mock.calls[1][4].scoreboardSnapshot).toMatchObject({
            isRefreshing: true,
            topRows: [expect.objectContaining({ displayName: 'Cached' })],
        });
        expect(modal.updateModalScoreboardSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({
                topRows: [expect.objectContaining({ displayName: 'Fresh' })],
            }),
        );
    });

    it('keeps the cached Campaign snapshot when a new-session refresh fails', async () => {
        campaignServiceMocks.getCampaignSnapshot
            .mockResolvedValueOnce({
                ok: true,
                body: campaignStandingsSnapshot('Cached'),
            })
            .mockRejectedValueOnce(new Error('offline'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const modal = {
            showRunsModal: vi.fn(),
            isRunsViewActive: vi.fn(() => true),
            updateModalScoreboardSnapshot: vi.fn(),
        };
        const context = {
            ...campaignEngineMethods,
            campaignLobbyState: campaignState(),
            modal,
            activeRaceMode: 'campaign',
            ensureCampaignBootstrap: vi.fn().mockResolvedValue({}),
        };

        await context.openCampaignStandings('numbered-v1-00');
        modal.showRunsModal.mock.calls[0][4].onClose();
        await context.openCampaignStandings('numbered-v1-00');

        expect(modal.showRunsModal.mock.calls[1][4].scoreboardSnapshot).toMatchObject({
            isRefreshing: true,
            topRows: [expect.objectContaining({ displayName: 'Cached' })],
        });
        expect(modal.updateModalScoreboardSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({
                topRows: [expect.objectContaining({ displayName: 'Cached' })],
            }),
        );
        expect(modal.updateModalScoreboardSnapshot.mock.calls.at(-1)[0]).not.toHaveProperty(
            'isRefreshing',
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

        const requestCount = campaignServiceMocks.getCampaignBootstrap.mock.calls.length;
        context.showCampaignLobby({ refresh: false });
        expect(campaignServiceMocks.getCampaignBootstrap).toHaveBeenCalledTimes(requestCount);
    });

    it('loads the visible Campaign lobby with exactly one forced bootstrap request', async () => {
        campaignServiceMocks.getCampaignBootstrap.mockResolvedValue({
            availability: 'available',
            authoritative: true,
            campaignId: 'numbered-v1',
            ranked: true,
            signedIn: false,
            stages: [],
            progress: {
                resultsByRaceId: {},
                unlockedRaceIds: ['numbered-v1-00'],
                complete: false,
            },
        });
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
            lobbyUi: {
                showCampaign: vi.fn(),
                getMode: vi.fn(() => 'campaign'),
                setCampaignPrimaryLoading: vi.fn(),
            },
            campaignCarousel: { isEmpty: vi.fn(() => false) },
            reset: vi.fn(),
            paintCampaignCarousel: vi.fn(),
            applyCampaignLobbyBootstrap: campaignEngineMethods.applyCampaignLobbyBootstrap,
            paintCampaignLobby: campaignEngineMethods.paintCampaignLobby,
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
            showCampaignLobby: campaignEngineMethods.showCampaignLobby,
            loadCampaignLobby: campaignEngineMethods.loadCampaignLobby,
        };

        await context.loadCampaignLobby({ show: true });

        expect(campaignServiceMocks.getCampaignBootstrap).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent forced Campaign bootstrap refreshes', async () => {
        let resolveBootstrap;
        campaignServiceMocks.getCampaignBootstrap.mockReturnValue(new Promise((resolve) => {
            resolveBootstrap = resolve;
        }));
        const context = {
            campaignBootstrap: null,
            _campaignBootstrapReady: false,
            _campaignBootstrapPromise: null,
            _campaignBootstrapRequestId: 0,
            applyCampaignLobbyBootstrap: vi.fn(),
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
        };

        const first = context.ensureCampaignBootstrap({ forceRefresh: true });
        const second = context.ensureCampaignBootstrap({ forceRefresh: true });
        expect(campaignServiceMocks.getCampaignBootstrap).toHaveBeenCalledTimes(1);

        resolveBootstrap({ availability: 'available', authoritative: true });
        await Promise.all([first, second]);
        expect(context.applyCampaignLobbyBootstrap).toHaveBeenCalledTimes(1);
    });

    it('keeps authoritative Campaign state when a refresh is unavailable', async () => {
        const authoritative = {
            availability: 'available',
            authoritative: true,
            progress: { resultsByRaceId: { 'numbered-v1-00': { bestTimeMs: 7000 } } },
        };
        campaignServiceMocks.getCampaignBootstrap.mockResolvedValue({
            availability: 'unavailable',
            authoritative: false,
            progress: { resultsByRaceId: {} },
        });
        const context = {
            campaignBootstrap: authoritative,
            _campaignBootstrapReady: true,
            _campaignBootstrapPromise: null,
            _campaignBootstrapRequestId: 0,
            applyCampaignLobbyBootstrap: vi.fn(),
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
        };

        await expect(context.ensureCampaignBootstrap({ forceRefresh: true }))
            .resolves.toBe(authoritative);
        expect(context.campaignBootstrap).toBe(authoritative);
        expect(context.applyCampaignLobbyBootstrap).not.toHaveBeenCalled();
    });

    it('applies an initial unavailable Campaign bootstrap so startup resolves', async () => {
        const unavailable = {
            availability: 'unavailable',
            authoritative: false,
            progress: { resultsByRaceId: {} },
        };
        campaignServiceMocks.getCampaignBootstrap.mockResolvedValue(unavailable);
        const context = {
            campaignBootstrap: null,
            _campaignBootstrapReady: false,
            _campaignBootstrapPromise: null,
            _campaignBootstrapRequestId: 0,
            applyCampaignLobbyBootstrap: vi.fn(),
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
        };

        await expect(context.ensureCampaignBootstrap({ forceRefresh: true }))
            .resolves.toBe(unavailable);
        expect(context.applyCampaignLobbyBootstrap).toHaveBeenCalledWith(
            unavailable,
            { paint: true },
        );
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

    it('shows a persistent Campaign verification error without its provisional unlock', () => {
        enqueueCampaignVerification({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            bestTime: 8.25,
            lapCount: 2,
            rulesRevision: 1,
            replay: { revision: 1, segments: [] },
        });
        markCampaignVerificationError('numbered-v1-00', 'Result expired — race again.');
        const context = { ...campaignEngineMethods };

        context.applyCampaignLobbyBootstrap({
            campaignId: 'numbered-v1',
            ranked: true,
            signedIn: true,
            stages: CAMPAIGN_STAGES.slice(0, 2),
            progress: { resultsByRaceId: {}, unlockedRaceIds: ['numbered-v1-00'], complete: false },
        });

        expect(context.campaignBootstrap.progress.unlockedRaceIds).toEqual(['numbered-v1-00']);
        expect(context.campaignLobbyState.stages[0]).toMatchObject({
            verificationError: 'Result expired — race again.',
            medal: null,
        });
        clearCampaignVerification('numbered-v1-00');
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
            awaitCampaignVerificationSettled:
                campaignEngineMethods.awaitCampaignVerificationSettled,
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
            campaignVerifiedBootstrap: { ranked: true, signedIn: true, progress: {} },
            campaignLobbyState: {
                complete: false,
                nextStage: { id: 'numbered-v1-00' },
                stages: [{ id: 'numbered-v1-00', unlocked: true }],
            },
            currentTrackKey: 'numberZero',
            trackCanvas: {},
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

    it('resets a completed same-track Campaign run before a ghost replay', async () => {
        campaignServiceMocks.startServerCampaignRace.mockResolvedValue({ ok: true, body: {} });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({
            ok: true,
            body: { personalBest: null },
        });
        const reset = vi.fn(function resetRun(_autoStart, options) {
            this.status = 'ready';
            return options;
        });
        const context = createStartContext({
            status: 'won',
            raceComparisonTarget: { displayName: 'Rival' },
            reset,
        });

        await context.startCampaignStage(
            { raceId: 'numbered-v1-00' },
            { preserveRaceComparisonTarget: true },
        );

        expect(reset).toHaveBeenCalledWith(false, {
            preserveRaceComparisonTarget: true,
            showStartOverlay: false,
        });
        expect(context.loadTrack).not.toHaveBeenCalled();
        expect(context.startSequence).toHaveBeenCalledTimes(1);
        expect(context.startButtonPending).toBe(false);
    });

    it('rebuilds a missing Campaign canvas when the stage track key is unchanged', async () => {
        campaignServiceMocks.startServerCampaignRace.mockResolvedValue({ ok: true, body: {} });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({
            ok: true,
            body: { personalBest: null },
        });
        const context = createStartContext({ trackCanvas: null });

        await context.startCampaignStage();

        expect(context.loadTrack).toHaveBeenCalledWith('numberZero', {
            loadPlayerProgress: false,
            preserveDailyChallengeContext: true,
            preserveRaceComparisonTarget: false,
            showStartOverlayOnReset: false,
        });
        expect(context.startSequence).toHaveBeenCalledTimes(1);
    });

    it('restores Campaign with Retry Start when the selected track cannot load', async () => {
        campaignServiceMocks.startServerCampaignRace.mockResolvedValue({ ok: true, body: {} });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({ ok: false, body: {} });
        const loadCampaignLobby = vi.fn().mockResolvedValue({});
        const setRaceStartError = vi.fn();
        const context = createStartContext({
            currentTrackKey: 'circuit',
            startOverlay: { beginRaceStartTransition: vi.fn(() => Promise.resolve()) },
            lobbyUi: {
                setCampaignPrimaryLoading: vi.fn(),
                clearRaceStartError: vi.fn(),
                setRaceStartError,
            },
            loadTrack: vi.fn().mockRejectedValue(new Error('track chunk failed')),
            loadCampaignLobby,
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await context.startCampaignStage();

        expect(loadCampaignLobby).toHaveBeenCalledWith({ show: true });
        expect(setRaceStartError).toHaveBeenCalledWith(
            'campaign',
            'Track failed to load. Tap Retry Start.',
        );
        expect(context.applyDailyChallenge).not.toHaveBeenCalled();
        expect(context.startSequence).not.toHaveBeenCalled();
        expect(context.startButtonPending).toBe(false);
    });

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
            expect(context.campaignBootstrap.progress).toMatchObject({
                startedAt: '2026-07-26T00:00:00.000Z',
            });
        });
        expect(context.loadCampaignLobby).not.toHaveBeenCalled();
    });

    it('waits for the Campaign lobby exit before starting the countdown', async () => {
        let finishTransition;
        const raceStartTransition = new Promise((resolve) => {
            finishTransition = resolve;
        });
        campaignServiceMocks.startServerCampaignRace.mockResolvedValue({ ok: true, body: {} });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({
            ok: true,
            body: { personalBest: null },
        });
        const context = createStartContext({
            startOverlay: {
                beginRaceStartTransition: vi.fn(() => raceStartTransition),
            },
        });

        const start = context.startCampaignStage();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.startOverlay.beginRaceStartTransition).toHaveBeenCalledTimes(1);
        expect(context.startSequence).not.toHaveBeenCalled();

        finishTransition();
        await start;

        expect(context.startSequence).toHaveBeenCalledTimes(1);
    });

    it('keeps a medal earned while the Campaign start stamp is still in flight', async () => {
        let resolveStart;
        campaignServiceMocks.startServerCampaignRace.mockReturnValue(new Promise((resolve) => {
            resolveStart = resolve;
        }));
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({
            ok: true,
            body: { personalBest: null },
        });
        const context = createStartContext();

        await context.startCampaignStage();
        context.campaignVerifiedBootstrap.progress = {
            resultsByRaceId: {
                'numbered-v1-00': {
                    raceId: 'numbered-v1-00',
                    bestTimeMs: 7_000,
                    medal: 'author',
                },
            },
            unlockedRaceIds: ['numbered-v1-00', 'numbered-v1-01'],
            complete: false,
        };

        resolveStart({
            ok: true,
            body: {
                progress: {
                    startedAt: '2026-07-26T00:00:00.000Z',
                    resultsByRaceId: {},
                    unlockedRaceIds: ['numbered-v1-00'],
                    complete: false,
                },
            },
        });

        await vi.waitFor(() => {
            expect(context.campaignBootstrap.progress.startedAt)
                .toBe('2026-07-26T00:00:00.000Z');
        });
        expect(context.campaignBootstrap.progress.resultsByRaceId['numbered-v1-00'])
            .toMatchObject({ bestTimeMs: 7_000, medal: 'author' });
        expect(context.campaignBootstrap.progress.unlockedRaceIds)
            .toEqual(['numbered-v1-00', 'numbered-v1-01']);
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

    it('holds the next stage start stamp until the run that opened it lands', async () => {
        campaignServiceMocks.startServerCampaignRace.mockResolvedValue({ ok: true, body: {} });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({
            ok: true,
            body: { personalBest: null },
        });
        const nextStage = CAMPAIGN_STAGES[1];
        const context = createStartContext({
            status: 'won',
            activeCampaignStage: CAMPAIGN_STAGES[0],
            campaignLobbyState: {
                complete: false,
                nextStage: { id: nextStage.raceId },
                stages: [{ id: nextStage.raceId, unlocked: true }],
            },
            reset: vi.fn(),
        });
        enqueueCampaignVerification({
            raceId: CAMPAIGN_STAGES[0].raceId,
            trackKey: CAMPAIGN_STAGES[0].trackKey,
            bestTime: 7.3,
            lapCount: 1,
            rulesRevision: 1,
            replay: { revision: 1, segments: [] },
        });

        await context.startCampaignNextStage(nextStage);

        expect(context.startSequence).toHaveBeenCalledTimes(1);
        expect(campaignServiceMocks.startServerCampaignRace).not.toHaveBeenCalled();

        clearCampaignVerification(CAMPAIGN_STAGES[0].raceId);
        await vi.waitFor(() => {
            expect(campaignServiceMocks.startServerCampaignRace)
                .toHaveBeenCalledWith(nextStage.raceId);
        });
        expect(context.loadCampaignLobby).not.toHaveBeenCalled();
    });

    it('keeps racing when the start stamp is refused for a reason that is not the stage', async () => {
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
