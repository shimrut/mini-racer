import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const headToHeadServiceMocks = vi.hoisted(() => ({
    getHeadToHead: vi.fn(),
    submitHeadToHeadRun: vi.fn(),
}));

vi.mock('../game/head-to-head/service.js', async (importOriginal) => ({
    ...(await importOriginal()),
    createHeadToHead: vi.fn(),
    previewHeadToHead: vi.fn(),
    getHeadToHead: headToHeadServiceMocks.getHeadToHead,
    submitHeadToHeadRun: headToHeadServiceMocks.submitHeadToHeadRun,
}));

function stubLocalStorage() {
    const store = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
    });
    return store;
}

import { headToHeadEngineMethods } from '../game/head-to-head/engine-methods.js';
import { LobbyUi } from '../game/lobby/ui.js';
import { GENERIC_SNOO_URL } from '../game/ui/avatar.js';

function challengePaneDom() {
    const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
    const pane = html.match(
        /<section id="lobby-challenge-pane"[\s\S]*?<\/section>/,
    )?.[0];
    expect(pane).toBeTruthy();
    return new JSDOM(pane, { url: 'http://localhost' });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    headToHeadServiceMocks.getHeadToHead.mockReset();
    headToHeadServiceMocks.submitHeadToHeadRun.mockReset();
});

describe('Head to Head lobby and finish', () => {
    it('does not submit or celebrate a run blocked by severe frame stalls', async () => {
        const storedWins = stubLocalStorage();
        const stallMessage = 'Leaderboard rank disabled because the run had severe frame stalls.';
        const setChallengeWinActions = vi.fn();
        const applyCarUnlockSnapshot = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            rankedSubmissionBlockedReason: stallMessage,
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero: vi.fn(),
                setChallengeWinActions,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            showDailyLobby: vi.fn(),
            showCampaignLobby: vi.fn(),
            applyCarUnlockSnapshot,
            settings: { openSettings: vi.fn() },
        };

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 7.5 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            expect.objectContaining({
                lapMedal: null,
                challengeConfirmPhase: 'error',
                challengeConfirmStatus: null,
                challengeConfirmError: stallMessage,
            }),
            expect.objectContaining({
                restartAction: expect.any(Function),
                shareEnabled: false,
            }),
        );
        expect(headToHeadServiceMocks.submitHeadToHeadRun).not.toHaveBeenCalled();
        expect(setChallengeWinActions).not.toHaveBeenCalled();
        expect(applyCarUnlockSnapshot).not.toHaveBeenCalled();
        expect(storedWins.size).toBe(0);
    });

    it.each([
        ['a missing replay', { getPayload: vi.fn(() => null) }],
        ['a stalled run', null],
    ])('settles a losing run without a replay validation despite %s', async (_label, replayStub) => {
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                challengerUsername: 'shimroot',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            rankedSubmissionBlockedReason: replayStub
                ? null
                : 'Leaderboard rank disabled because the run had severe frame stalls.',
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: replayStub
                ?? { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero: vi.fn(),
                setChallengeWinActions: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 8.4 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            expect.objectContaining({
                challengeConfirmPhase: 'lost',
                challengeConfirmError: null,
                challengeVerdict: { opponentName: 'shimroot', deltaSec: 0.4 },
            }),
            expect.anything(),
        );
        expect(headToHeadServiceMocks.submitHeadToHeadRun).not.toHaveBeenCalled();
        expect(context.modal.setChallengeWinActions).not.toHaveBeenCalled();
    });

    it('asks the server to decide when the finish cannot be compared locally', async () => {
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: null,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: { accepted: true, outcome: 'lost', differenceMs: 400 },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 8.4 });

        await vi.waitFor(() => {
            expect(headToHeadServiceMocks.submitHeadToHeadRun).toHaveBeenCalledTimes(1);
        });
        expect(context.modal.updateChallengeFinishHero).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'lost' }),
        );
    });

    it('sends the finish time it claims alongside the replay', async () => {
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero: vi.fn(),
                setChallengeWinActions: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            showDailyLobby: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: { accepted: true, outcome: 'won', differenceMs: -500 },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 7.5 });

        await vi.waitFor(() => {
            expect(headToHeadServiceMocks.submitHeadToHeadRun).toHaveBeenCalledWith(
                expect.objectContaining({ challengeId: 'challenge-1', bestTimeMs: 7_500 }),
            );
        });
    });

    it('does not strand a Head to Head finish when confirmation fails', async () => {
        const modalMsg = { style: {}, textContent: '' };
        const updateChallengeFinishHero = vi.fn();
        const context = {
            activeHeadToHead: {
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
        headToHeadServiceMocks.submitHeadToHeadRun.mockRejectedValue(
            new Error('response interrupted'),
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await headToHeadEngineMethods.handleHeadToHeadWin.call(
            context,
            { lapTime: 7.75 },
        );

        expect(context.modal.showModal).toHaveBeenCalledTimes(1);
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            expect.objectContaining({
                lapTime: 7.75,
                lapMedal: null,
                challengeFinish: true,
                challengeConfirmPhase: 'pending',
            }),
            expect.objectContaining({
                modalKind: 'win',
                shareRequest: {
                    kind: 'challenge-brag',
                    acceptToken: null,
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

    it('patches the hero in place for a claimed win and settles lost/tie without submitting', async () => {
        const modalMsg = { style: {}, textContent: '' };
        const baseContext = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                challengerUsername: 'shimroot',
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

        const settledLap = (phase, deltaSec) => expect.objectContaining({
            lapMedal: null,
            challengeFinish: true,
            challengeConfirmPhase: phase,
            challengeConfirmStatus: null,
            challengeVerdict: { opponentName: 'shimroot', deltaSec },
            showGlobalLeaderboard: false,
        });
        const pendingOptions = expect.objectContaining({
            shareRequest: {
                kind: 'challenge-brag',
                acceptToken: null,
            },
            shareEnabled: false,
            restartAction: expect.any(Function),
        });

        const winShowModal = vi.fn();
        const winUpdateHero = vi.fn();
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'won',
                resultLabel: 'Challenge Won',
                differenceMs: -500,
            },
        });
        await headToHeadEngineMethods.handleHeadToHeadWin.call(
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
            expect.objectContaining({
                lapMedal: null,
                challengeFinish: true,
                challengeConfirmPhase: 'pending',
                challengeVerdict: { opponentName: 'shimroot', deltaSec: -0.5 },
                showGlobalLeaderboard: false,
            }),
            pendingOptions,
        );
        expect(winUpdateHero).not.toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'pending' }),
        );
        await vi.waitFor(() => {
            expect(winUpdateHero).toHaveBeenCalledWith({
                phase: 'won',
                verdict: { opponentName: 'shimroot', deltaSec: -0.5 },
            });
        });
        expect(winShowModal).toHaveBeenCalledTimes(1);

        let answerWin;
        const deferredShowModal = vi.fn();
        const deferredUpdateHero = vi.fn();
        headToHeadServiceMocks.submitHeadToHeadRun.mockReset();
        headToHeadServiceMocks.submitHeadToHeadRun.mockReturnValue(
            new Promise((resolve) => { answerWin = resolve; }),
        );
        await headToHeadEngineMethods.handleHeadToHeadWin.call(
            {
                ...baseContext,
                modal: {
                    modalMsg,
                    showModal: deferredShowModal,
                    updateChallengeFinishHero: deferredUpdateHero,
                },
            },
            { lapTime: 7.5 },
        );
        expect(deferredShowModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            expect.objectContaining({ challengeConfirmPhase: 'pending', lapMedal: null }),
            pendingOptions,
        );
        expect(deferredUpdateHero).not.toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'pending' }),
        );
        answerWin({
            ok: true,
            body: {
                accepted: true,
                outcome: 'won',
                resultLabel: 'Challenge Won',
                differenceMs: -500,
            },
        });
        await vi.waitFor(() => {
            expect(deferredUpdateHero).toHaveBeenCalledWith({
                phase: 'won',
                verdict: { opponentName: 'shimroot', deltaSec: -0.5 },
            });
        });

        headToHeadServiceMocks.submitHeadToHeadRun.mockReset();

        const lossShowModal = vi.fn();
        const lossUpdateHero = vi.fn();
        await headToHeadEngineMethods.handleHeadToHeadWin.call(
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
            settledLap('lost', 0.4),
            pendingOptions,
        );
        // The verdict is settled on screen without waiting, and the hero is left alone
        // because this run earned no personal best to report.
        expect(lossUpdateHero).not.toHaveBeenCalled();

        const tieShowModal = vi.fn();
        const tieUpdateHero = vi.fn();
        await headToHeadEngineMethods.handleHeadToHeadWin.call(
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
        expect(tieShowModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            settledLap('tie', 0),
            pendingOptions,
        );
        expect(tieUpdateHero).not.toHaveBeenCalled();

        // A settled loss or tie is still sent: the run may be the player's best on the stage
        // or Daily the challenge came from, and that best is theirs whatever the challenge said.
        expect(headToHeadServiceMocks.submitHeadToHeadRun).toHaveBeenCalledTimes(2);
    });

    it('swaps the placeholder share request for the accept token a verified win returns', async () => {
        const updateChallengeFinishHero = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'won',
                resultLabel: 'Challenge Won',
                differenceMs: -500,
                acceptToken: 'accept-token-1',
            },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 7.5 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            expect.anything(),
            expect.objectContaining({
                shareRequest: { kind: 'challenge-brag', acceptToken: null },
            }),
        );
        await vi.waitFor(() => {
            expect(updateChallengeFinishHero).toHaveBeenCalledWith({
                shareRequest: { kind: 'challenge-brag', acceptToken: 'accept-token-1' },
            });
        });
    });

    it('still sends a settled loss that can save an origin personal best, without painting origin place', async () => {
        const updateChallengeFinishHero = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: false,
                status: 'target_not_beaten',
                targetTimeMs: 8_000,
                differenceMs: 400,
            },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 8.4 });

        await vi.waitFor(() => {
            expect(headToHeadServiceMocks.submitHeadToHeadRun).toHaveBeenCalledTimes(1);
        });
        expect(updateChallengeFinishHero).not.toHaveBeenCalled();
    });

    it('keeps a settled loss home when it does not beat the best already held', async () => {
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
                viewerBest: { bestTimeMs: 8_200, medal: 'silver', rank: 7 },
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };

        // 8.4s loses the challenge and is slower than the 8.2s already stored, so nothing is sent.
        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 8.4 });

        expect(headToHeadServiceMocks.submitHeadToHeadRun).not.toHaveBeenCalled();
        expect(context.modal.showModal).toHaveBeenCalledWith(
            expect.any(String),
            null,
            expect.objectContaining({
                challengeViewerBest: { bestTimeMs: 8_200, medal: 'silver', rank: 7 },
            }),
            expect.anything(),
        );
    });

    it('sends a settled loss that beats the best already held', async () => {
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
                viewerBest: { bestTimeMs: 8_900, medal: 'bronze' },
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };

        // 8.4s still loses the challenge, but it beats the 8.9s already stored.
        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 8.4 });

        await vi.waitFor(() => {
            expect(headToHeadServiceMocks.submitHeadToHeadRun).toHaveBeenCalledTimes(1);
        });
        expect(context.modal.updateChallengeFinishHero).not.toHaveBeenCalled();
    });

    it('measures the finish against the best already held', async () => {
        const updateChallengeFinishHero = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                challengerUsername: 'shimroot',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
                viewerBest: { bestTimeMs: 8_900, medal: 'bronze' },
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            showDailyLobby: vi.fn(),
            showCampaignLobby: vi.fn(),
            applyCarUnlockSnapshot: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'won',
                bestTimeMs: 7_500,
                differenceMs: -500,
                bestUpdate: { mode: 'daily', improved: true, bestTimeMs: 7_500, rank: 1 },
            },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 7.5 });

        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            expect.objectContaining({
                previousPersonalBestSec: 8.9,
                allowLeaderboardOpen: false,
            }),
            expect.anything(),
        );
        await vi.waitFor(() => {
            expect(updateChallengeFinishHero).toHaveBeenCalledWith(
                expect.objectContaining({ phase: 'won' }),
            );
        });
        expect(updateChallengeFinishHero).not.toHaveBeenCalledWith(
            expect.objectContaining({ bestUpdate: expect.anything() }),
        );
    });

    it('leaves the finish unbraggable when a win comes back without an accept token', async () => {
        const updateChallengeFinishHero = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'won',
                resultLabel: 'Challenge Won',
                differenceMs: -500,
            },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 7.5 });

        await vi.waitFor(() => {
            expect(updateChallengeFinishHero).toHaveBeenCalledWith(
                expect.objectContaining({ phase: 'won' }),
            );
        });
        expect(updateChallengeFinishHero).not.toHaveBeenCalledWith(
            expect.objectContaining({ shareRequest: expect.anything() }),
        );
    });

    it('points a won duel at the other two modes', async () => {
        const setChallengeWinActions = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero: vi.fn(),
                setChallengeWinActions,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            showHomeLobby: vi.fn(),
            showDailyLobby: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'won',
                resultLabel: 'Challenge Won',
                bestTimeMs: 7_528,
                differenceMs: -472,
            },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 7.5 });

        await vi.waitFor(() => {
            expect(setChallengeWinActions).toHaveBeenCalledWith({
                dailyAction: expect.any(Function),
                campaignAction: expect.any(Function),
            });
        });
        expect(setChallengeWinActions).toHaveBeenCalledTimes(1);
        const { dailyAction, campaignAction } = setChallengeWinActions.mock.calls.at(-1)[0];
        dailyAction();
        campaignAction();
        expect(context.showDailyLobby).toHaveBeenCalledTimes(1);
        expect(context.showCampaignLobby).toHaveBeenCalledTimes(1);
    });

    it('ignores a stale attempt answering after the racer has retried', async () => {
        stubLocalStorage();
        const updateChallengeFinishHero = vi.fn();
        const setChallengeWinActions = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero,
                setChallengeWinActions,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            showHomeLobby: vi.fn(),
            showDailyLobby: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };

        let answerFirstAttempt;
        headToHeadServiceMocks.submitHeadToHeadRun.mockReturnValueOnce(
            new Promise((resolve) => { answerFirstAttempt = resolve; }),
        );
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'won',
                bestTimeMs: 7_400,
                differenceMs: -600,
                acceptToken: 'accept-token-second',
            },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 7.9 });
        context.status = 'racing';
        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 7.4 });
        await vi.waitFor(() => {
            expect(updateChallengeFinishHero).toHaveBeenCalledWith(
                expect.objectContaining({ phase: 'won' }),
            );
        });

        answerFirstAttempt({
            ok: true,
            body: {
                accepted: true,
                outcome: 'lost',
                bestTimeMs: 8_400,
                differenceMs: 400,
                acceptToken: 'accept-token-first',
            },
        });
        await vi.waitFor(() => {
            expect(headToHeadServiceMocks.submitHeadToHeadRun).toHaveBeenCalledTimes(2);
        });

        expect(updateChallengeFinishHero).not.toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'lost' }),
        );
        expect(updateChallengeFinishHero).not.toHaveBeenCalledWith({
            shareRequest: { kind: 'challenge-brag', acceptToken: 'accept-token-first' },
        });
    });

    it.each([
        ['lost', 8.4, 'lost', null],
        ['tie', 8, 'tie', null],
        ['unverified', 7.5, 'error', { accepted: false, error: 'This run could not be verified.' }],
    ])('keeps the retry path on a %s finish', async (_label, lapTime, expectedPhase, body) => {
        const setChallengeWinActions = vi.fn();
        const clearChallengeWinActions = vi.fn();
        const updateChallengeFinishHero = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                trackKey: 'numberZero',
                lapCount: 1,
                targetTimeMs: 8_000,
            },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateChallengeFinishHero,
                setChallengeWinActions,
                clearChallengeWinActions,
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            showHomeLobby: vi.fn(),
            showDailyLobby: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        if (body) headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({ ok: true, body });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime });

        if (body) {
            await vi.waitFor(() => {
                expect(updateChallengeFinishHero).toHaveBeenCalledWith(
                    expect.objectContaining({ phase: expectedPhase }),
                );
            });
            expect(setChallengeWinActions).not.toHaveBeenCalled();
        } else {
            // The verdict settled on screen without waiting, but the run still went out so a
            // personal best could be claimed. With none reported, the hero is left as it was.
            expect(headToHeadServiceMocks.submitHeadToHeadRun).toHaveBeenCalledTimes(1);
            expect(updateChallengeFinishHero).not.toHaveBeenCalled();
            expect(setChallengeWinActions).not.toHaveBeenCalled();
        }
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            body
                ? expect.anything()
                : expect.objectContaining({ challengeConfirmPhase: expectedPhase }),
            expect.objectContaining({ restartAction: expect.any(Function) }),
        );
    });

    it('carries a beaten outcome into the challenge poster it returns to', async () => {
        headToHeadServiceMocks.getHeadToHead.mockResolvedValue({
            ok: true,
            status: 200,
            body: {
                status: 'ready',
                viewerType: 'reddit',
                challenge: {
                    challengeId: 'challenge-1',
                    challengerUsername: 'RaceFan',
                    trackKey: 'numberThree',
                    lapCount: 2,
                    targetTimeMs: 25_640,
                },
            },
        });
        const showChallenge = vi.fn();
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            activeHeadToHead: null,
            hasAnyData: true,
            isReturningPlayer: true,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: { showChallenge },
        };

        await headToHeadEngineMethods.loadChallengeLobby.call(
            context,
            'challenge-1',
            { outcome: 'won', bestTimeMs: 25_168 },
        );
        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({
            outcome: 'won',
            bestTimeMs: 25_168,
        }));

        showChallenge.mockClear();
        await headToHeadEngineMethods.loadChallengeLobby.call(context, 'challenge-1');
        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({ outcome: null }));
    });

    it('shows the win again when the post is reopened inside the stored window', async () => {
        const store = stubLocalStorage();
        const { rememberHeadToHeadWin } = await import('../game/head-to-head/service.js');
        rememberHeadToHeadWin('challenge-1', 25_168);
        expect(store.size).toBe(1);

        headToHeadServiceMocks.getHeadToHead.mockResolvedValue({
            ok: true,
            status: 200,
            body: {
                status: 'ready',
                viewerType: 'reddit',
                challenge: {
                    challengeId: 'challenge-1',
                    challengerUsername: 'RaceFan',
                    trackKey: 'numberThree',
                    lapCount: 2,
                    targetTimeMs: 25_640,
                },
            },
        });
        const showChallenge = vi.fn();
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            activeHeadToHead: null,
            hasAnyData: true,
            isReturningPlayer: true,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: { showChallenge },
        };

        await headToHeadEngineMethods.loadChallengeLobby.call(context, 'challenge-1');

        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({
            outcome: 'won',
            bestTimeMs: 25_168,
        }));
    });

    it('does not carry a stored win onto a different challenge or past its window', async () => {
        const { rememberHeadToHeadWin, readHeadToHeadWin } = await import(
            '../game/head-to-head/service.js'
        );

        stubLocalStorage();
        rememberHeadToHeadWin('challenge-1', 25_168);
        expect(readHeadToHeadWin('challenge-2')).toBeNull();
        expect(readHeadToHeadWin('challenge-1')).toEqual({
            outcome: 'won',
            bestTimeMs: 25_168,
        });

        const expired = stubLocalStorage();
        expired.set('MiniRacerHeadToHeadWin', JSON.stringify({
            challengeId: 'challenge-1',
            bestTimeMs: 25_168,
            expiresAt: Date.now() - 1,
        }));
        expect(readHeadToHeadWin('challenge-1')).toBeNull();
        expect(expired.size).toBe(0);
    });

    it('bounces own challenges Home without showing Accept', async () => {
        headToHeadServiceMocks.getHeadToHead.mockResolvedValue({
            ok: false,
            status: 403,
            body: {
                status: 'own_challenge',
                error: "You can't accept your own challenge.",
            },
        });
        const showHomeLobby = vi.fn();
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            activeHeadToHead: { challengeId: 'stale' },
            hasAnyData: true,
            isReturningPlayer: false,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: { showChallenge: vi.fn() },
            reset: vi.fn(),
            showHomeLobby,
        };

        await headToHeadEngineMethods.loadChallengeLobby.call(context, 'challenge-1');

        expect(context.activeHeadToHead).toBeNull();
        expect(showHomeLobby).toHaveBeenCalledTimes(1);
        expect(context.lobbyUi.showChallenge).not.toHaveBeenCalled();
        expect(context.startOverlay.showStartOverlay).not.toHaveBeenCalled();
    });

    it('keeps an anonymous ready challenge raceable for guest entry', async () => {
        headToHeadServiceMocks.getHeadToHead.mockResolvedValue({
            ok: true,
            status: 200,
            body: {
                status: 'ready',
                viewerType: 'anonymous',
                challenge: {
                    challengeId: 'challenge-1',
                    challengerUsername: 'RaceFan',
                    trackKey: 'numberThree',
                    lapCount: 2,
                    targetTimeMs: 25_640,
                    medal: 'gold',
                },
            },
        });
        const showChallenge = vi.fn();
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            activeHeadToHead: null,
            hasAnyData: false,
            isReturningPlayer: false,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: { showChallenge },
        };

        await headToHeadEngineMethods.loadChallengeLobby.call(context, 'challenge-1');

        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({
            signedIn: false,
            canRace: true,
            available: true,
        }));
    });

    it('turns a failed challenge load into a retryable lobby state', async () => {
        const showChallenge = vi.fn();
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            activeHeadToHead: { challengeId: 'stale' },
            hasAnyData: false,
            isReturningPlayer: false,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: { showChallenge },
        };
        headToHeadServiceMocks.getHeadToHead.mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await headToHeadEngineMethods.loadChallengeLobby.call(context, 'challenge-1');

        expect(context.activeHeadToHead).toBeNull();
        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({
            canRace: false,
            canRetry: true,
            statusMessage: 'Could not load this challenge. Check your connection and try again.',
        }));
    });

    it('turns failed challenge track preparation into a retryable lobby state', async () => {
        const showChallenge = vi.fn();
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            activeHeadToHead: null,
            hasAnyData: false,
            isReturningPlayer: false,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: { showChallenge },
            loadTrack: vi.fn().mockRejectedValue(new Error('track chunk failed')),
        };
        headToHeadServiceMocks.getHeadToHead.mockResolvedValue({
            ok: true,
            status: 200,
            body: {
                status: 'ready',
                viewerType: 'guest',
                challenge: {
                    challengeId: 'challenge-1',
                    raceId: 'numbered-v1-00',
                    trackKey: 'numberZero',
                    lapCount: 1,
                    rulesRevision: 1,
                    targetTimeMs: 8_000,
                },
            },
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await headToHeadEngineMethods.loadChallengeLobby.call(context, 'challenge-1');

        expect(context.activeHeadToHead).toBeNull();
        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({
            canRace: false,
            canRetry: true,
            statusMessage: 'Could not prepare this track. Try again.',
        }));
    });

    it('initializes the challenge track even when it matches the default key', async () => {
        const loadTrack = vi.fn().mockResolvedValue(undefined);
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                lapCount: 2,
                rulesRevision: 1,
                targetTimeMs: 8_000,
                frozenGhost: null,
            },
            startButtonPending: false,
            currentTrackKey: 'numberZero',
            trackCanvas: null,
            trackPersonalBestByTrackKey: {},
            pbGhost: { clearTrack: vi.fn() },
            journeys: { startAttempt: vi.fn() },
            loadTrack,
            applyDailyChallenge: vi.fn(),
            startSequence: vi.fn(),
        };

        await headToHeadEngineMethods.startHeadToHead.call(context);

        expect(loadTrack).toHaveBeenCalledWith('numberZero', {
            loadPlayerProgress: false,
            preserveDailyChallengeContext: true,
            showStartOverlayOnReset: false,
        });
        expect(context.startSequence).toHaveBeenCalledTimes(1);
    });

    it('restores Head to Head with Retry Start when race track loading fails', async () => {
        const showChallenge = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                lapCount: 2,
                rulesRevision: 1,
                targetTimeMs: 8_000,
            },
            hasAnyData: false,
            isReturningPlayer: false,
            startButtonPending: false,
            currentTrackKey: 'circuit',
            trackCanvas: {},
            trackPersonalBestByTrackKey: {},
            pbGhost: { clearTrack: vi.fn() },
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: {
                challengeState: { canRace: true, trackName: 'Number Zero' },
                showChallenge,
            },
            loadTrack: vi.fn().mockRejectedValue(new Error('track chunk failed')),
            applyDailyChallenge: vi.fn(),
            startSequence: vi.fn(),
            journeys: { startAttempt: vi.fn() },
        };
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await headToHeadEngineMethods.startHeadToHead.call(context);

        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({
            canRace: true,
            startError: true,
            statusMessage: 'Could not prepare this track. Tap Retry Start.',
        }));
        expect(context.applyDailyChallenge).not.toHaveBeenCalled();
        expect(context.startSequence).not.toHaveBeenCalled();
        expect(context.startButtonPending).toBe(false);
    });

    it('gives the challenger ghost a random garage skin different from the acceptor', async () => {
        const frozenGhost = { schemaVersion: 2, samples: [] };
        const installedTarget = { displayName: 'RaceFan', carAssetName: 'assets/cars/mr_mr_blue.webp' };
        const installRaceComparisonTarget = vi.fn(() => installedTarget);
        const prepareOpponent = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                lapCount: 2,
                rulesRevision: 1,
                targetTimeMs: 8_000,
                challengerUsername: '  RaceFan  ',
                frozenGhost,
            },
            startButtonPending: false,
            currentTrackKey: 'numberZero',
            trackCanvas: {},
            trackPersonalBestByTrackKey: {},
            pbGhost: { clearTrack: vi.fn(), prepareOpponent },
            journeys: { startAttempt: vi.fn() },
            clearRaceComparisonTarget: vi.fn(),
            installRaceComparisonTarget,
            applyDailyChallenge: vi.fn(),
            startSequence: vi.fn(),
        };

        await headToHeadEngineMethods.startHeadToHead.call(context);

        expect(context.clearRaceComparisonTarget).toHaveBeenCalledTimes(1);
        expect(installRaceComparisonTarget).toHaveBeenCalledWith(
            {
                displayName: 'RaceFan',
                bestTimeMs: 8_000,
                ghost: frozenGhost,
            },
            { lapCount: 2 },
        );
        expect(prepareOpponent).not.toHaveBeenCalled();
        expect(context.startSequence).toHaveBeenCalledTimes(1);
    });

    it('still prepares the challenger ghost when the comparison target cannot be installed', async () => {
        const frozenGhost = { schemaVersion: 2, samples: [] };
        const prepareOpponent = vi.fn();
        const context = {
            activeHeadToHead: {
                challengeId: 'challenge-1',
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                lapCount: 1,
                rulesRevision: 1,
                targetTimeMs: 8_000,
                frozenGhost,
            },
            startButtonPending: false,
            currentTrackKey: 'numberZero',
            trackCanvas: {},
            trackPersonalBestByTrackKey: {},
            pbGhost: { clearTrack: vi.fn(), prepareOpponent },
            journeys: { startAttempt: vi.fn() },
            installRaceComparisonTarget: vi.fn(() => null),
            applyDailyChallenge: vi.fn(),
            startSequence: vi.fn(),
        };

        await headToHeadEngineMethods.startHeadToHead.call(context);

        expect(prepareOpponent).toHaveBeenCalledWith({
            bestTimeMs: 8_000,
            ghost: frozenGhost,
        });
        expect(context.startSequence).toHaveBeenCalledTimes(1);
    });

    it('keeps a permanent challenge error unavailable instead of offering Retry', async () => {
        const showChallenge = vi.fn();
        const context = {
            status: 'ready',
            currentChallengeRun: null,
            activeHeadToHead: null,
            hasAnyData: true,
            isReturningPlayer: true,
            startOverlay: { showStartOverlay: vi.fn() },
            lobbyUi: { showChallenge },
        };
        headToHeadServiceMocks.getHeadToHead.mockResolvedValue({
            ok: false,
            status: 404,
            body: {
                status: 'challenge_unavailable',
                error: 'This challenge is unavailable.',
            },
        });

        await headToHeadEngineMethods.loadChallengeLobby.call(context, 'expired-challenge');

        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({
            canRace: false,
            canRetry: false,
            available: false,
            statusMessage: 'This challenge is unavailable.',
        }));
    });

    it('retries a failed challenge load without issuing duplicate requests', async () => {
        const loadChallengeLobby = vi.fn(async () => undefined);
        const showChallenge = vi.fn();
        const context = {
            headToHeadChallengeId: 'challenge-1',
            headToHeadLoadPending: false,
            lobbyUi: {
                challengeState: {
                    canRetry: true,
                    available: false,
                    statusMessage: 'Could not load this challenge. Try again.',
                },
                showChallenge,
            },
            loadChallengeLobby,
        };

        const firstRetry = headToHeadEngineMethods.retryHeadToHead.call(context);
        const secondRetry = headToHeadEngineMethods.retryHeadToHead.call(context);
        await Promise.all([firstRetry, secondRetry]);

        expect(loadChallengeLobby).toHaveBeenCalledTimes(1);
        expect(showChallenge).toHaveBeenCalledWith(expect.objectContaining({
            canRetry: true,
            challengeLoading: true,
            statusMessage: 'Retrying challenge…',
        }));
        expect(context.headToHeadLoadPending).toBe(false);
    });
});

describe('Head to Head poster after the duel is beaten', () => {
    const readyState = {
        signedIn: true,
        canRace: true,
        available: true,
        challengerName: 'RaceFan',
        trackName: 'Number Three',
        laps: 2,
        targetTimeMs: 25_640,
    };

    function renderPane(state) {
        const originalDocument = global.document;
        const originalRaf = global.requestAnimationFrame;
        const dom = challengePaneDom();
        global.document = dom.window.document;
        global.requestAnimationFrame = (callback) => callback();
        const lobby = new LobbyUi({});
        lobby.mode = 'challenge';
        lobby.renderChallengePreview = vi.fn();
        lobby.syncLobbySubheadDetail = vi.fn();
        lobby.focus = vi.fn();
        try {
            lobby.showChallenge(state);
        } finally {
            global.document = originalDocument;
            global.requestAnimationFrame = originalRaf;
        }
        return dom.window.document;
    }

    it('puts the best the accepter already holds opposite the time to beat', () => {
        const document = renderPane({ ...readyState, viewerBestTimeMs: 26_500 });

        expect(document.getElementById('challenge-target-time').textContent).toBe('0:25.640');
        expect(document.getElementById('challenge-viewer-best-time').textContent).toBe('0:26.500');
        expect(document.getElementById('challenge-viewer-figures').hidden).toBe(false);
        expect(document.getElementById('challenge-viewer-figures')
            .querySelector('.challenge-racer__label').textContent).toBe('Your PB');
    });

    it('leaves the accepter side empty when they hold no time there', () => {
        for (const viewerBestTimeMs of [undefined, null, 0, -1, Number.NaN]) {
            const document = renderPane({ ...readyState, viewerBestTimeMs });
            expect(document.getElementById('challenge-viewer-figures').hidden).toBe(true);
        }
    });

    it('makes a transient failure actionable with the existing Retry button', () => {
        const originalDocument = global.document;
        const originalRaf = global.requestAnimationFrame;
        const dom = challengePaneDom();
        const onRetryChallenge = vi.fn();
        global.document = dom.window.document;
        global.requestAnimationFrame = (callback) => callback();
        const lobby = new LobbyUi({ onRetryChallenge });
        lobby.mode = 'challenge';
        lobby.renderChallengePreview = vi.fn();
        lobby.syncLobbySubheadDetail = vi.fn();
        lobby.focus = vi.fn();
        try {
            lobby.bind();
            lobby.showChallenge({
                available: false,
                canRace: false,
                canRetry: true,
                statusMessage: 'Could not load this challenge. Try again.',
            });

            const button = dom.window.document.getElementById('challenge-accept-btn');
            expect(button.disabled).toBe(false);
            expect(button.querySelector('.main-menu__label').textContent).toBe('Retry');
            button.click();
            expect(onRetryChallenge).toHaveBeenCalledTimes(1);
        } finally {
            global.document = originalDocument;
            global.requestAnimationFrame = originalRaf;
        }
    });

    it('puts the winner and their medal where the track poster was', () => {
        const doc = renderPane({ ...readyState, outcome: 'won', bestTimeMs: 25_168 });

        expect(doc.getElementById('challenge-poster').hidden).toBe(true);
        expect(doc.getElementById('challenge-won-hero').hidden).toBe(false);
        expect(doc.getElementById('challenge-won-medal')
            .querySelector('.medal-svg--challenge')).not.toBeNull();
        expect(doc.querySelector('.challenge-won-hero__title').textContent.trim())
            .toBe('Challenge beaten');
        expect(doc.getElementById('challenge-won-summary').textContent)
            .toBe('You beat u/RaceFan by 0.472s.');

        expect(doc.getElementById('challenge-accept-btn').hidden).toBe(true);
        expect(doc.getElementById('challenge-won-cta').hidden).toBe(false);
        expect(doc.getElementById('challenge-won-daily-btn')).not.toBeNull();
        expect(doc.getElementById('challenge-won-campaign-btn')).not.toBeNull();
    });

    it('still congratulates when the win arrived without a time', () => {
        const doc = renderPane({ ...readyState, outcome: 'won' });

        expect(doc.getElementById('challenge-won-hero').hidden).toBe(false);
        expect(doc.getElementById('challenge-won-summary').textContent)
            .toBe('You beat u/RaceFan.');
        expect(doc.getElementById('challenge-won-cta').hidden).toBe(false);
    });

    it('carries Garage and Settings into the duel, but not Standings', () => {
        const lobbyCss = readFileSync(
            new URL('../styles/lobby-modes.css', import.meta.url),
            'utf8',
        );
        expect(lobbyCss).toMatch(
            /body\[data-lobby-mode="challenge"\] \.lobby-mode-toolbar,[\s\S]*?body\[data-lobby-mode="campaign"\] \.lobby-mode-toolbar\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*display:\s*flex;/s,
        );
        expect(lobbyCss).toMatch(
            /body\[data-lobby-mode="challenge"\] #lobby-mode-standings-btn\s*\{[^}]*display:\s*none;/s,
        );
    });

    it('names the challenger over the time they set', () => {
        const doc = renderPane(readyState);

        expect(doc.getElementById('challenge-challenger-name').textContent)
            .toBe('u/RaceFan');
        expect(doc.body.textContent).not.toContain('Time to beat');
    });

    it('seats a racer with no avatar behind the same default Snoo the poster shows', () => {
        const doc = renderPane(readyState);

        for (const id of ['challenge-challenger-avatar', 'challenge-viewer-avatar']) {
            const avatar = doc.getElementById(id);
            expect(avatar.src).toBe(GENERIC_SNOO_URL);
            expect(avatar.classList.contains('challenge-avatar--generic')).toBe(true);
        }
    });

    it('seats the winner behind the default Snoo when they have none of their own', () => {
        const doc = renderPane({ ...readyState, outcome: 'won', bestTimeMs: 25_168 });
        const avatar = doc.getElementById('challenge-won-avatar');

        expect(avatar.src).toBe(GENERIC_SNOO_URL);
        expect(avatar.classList.contains('challenge-avatar--generic')).toBe(true);
    });

    it('gives a racer their own avatar the plain seat, not the Snoo plate', () => {
        const doc = renderPane({
            ...readyState,
            challengerAvatarUrl: 'https://i.redd.it/RaceFan.png',
            viewerAvatarUrl: 'https://i.redd.it/OtherRacer.png',
        });

        const challenger = doc.getElementById('challenge-challenger-avatar');
        expect(challenger.src).toBe('https://i.redd.it/RaceFan.png');
        expect(challenger.classList.contains('challenge-avatar--generic')).toBe(false);
        expect(challenger.alt).toBe('u/RaceFan avatar');
    });

    it('leaves an unbeaten duel offering Accept over its track', () => {
        const doc = renderPane(readyState);

        expect(doc.getElementById('challenge-poster').hidden).toBe(false);
        expect(doc.getElementById('challenge-won-hero').hidden).toBe(true);
        expect(doc.getElementById('challenge-accept-btn').hidden).toBe(false);
        expect(doc.getElementById('challenge-accept-btn').disabled).toBe(false);
        expect(doc.getElementById('challenge-won-cta').hidden).toBe(true);
    });

    it('sends both invitation buttons to the mode they name', () => {
        const originalDocument = global.document;
        const dom = challengePaneDom();
        global.document = dom.window.document;
        const onSelectDaily = vi.fn();
        const onSelectCampaign = vi.fn();
        const lobby = new LobbyUi({ onSelectDaily, onSelectCampaign });
        lobby.mode = 'challenge';
        lobby.renderChallengePreview = vi.fn();
        lobby.syncLobbySubheadDetail = vi.fn();

        lobby.bind();
        dom.window.document.getElementById('challenge-won-daily-btn').click();
        dom.window.document.getElementById('challenge-won-campaign-btn').click();

        global.document = originalDocument;
        expect(onSelectDaily).toHaveBeenCalledTimes(1);
        expect(onSelectCampaign).toHaveBeenCalledTimes(1);
    });
});
