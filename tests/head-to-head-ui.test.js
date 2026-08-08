import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const headToHeadServiceMocks = vi.hoisted(() => ({
    getHeadToHead: vi.fn(),
    submitHeadToHeadRun: vi.fn(),
}));

// Only the calls that go to the server are faked, so a new export here cannot
// silently go missing from the mock.
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

/** The real challenge pane, so the markup and the render stay honest about each other. */
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

    it('patches medal hero in place: pending then won/lost/tie; Brag only after verified win', async () => {
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

        const pendingLap = expect.objectContaining({
            lapMedal: null,
            challengeFinish: true,
            challengeConfirmPhase: 'pending',
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
        // A run that already beat the target opens on the win it earned — the
        // server only has to agree, and the winner never sees "Submitting...".
        expect(winShowModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            // The margin rides on the verdict line the hero already shows, so a
            // beaten challenge states what it was beaten by from the first frame.
            expect.objectContaining({
                lapMedal: 'challenge',
                challengeFinish: true,
                challengeConfirmPhase: 'won',
                challengeVerdict: { opponentName: 'shimroot', deltaSec: -0.5 },
                showGlobalLeaderboard: false,
            }),
            pendingOptions,
        );
        await vi.waitFor(() => {
            expect(winUpdateHero).toHaveBeenCalledWith({
                phase: 'won',
                verdict: { opponentName: 'shimroot', deltaSec: -0.5 },
            });
        });
        expect(winUpdateHero).not.toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'pending' }),
        );
        expect(winShowModal).toHaveBeenCalledTimes(1);

        const lossShowModal = vi.fn();
        const lossUpdateHero = vi.fn();
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'lost',
                resultLabel: 'Challenge Lost',
                differenceMs: 400,
            },
        });
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
            pendingLap,
            pendingOptions,
        );
        await vi.waitFor(() => {
            // A loss is owed the same number the win got.
            expect(lossUpdateHero).toHaveBeenCalledWith({
                phase: 'lost',
                verdict: { opponentName: 'shimroot', deltaSec: 0.4 },
            });
        });
        expect(lossShowModal).toHaveBeenCalledTimes(1);

        const tieShowModal = vi.fn();
        const tieUpdateHero = vi.fn();
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({
            ok: true,
            body: {
                accepted: true,
                outcome: 'tie',
                resultLabel: 'Tie',
                differenceMs: 0,
            },
        });
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
        await vi.waitFor(() => {
            expect(tieUpdateHero).toHaveBeenCalledWith({
                phase: 'tie',
                verdict: { opponentName: 'shimroot', deltaSec: 0 },
            });
        });
        expect(tieShowModal).toHaveBeenCalledTimes(1);
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

        // The finish opens with no token to brag with; only the verified run earns one.
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
                outcome: 'lost',
                resultLabel: 'Challenge Lost',
                differenceMs: 400,
            },
        });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 8.4 });

        await vi.waitFor(() => {
            expect(updateChallengeFinishHero).toHaveBeenCalledWith(
                expect.objectContaining({ phase: 'lost' }),
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
        // A run that already beat the target gets the winner's action row at once,
        // then again once the server has verified the time.
        expect(setChallengeWinActions).toHaveBeenCalledTimes(2);
        const { dailyAction, campaignAction } = setChallengeWinActions.mock.calls.at(-1)[0];
        dailyAction();
        campaignAction();
        // The duel is finished, so both exits are the way on to another mode.
        expect(context.showDailyLobby).toHaveBeenCalledTimes(1);
        expect(context.showCampaignLobby).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['lost', { accepted: true, outcome: 'lost', differenceMs: 400 }],
        ['tie', { accepted: true, outcome: 'tie', differenceMs: 0 }],
        ['unverified', { accepted: false, error: 'This run could not be verified.' }],
    ])('keeps the retry path on a %s finish', async (_label, body) => {
        const setChallengeWinActions = vi.fn();
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
            },
            restartActiveRace: vi.fn(),
            loadChallengeLobby: vi.fn(),
            showHomeLobby: vi.fn(),
            showDailyLobby: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        headToHeadServiceMocks.submitHeadToHeadRun.mockResolvedValue({ ok: true, body });

        await headToHeadEngineMethods.handleHeadToHeadWin.call(context, { lapTime: 8.4 });

        await vi.waitFor(() => {
            expect(updateChallengeFinishHero).toHaveBeenCalledWith(
                expect.objectContaining({ phase: expect.stringMatching(/lost|tie|error/) }),
            );
        });
        // Improve stays: a duel that was not beaten is still worth another run.
        expect(setChallengeWinActions).not.toHaveBeenCalled();
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Challenge complete',
            null,
            expect.anything(),
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

        // An ordinary arrival carries no verdict, so the poster still offers Accept.
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

        // A cold open with no verdict in hand still lands on the winner's screen.
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
        // The stale receipt is dropped rather than left to be re-read.
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

    it('puts the winner and their medal where the track poster was', () => {
        const doc = renderPane({ ...readyState, outcome: 'won', bestTimeMs: 25_168 });

        expect(doc.getElementById('challenge-poster').hidden).toBe(true);
        expect(doc.getElementById('challenge-won-hero').hidden).toBe(false);
        // The same medal the finish sheet just handed them.
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
        // The duel joins the modes that pin the shared toolbar to their header —
        // no second toolbar, no second rule.
        expect(lobbyCss).toMatch(
            /body\[data-lobby-mode="challenge"\] \.lobby-mode-toolbar,[\s\S]*?body\[data-lobby-mode="campaign"\] \.lobby-mode-toolbar\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*display:\s*flex;/s,
        );
        // A duel has one track and one time; there is no table to stand in.
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

    // A racer with no Snoovatar is the common case, not an edge one, and the
    // poster and the podium both seat them behind Reddit's own default Snoo.
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
