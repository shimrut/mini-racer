import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const campaignServiceMocks = vi.hoisted(() => ({
    getCampaignBootstrap: vi.fn(),
    getCampaignChallenge: vi.fn(),
    getCampaignPbGhost: vi.fn(),
    getCampaignSnapshot: vi.fn(),
    readLocalCampaignProgress: vi.fn(() => ({
        campaignId: 'numbered-v1',
        startedAt: null,
        resultsByRaceId: {},
        unlockedRaceIds: ['numbered-v1-00'],
        complete: false,
        continueRaceId: 'numbered-v1-00',
    })),
    startServerCampaignRace: vi.fn(),
    startLocalCampaign: vi.fn(),
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
    readLocalCampaignProgress: campaignServiceMocks.readLocalCampaignProgress,
    saveLocalCampaignFinish: vi.fn(),
    startLocalCampaign: campaignServiceMocks.startLocalCampaign,
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

function campaignState() {
    return {
        progressLabel: '1 / 3 Gold',
        complete: false,
        nextStage: { id: 'numbered-v1-01' },
        stages: [
            {
                id: 'numbered-v1-00',
                numberLabel: '00',
                trackName: 'Number Zero',
                laps: 1,
                unlocked: true,
                bestTimeLabel: '0:06.200',
                medal: 'Gold',
            },
            {
                id: 'numbered-v1-01',
                numberLabel: '01',
                trackName: 'Number One',
                laps: 1,
                unlocked: true,
                bestTimeLabel: 'No time',
                medal: null,
            },
            {
                id: 'numbered-v1-02',
                numberLabel: '02',
                trackName: 'Number Two',
                laps: 1,
                unlocked: false,
                bestTimeLabel: 'No time',
                medal: null,
            },
        ],
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    campaignServiceMocks.getCampaignBootstrap.mockReset();
    campaignServiceMocks.getCampaignChallenge.mockReset();
    campaignServiceMocks.getCampaignPbGhost.mockReset();
    campaignServiceMocks.getCampaignSnapshot.mockReset();
    campaignServiceMocks.readLocalCampaignProgress.mockReset();
    campaignServiceMocks.readLocalCampaignProgress.mockReturnValue({
        campaignId: 'numbered-v1',
        startedAt: null,
        resultsByRaceId: {},
        unlockedRaceIds: ['numbered-v1-00'],
        complete: false,
        continueRaceId: 'numbered-v1-00',
    });
    campaignServiceMocks.startServerCampaignRace.mockReset();
    campaignServiceMocks.startLocalCampaign.mockReset();
    campaignServiceMocks.submitCampaignChallengeRun.mockReset();
    campaignServiceMocks.submitCampaignRun.mockReset();
});

describe('Campaign lobby and shared modal adapters', () => {
    it('still opens the saved result when PB ghost and lobby refreshes fail', async () => {
        const modalMsg = { style: {}, textContent: '' };
        const context = {
            activeCampaignStage: {
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                lapCount: 1,
            },
            currentChallengeRun: {},
            campaignBootstrap: { signedIn: true, progress: {} },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            pbGhost: { prepare: vi.fn() },
            trackPersonalBestByTrackKey: {},
            loadCampaignLobby: vi.fn().mockRejectedValue(new Error('bootstrap offline')),
            modal: {
                modalMsg,
                showModal: vi.fn(),
                updateModalScoreboardSnapshot: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
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
                rows: [{ rank: 1, displayName: 'You', bestTimeMs: 8250, isCurrentPlayer: true }],
                currentPlayerRow: {
                    rank: 1,
                    displayName: 'You',
                    bestTimeMs: 8250,
                    isCurrentPlayer: true,
                },
                totalCount: 3,
                pageOffset: 0,
                pageLimit: 50,
                hasMore: false,
                nextOffset: null,
            },
        });
        campaignServiceMocks.getCampaignPbGhost.mockRejectedValue(new Error('ghost offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await campaignEngineMethods.handleCampaignWin.call(context, { lapTime: 8.25 });
        await vi.waitFor(() => {
            expect(context.modal.updateModalScoreboardSnapshot).toHaveBeenCalledWith(
                expect.objectContaining({
                    playerRankLabel: '#1',
                    totalCount: 3,
                }),
            );
        });
        expect(context.status).toBe('won');
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
        expect(modalMsg.textContent).toBe('Number Zero · 1 lap');
    });

    it('shows an actionable result instead of freezing when submission confirmation fails', async () => {
        const modalMsg = { style: {}, textContent: '' };
        const context = {
            activeCampaignStage: {
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                lapCount: 1,
            },
            currentChallengeRun: {},
            campaignBootstrap: { signedIn: true, progress: {} },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            pbGhost: { prepare: vi.fn() },
            trackPersonalBestByTrackKey: {},
            loadCampaignLobby: vi.fn().mockResolvedValue({}),
            modal: {
                modalMsg,
                showModal: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        campaignServiceMocks.submitCampaignRun.mockRejectedValue(new Error('response interrupted'));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await campaignEngineMethods.handleCampaignWin.call(context, { lapTime: 8.25 });
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({ lapTime: 8.25 }),
            expect.objectContaining({ modalKind: 'win' }),
        );

        await vi.waitFor(() => {
            expect(context.modal.showModal).toHaveBeenLastCalledWith(
                'Result not confirmed',
                null,
                expect.objectContaining({ lapTime: 8.25 }),
                expect.objectContaining({
                    modalKind: 'rejected',
                    shareRequest: null,
                }),
            );
        });
        expect(modalMsg.textContent).toBe(
            'Race finished, but the result could not be confirmed. Check Campaign progress before retrying.',
        );
    });

    it('opens the finish modal before Campaign submission settles', async () => {
        let resolveSubmission;
        const context = {
            activeCampaignStage: {
                raceId: 'numbered-v1-00',
                trackKey: 'numberZero',
                lapCount: 1,
            },
            currentChallengeRun: {},
            campaignBootstrap: { signedIn: true, progress: {} },
            journeys: { endAttempt: vi.fn() },
            scoreboardReplay: { getPayload: vi.fn(() => ({ revision: 1, segments: [] })) },
            pbGhost: { prepare: vi.fn() },
            trackPersonalBestByTrackKey: {},
            loadCampaignLobby: vi.fn().mockResolvedValue({}),
            modal: {
                modalMsg: { style: {}, textContent: '' },
                showModal: vi.fn(),
                updateModalScoreboardSnapshot: vi.fn(),
            },
            restartActiveRace: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        campaignServiceMocks.submitCampaignRun.mockImplementation(() => new Promise((resolve) => {
            resolveSubmission = resolve;
        }));
        campaignServiceMocks.getCampaignSnapshot.mockResolvedValue({
            ok: true,
            body: {
                rows: [],
                currentPlayerRow: {
                    rank: 2,
                    displayName: 'You',
                    bestTimeMs: 8250,
                    isCurrentPlayer: true,
                },
                totalCount: 4,
                pageOffset: 0,
                pageLimit: 50,
                hasMore: false,
                nextOffset: null,
            },
        });
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({ ok: false, body: null });

        const finish = campaignEngineMethods.handleCampaignWin.call(context, { lapTime: 8.25 });
        await Promise.resolve();

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

        resolveSubmission({
            ok: true,
            body: {
                accepted: true,
                progress: { unlockedRaceIds: ['numbered-v1-00'] },
            },
        });
        await finish;
        await vi.waitFor(() => {
            expect(context.loadCampaignLobby).toHaveBeenCalledWith({ show: false });
        });
        expect(context.modal.showModal).toHaveBeenCalledTimes(1);
    });

    it('does not strand a Campaign challenge finish when confirmation fails', async () => {
        const modalMsg = { style: {}, textContent: '' };
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

        expect(context.modal.showModal).toHaveBeenNthCalledWith(
            1,
            'Challenge complete',
            null,
            expect.objectContaining({ lapTime: 8.25, lapMedal: null }),
            expect.objectContaining({
                modalKind: 'win',
                shareRequest: null,
                restartAction: expect.any(Function),
            }),
        );
        await vi.waitFor(() => {
            expect(context.modal.showModal).toHaveBeenLastCalledWith(
                'Result not confirmed',
                null,
                expect.objectContaining({ lapTime: 8.25, lapMedal: null }),
                expect.objectContaining({
                    modalKind: 'rejected',
                    shareRequest: null,
                }),
            );
        });
        expect(modalMsg.textContent).toBe(
            'Race finished, but the challenge result could not be confirmed.',
        );
    });

    it('shows Brag without Improve on a won challenge and Improve without Brag on a loss', async () => {
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

        const winShowModal = vi.fn();
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
            { ...baseContext, modal: { modalMsg, showModal: winShowModal } },
            { lapTime: 7.5 },
        );
        await vi.waitFor(() => {
            expect(winShowModal).toHaveBeenLastCalledWith(
                'Challenge Won',
                null,
                expect.objectContaining({ lapMedal: null, showGlobalLeaderboard: false }),
                expect.objectContaining({
                    shareRequest: {
                        kind: 'challenge-brag',
                        challengeId: 'challenge-1',
                    },
                    restartAction: null,
                }),
            );
        });

        const lossShowModal = vi.fn();
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
            { ...baseContext, modal: { modalMsg, showModal: lossShowModal } },
            { lapTime: 8.4 },
        );
        await vi.waitFor(() => {
            expect(lossShowModal).toHaveBeenLastCalledWith(
                'Challenge Lost',
                null,
                expect.objectContaining({ lapMedal: null }),
                expect.objectContaining({
                    shareRequest: null,
                    restartAction: expect.any(Function),
                }),
            );
        });
    });

    it('keeps Daily and Campaign actions as mode labels with a bottom primary', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        const css = readFileSync(new URL('../styles/lobby-modes.css', import.meta.url), 'utf8');

        for (const buttonId of [
            'lobby-daily-back-btn',
            'daily-challenge-rank-btn',
            'daily-challenge-playlist-btn',
            'lobby-campaign-back-btn',
            'campaign-standings-btn',
            'campaign-tracks-btn',
            'lobby-challenge-back-btn',
        ]) {
            const buttonMarkup = html.match(
                new RegExp(`<button id="${buttonId}"[\\s\\S]*?</button>`),
            )?.[0];
            expect(buttonMarkup).toContain('class="lobby-mode-action"');
            expect(buttonMarkup).toContain('lobby-mode-action__label');
            expect(buttonMarkup).not.toContain('class="main-menu__icon"');
        }

        expect(html).toMatch(
            /id="daily-challenge-start-btn"[\s\S]*main-menu__item--primary/,
        );
        expect(html).toMatch(
            /id="campaign-primary-btn"[\s\S]*main-menu__item--primary/,
        );
        expect(html).toMatch(
            /id="challenge-accept-btn"[\s\S]*main-menu__label">Accept</,
        );
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
        expect(css).not.toMatch(
            /\.lobby-primary-row\s*\{[^}]*margin-top:\s*auto;/s,
        );
        expect(css).toMatch(
            /\.lobby-pane--campaign \.main-menu__item--primary\s*\{[^}]*font-size:\s*clamp\(1\.25rem,\s*5\.5vw,\s*1\.5rem\);/s,
        );
        expect(css).not.toContain('width: min(94vw, 60rem)');
    });

    it('renders Home Garage and Settings as lobby mode actions', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        const css = readFileSync(new URL('../styles/lobby-modes.css', import.meta.url), 'utf8');

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

        expect(css).toContain('.lobby-mode-action');
        expect(css).not.toContain('.lobby-utility-row');
        expect(css).not.toContain('.lobby-utility-btn');
        expect(css).not.toContain('lobby-mode-action::after');
        expect(css).not.toMatch(
            /\.lobby-mode-action\s*\{[^}]*border-bottom:/s,
        );
    });

    it('places Daily and Campaign labels under the Mini Racer title', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        expect(html).toMatch(
            /class="lobby-title"[\s\S]*data-lobby-subhead[\s\S]*data-lobby-mode-label[\s\S]*data-lobby-mode-track/,
        );
        expect(html).not.toMatch(
            /id="lobby-daily-pane"[\s\S]*lobby-pane-heading__title">Daily</,
        );
        expect(html).not.toMatch(
            /id="lobby-campaign-pane"[\s\S]*lobby-pane-heading__title">Campaign</,
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

        lobby.updateDailyTrackLabel('Desert Sprint');
        lobby.showDaily();
        expect(subhead.hidden).toBe(false);
        expect(label.textContent).toBe('Daily');
        expect(track.hidden).toBe(false);
        expect(track.textContent).toBe('Desert Sprint');
        expect(body.dataset.lobbyMode).toBe('daily');

        lobby.showCampaign();
        expect(subhead.hidden).toBe(false);
        expect(label.textContent).toBe('Campaign');
        expect(track.hidden).toBe(true);
        expect(track.textContent).toBe('');
        expect(body.dataset.lobbyMode).toBe('campaign');

        lobby.showChallenge({
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

    it('wires the compact Campaign Standings and Tracks actions', () => {
        const originalDocument = global.document;
        const buttons = {
            'campaign-standings-btn': createElement('button'),
            'campaign-tracks-btn': createElement('button'),
        };
        global.document = {
            getElementById: (id) => buttons[id] || null,
            addEventListener: vi.fn(),
        };
        const onOpenCampaignStandings = vi.fn();
        const onOpenCampaignTracks = vi.fn();
        const lobby = new LobbyUi({ onOpenCampaignStandings, onOpenCampaignTracks });

        lobby.bind();
        buttons['campaign-standings-btn'].listeners.get('click')();
        buttons['campaign-tracks-btn'].listeners.get('click')();

        expect(onOpenCampaignStandings).toHaveBeenCalledTimes(1);
        expect(onOpenCampaignTracks).toHaveBeenCalledTimes(1);
        global.document = originalDocument;
    });

    it('renders Campaign progress inside the existing Tracks list', () => {
        const originalDocument = global.document;
        const list = createElement();
        global.document = {
            getElementById: (id) => id === 'daily-playlist-list' ? list : null,
            createElement,
        };
        const onPlay = vi.fn();
        const ui = new DailyChallengeUi();
        vi.spyOn(ui, 'closePlaylistModal').mockImplementation(() => {});

        ui.renderCampaignProgress(campaignState(), { onPlay });

        expect(list.classList.contains('daily-playlist-list--campaign')).toBe(true);
        expect(list.children).toHaveLength(3);
        expect(list.children[0].dataset.stageId).toBe('numbered-v1-00');
        expect(list.children[2].disabled).toBe(true);
        list.children[1].listeners.get('click')();
        expect(ui.closePlaylistModal).toHaveBeenCalledTimes(1);
        expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 'numbered-v1-01' }));
        global.document = originalDocument;
    });

    it('maps per-stage API rows into the shared standings contract', () => {
        expect(normalizeCampaignLeaderboardSnapshot({
            rows: [{
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
                rows: [],
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

    it('loads later rows from the selected stage leaderboard only', async () => {
        campaignServiceMocks.getCampaignSnapshot
            .mockResolvedValueOnce({
                ok: true,
                body: {
                    rows: [{ rank: 1, displayName: 'Leader', bestTimeMs: 12_000 }],
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
                    rows: [{ rank: 51, displayName: 'Racer', bestTimeMs: 15_000 }],
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
                rows: [{ rank: 1, displayName: 'Stale', bestTimeMs: 10_000 }],
                totalCount: 1,
            },
        });
        await firstOpen;
        expect(modal.updateModalScoreboardSnapshot).not.toHaveBeenCalled();

        resolveSecond({
            ok: true,
            body: {
                rows: [{ rank: 1, displayName: 'Current', bestTimeMs: 11_000 }],
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
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
            showCampaignLobby: campaignEngineMethods.showCampaignLobby,
        };

        context.showCampaignLobby();

        expect(lobbyUi.showCampaign).toHaveBeenCalledTimes(1);
        expect(context.activeRaceMode).toBe('campaign');
        expect(context._campaignBootstrapReady).toBe(false);
        expect(campaignServiceMocks.getCampaignBootstrap).toHaveBeenCalledTimes(1);

        resolveBootstrap({
            campaignId: 'numbered-v1',
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
        expect(lobbyUi.showCampaign.mock.calls[1][0].primaryLabel).toBe('Continue Campaign');
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
            ensureCampaignBootstrap: campaignEngineMethods.ensureCampaignBootstrap,
        };

        const startPromise = campaignEngineMethods.startCampaignStage.call(context);
        expect(lobbyUi.setCampaignPrimaryLoading).toHaveBeenCalledWith(true);

        resolveBootstrap({
            campaignId: 'numbered-v1',
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
        expect(campaignServiceMocks.startLocalCampaign).not.toHaveBeenCalled();
        expect(context.startSequence).toHaveBeenCalledTimes(1);
        expect(lobbyUi.setCampaignPrimaryLoading).toHaveBeenCalledWith(false);
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
