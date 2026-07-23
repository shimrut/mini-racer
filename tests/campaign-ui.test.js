import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const campaignServiceMocks = vi.hoisted(() => ({
    getCampaignSnapshot: vi.fn(),
}));

vi.mock('../game/campaign/service.js', () => ({
    createCampaignChallenge: vi.fn(),
    getCampaignBootstrap: vi.fn(),
    getCampaignChallenge: vi.fn(),
    getCampaignPbGhost: vi.fn(),
    getCampaignSnapshot: campaignServiceMocks.getCampaignSnapshot,
    previewCampaignChallenge: vi.fn(),
    saveLocalCampaignFinish: vi.fn(),
    startLocalCampaign: vi.fn(),
    startServerCampaignRace: vi.fn(),
    submitCampaignChallengeRun: vi.fn(),
    submitCampaignRun: vi.fn(),
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
    campaignServiceMocks.getCampaignSnapshot.mockReset();
});

describe('Campaign lobby and shared modal adapters', () => {
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
            /\.lobby-pane--home\.main-menu\s*\{[^}]*margin-top:\s*0;/s,
        );
        expect(css).toMatch(
            /\.lobby-mode-menu\s*\{[^}]*align-items:\s*flex-start;/s,
        );
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
