import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const campaignServiceMocks = vi.hoisted(() => ({
    getCampaignPbGhost: vi.fn(),
    getCampaignSnapshot: vi.fn(),
    submitCampaignChallengeRun: vi.fn(),
    submitCampaignRun: vi.fn(),
}));

vi.mock('../game/campaign/service.js', () => ({
    createCampaignChallenge: vi.fn(),
    getCampaignBootstrap: vi.fn(),
    getCampaignChallenge: vi.fn(),
    getCampaignPbGhost: campaignServiceMocks.getCampaignPbGhost,
    getCampaignSnapshot: campaignServiceMocks.getCampaignSnapshot,
    previewCampaignChallenge: vi.fn(),
    saveLocalCampaignFinish: vi.fn(),
    startLocalCampaign: vi.fn(),
    startServerCampaignRace: vi.fn(),
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
    return {
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
    };
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
    campaignServiceMocks.getCampaignPbGhost.mockReset();
    campaignServiceMocks.getCampaignSnapshot.mockReset();
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
        campaignServiceMocks.getCampaignPbGhost.mockRejectedValue(new Error('ghost offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await campaignEngineMethods.handleCampaignWin.call(context, { lapTime: 8.25 });

        expect(context.status).toBe('won');
        expect(context.modal.showModal).toHaveBeenLastCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({
                lapTime: 8.25,
                completedLaps: 1,
                requiredLaps: 1,
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

        expect(context.modal.showModal).toHaveBeenLastCalledWith(
            'Result not confirmed',
            null,
            expect.objectContaining({ lapTime: 8.25 }),
            expect.objectContaining({
                modalKind: 'rejected',
                shareRequest: null,
            }),
        );
        expect(modalMsg.textContent).toBe(
            'Race finished, but the result could not be confirmed. Check Campaign progress before retrying.',
        );
    });

    it('opens a saving sheet before Campaign submission settles', async () => {
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
            },
            restartActiveRace: vi.fn(),
            showCampaignLobby: vi.fn(),
            settings: { openSettings: vi.fn() },
        };
        campaignServiceMocks.submitCampaignRun.mockImplementation(() => new Promise((resolve) => {
            resolveSubmission = resolve;
        }));
        campaignServiceMocks.getCampaignPbGhost.mockResolvedValue({ ok: false, body: null });

        const finish = campaignEngineMethods.handleCampaignWin.call(context, { lapTime: 8.25 });
        await Promise.resolve();

        expect(context.modal.showModal).toHaveBeenCalledTimes(1);
        expect(context.modal.showModal).toHaveBeenCalledWith(
            'Saving Campaign result',
            'Confirming your finished race…',
            null,
            { modalKind: 'pending' },
        );

        resolveSubmission({
            ok: true,
            body: {
                accepted: true,
                progress: { unlockedRaceIds: ['numbered-v1-00'] },
            },
        });
        await finish;
        expect(context.modal.showModal).toHaveBeenLastCalledWith(
            'Campaign race complete',
            null,
            expect.objectContaining({ lapTime: 8.25 }),
            expect.objectContaining({ modalKind: 'win' }),
        );
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
            'Saving challenge result',
            'Confirming your finished race…',
            null,
            { modalKind: 'pending' },
        );
        expect(context.modal.showModal).toHaveBeenLastCalledWith(
            'Result not confirmed',
            null,
            expect.objectContaining({ lapTime: 8.25 }),
            expect.objectContaining({
                modalKind: 'rejected',
                shareRequest: null,
            }),
        );
        expect(modalMsg.textContent).toBe(
            'Race finished, but the challenge result could not be confirmed.',
        );
    });

    it('keeps Daily and Campaign utilities compact, right-aligned, and icon-backed', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        const css = readFileSync(new URL('../styles/lobby-modes.css', import.meta.url), 'utf8');

        for (const buttonId of [
            'daily-challenge-rank-btn',
            'daily-challenge-playlist-btn',
            'campaign-standings-btn',
            'campaign-tracks-btn',
        ]) {
            const buttonMarkup = html.match(
                new RegExp(`<button id="${buttonId}"[\\s\\S]*?</button>`),
            )?.[0];
            expect(buttonMarkup).toContain('class="main-menu__icon"');
        }

        expect(css).toMatch(
            /\.lobby-pane-actions\s*\{[^}]*align-items:\s*flex-end;/s,
        );
        expect(css).toMatch(
            /\.lobby-primary-row\s*\{[^}]*width:\s*95%;[^}]*margin-inline:\s*auto;/s,
        );
        expect(css).toMatch(
            /\.lobby-pane--campaign \.main-menu__item--primary\s*\{[^}]*font-size:\s*clamp\(1\.25rem,\s*5\.5vw,\s*1\.5rem\);/s,
        );
        expect(css).not.toContain('width: min(94vw, 60rem)');
        expect(css).not.toMatch(
            /\.lobby-pane-actions \.main-menu__item\s*\{[^}]*flex-direction:\s*row;/s,
        );
    });

    it('places Daily and Campaign labels under the Mini Racer title', () => {
        const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
        expect(html).toMatch(
            /class="lobby-title"[\s\S]*data-lobby-mode-label/,
        );
        expect(html).not.toMatch(
            /id="lobby-daily-pane"[\s\S]*lobby-pane-heading__title">Daily</,
        );
        expect(html).not.toMatch(
            /id="lobby-campaign-pane"[\s\S]*lobby-pane-heading__title">Campaign</,
        );

        const originalDocument = global.document;
        const label = createElement('p');
        label.hidden = true;
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
            querySelector: (selector) => (
                selector === '[data-lobby-mode-label]' ? label : null
            ),
            addEventListener: vi.fn(),
        };
        const lobby = new LobbyUi();
        lobby.resetKeyboardNav = vi.fn();
        lobby.focus = vi.fn();
        vi.stubGlobal('requestAnimationFrame', (cb) => cb());

        lobby.showDaily();
        expect(label.hidden).toBe(false);
        expect(label.textContent).toBe('Daily');
        expect(body.dataset.lobbyMode).toBe('daily');

        lobby.showCampaign();
        expect(label.textContent).toBe('Campaign');
        expect(body.dataset.lobbyMode).toBe('campaign');

        lobby.showHome();
        expect(label.hidden).toBe(true);
        expect(label.textContent).toBe('');
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
        };

        const firstOpen = campaignEngineMethods.openCampaignStandings.call(
            context,
            'numbered-v1-00',
        );
        const secondOpen = campaignEngineMethods.openCampaignStandings.call(
            context,
            'numbered-v1-01',
        );
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
});
