import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../game/medals/medal-icon.js', () => ({
    createMedalIconSvg: () => {
        const icon = {
            className: 'medal-svg',
            setAttribute: vi.fn(),
            appendChild: vi.fn(),
        };
        return icon;
    },
}));

vi.mock('../game/track/client-registry.js', () => ({
    getLoadedClientTrack: () => null,
    loadClientTrack: () => Promise.resolve(null),
}));

vi.mock('../game/track/preview-renderer.js', () => ({
    renderCachedTrackPreviewCanvas: vi.fn(),
}));

import { DailyChallengeUi } from '../game/daily-challenge/ui.js';
import * as dailyChallengeService from '../game/daily-challenge/service.js';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { normalizeCampaignLobbyState } from '../game/lobby/service.js';

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
        width: 0,
        height: 0,
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
        querySelector(selector) {
            const className = selector.startsWith('.') ? selector.slice(1) : selector;
            return this.children.find((child) => String(child.className).split(' ').includes(className))
                || null;
        },
    };
    return element;
}

function findByClass(parent, className) {
    if (!parent) return null;
    if (String(parent.className).split(' ').includes(className)) return parent;
    for (const child of parent.children || []) {
        const match = findByClass(child, className);
        if (match) return match;
    }
    return null;
}

function campaignStages() {
    return normalizeCampaignLobbyState({
        stages: [
            {
                id: 'numbered-v1-00',
                numberLabel: '00',
                trackKey: 'circuit',
                trackName: 'Number Zero',
                laps: 2,
                unlocked: true,
                medal: 'gold',
                bestTimeMs: 18_400,
                playerRank: 4,
            },
            {
                id: 'numbered-v1-01',
                numberLabel: '01',
                trackKey: 'sunlitTemple',
                trackName: 'Number One',
                laps: 2,
                unlocked: false,
            },
        ],
        resolved: true,
    }).stages;
}

function dailyChallenges() {
    const now = Date.now();
    return [
        {
            id: 'daily-today',
            trackKey: 'circuit',
            objectiveType: 'multi_lap_total',
            objectiveParams: { lapCount: 2 },
            endsAt: new Date(now + 60_000).toISOString(),
            availableUntil: new Date(now + 7 * 86_400_000).toISOString(),
        },
        {
            id: 'daily-old',
            trackKey: 'sunlitTemple',
            objectiveType: 'single_lap_fastest',
            endsAt: new Date(now - 2 * 86_400_000).toISOString(),
            availableUntil: new Date(now - 86_400_000).toISOString(),
        },
    ];
}

describe('Campaign Tracks list rows', () => {
    let list;
    let originalDocument;

    beforeEach(() => {
        originalDocument = global.document;
        list = createElement('div');
        global.document = {
            getElementById: (id) => (id === 'daily-playlist-list' ? list : null),
            createElement,
            createElementNS: (_namespace, tagName) => createElement(tagName),
            body: { classList: createClassList() },
        };
    });

    afterEach(() => {
        global.document = originalDocument;
    });

    it('keeps Campaign tiles quiet: laps when open, dimmed when locked', () => {
        const ui = new DailyChallengeUi();
        ui.renderCampaignPlaylist(campaignStages(), { onChoose: vi.fn() }, {
            selectedStageId: 'numbered-v1-00',
        });

        expect(list.children).toHaveLength(2);
        expect(list.children[0].className).toContain('current');
        expect(list.children[0].className).not.toContain('is-featured');
        expect(list.children[0].className).not.toContain('is-locked');
        expect(findByClass(list.children[0], 'daily-playlist-hero-day').textContent)
            .toBe('2 Laps');
        expect(findByClass(list.children[0], 'daily-playlist-hero-title').textContent)
            .toBe('Number Zero');
        expect(findByClass(list.children[0], 'daily-playlist-hero-medal')).toBeTruthy();
        expect(findByClass(list.children[0], 'daily-playlist-hero-rank').textContent).toBe('#4');
        expect(list.children[0].attributes['aria-label']).toContain('Race Number Zero');
        expect(list.children[0].attributes['aria-label']).toContain('Rank #4');
        expect(list.children[0].attributes['aria-label']).toContain('Stage 00');
        expect(list.children[0].attributes['aria-label']).not.toContain('Expired');

        expect(list.children[1].className).toContain('is-locked');
        expect(findByClass(list.children[1], 'daily-playlist-hero-day').textContent)
            .toBe('2 Laps');
        expect(findByClass(list.children[1], 'daily-playlist-hero-lock')).toBeNull();
        expect(findByClass(list.children[1], 'daily-playlist-hero-medal')).toBeNull();
        expect(findByClass(list.children[1], 'daily-playlist-hero-rank')).toBeNull();
        expect(list.children[1].attributes['aria-label']).toContain('Locked');
        expect(JSON.stringify(list.children[1])).not.toContain('Expires');
        expect(findByClass(list.children[0], 'daily-playlist-hero-content')).toBeNull();
        expect(list.children[0].children[0].className).toContain('daily-playlist-hero-preview');
        expect(list.children[0].children[1].className).toContain('daily-playlist-hero-title');
        expect(list.children[0].children[2].className).toContain('daily-playlist-hero-day');
    });

    it('keeps Campaign stages in list order', () => {
        const ui = new DailyChallengeUi();
        ui.renderCampaignPlaylist(campaignStages(), { onChoose: vi.fn() }, {
            selectedStageId: 'numbered-v1-01',
        });

        expect(findByClass(list.children[0], 'daily-playlist-hero-title').textContent)
            .toBe('Number Zero');
        expect(list.children[1].className).toContain('current');
        expect(findByClass(list.children[1], 'daily-playlist-hero-title').textContent)
            .toBe('Number One');
    });

    it('titles the overlay Daily Tracks or Campaign Tracks', () => {
        const title = createElement('span');
        const modal = createElement('div');
        modal.classList = createClassList();
        modal.offsetHeight = 0;
        modal.querySelector = (selector) => (selector === '[data-modal-title]' ? title : null);

        global.document.getElementById = (id) => {
            if (id === 'daily-playlist-list') return list;
            if (id === 'daily-playlist-modal') return modal;
            return null;
        };

        const ui = new DailyChallengeUi();
        ui.openTracksModal = vi.fn();
        ui.openPlaylistModal([]);
        expect(title.textContent).toBe('Daily Tracks');

        ui.openCampaignTracksModal([]);
        expect(title.textContent).toBe('Campaign Tracks');
    });

    it('starts an unlocked stage and scrolls the carousel for a locked one', () => {
        const onChoose = vi.fn();
        const ui = new DailyChallengeUi();
        ui.closePlaylistModal = vi.fn();
        ui.renderCampaignPlaylist(campaignStages(), { onChoose });

        list.children[0].listeners.get('click')();
        expect(ui.closePlaylistModal).toHaveBeenCalledTimes(1);
        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({
            id: 'numbered-v1-00',
            unlocked: true,
        }));

        list.children[1].listeners.get('click')();
        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({
            id: 'numbered-v1-01',
            unlocked: false,
        }));
    });
});

describe('Daily Tracks list rows', () => {
    let list;
    let originalDocument;

    beforeEach(() => {
        originalDocument = global.document;
        list = createElement('div');
        global.document = {
            getElementById: (id) => (id === 'daily-playlist-list' ? list : null),
            createElement,
            createElementNS: (_namespace, tagName) => createElement(tagName),
            body: { classList: createClassList() },
        };
    });

    afterEach(() => {
        global.document = originalDocument;
        vi.restoreAllMocks();
    });

    it('keeps Daily tiles to name and laps, with Today on the live race', () => {
        vi.spyOn(dailyChallengeService, 'getCachedDailyChallengeSnapshot').mockImplementation((id) => (
            id === 'daily-today'
                ? { playerRank: 12, playerRankLabel: '#12' }
                : null
        ));
        const ui = new DailyChallengeUi();
        ui.setDailyChallengeSummary({ challengeId: 'daily-today' });
        ui.renderPlaylist(dailyChallenges(), { onPlay: vi.fn() });

        expect(list.children).toHaveLength(2);
        expect(list.children[0].className).toContain('current');
        expect(list.children[0].className).not.toContain('is-featured');
        expect(findByClass(list.children[0], 'daily-playlist-hero-day').textContent)
            .toBe('Today · 2 Laps');
        expect(findByClass(list.children[0], 'daily-playlist-hero-rank').textContent).toBe('#12');
        expect(list.children[0].attributes['aria-label']).toContain('Today');
        expect(list.children[0].attributes['aria-label']).toContain('Rank #12');
        expect(findByClass(list.children[1], 'daily-playlist-hero-day').textContent)
            .toBe('1 Lap');
        expect(list.children[1].attributes['aria-label']).toContain('Expired');
        expect(findByClass(list.children[1], 'daily-playlist-hero-lock')).toBeNull();
        expect(findByClass(list.children[1], 'daily-playlist-hero-medal')).toBeNull();
        expect(findByClass(list.children[1], 'daily-playlist-hero-rank')).toBeNull();
    });
});

describe('Campaign Tracks list engine', () => {
    it('opens the overlay with Campaign stages', () => {
        const openCampaignTracksModal = vi.fn();
        const stages = campaignStages();
        const engine = {
            campaignLobbyState: { stages },
            _campaignBootstrapReady: true,
            selectedCampaignStageId: 'numbered-v1-00',
            dailyChallengeUi: { openCampaignTracksModal },
        };

        campaignEngineMethods.openCampaignTracks.call(engine);

        expect(openCampaignTracksModal).toHaveBeenCalledWith(
            stages,
            expect.objectContaining({ onChoose: expect.any(Function) }),
            { selectedStageId: 'numbered-v1-00' },
        );
    });

    it('shows loading when bootstrap has not produced stages yet', () => {
        const openCampaignTracksModal = vi.fn();
        campaignEngineMethods.openCampaignTracks.call({
            campaignLobbyState: { stages: [] },
            _campaignBootstrapReady: false,
            dailyChallengeUi: { openCampaignTracksModal },
        });

        expect(openCampaignTracksModal.mock.calls[0][0]).toBe(null);
    });

    it('starts an unlocked stage from the list', () => {
        const startCampaignStage = vi.fn();
        const selectChallenge = vi.fn();
        const engine = {
            startCampaignStage,
            campaignCarousel: { selectChallenge },
            lobbyUi: { setCampaignSelectedStage: vi.fn() },
        };
        const stage = { id: 'numbered-v1-00', unlocked: true };

        campaignEngineMethods.handleCampaignTracksChoose.call(engine, stage);

        expect(startCampaignStage).toHaveBeenCalledWith(stage);
        expect(selectChallenge).not.toHaveBeenCalled();
    });

    it('scrolls the carousel to a locked stage and does not start', () => {
        const startCampaignStage = vi.fn();
        const selectChallenge = vi.fn();
        const setCampaignSelectedStage = vi.fn();
        const engine = {
            startCampaignStage,
            campaignCarousel: { selectChallenge },
            lobbyUi: { setCampaignSelectedStage },
        };
        const stage = { id: 'numbered-v1-01', unlocked: false };

        campaignEngineMethods.handleCampaignTracksChoose.call(engine, stage);

        expect(engine.selectedCampaignStageId).toBe('numbered-v1-01');
        expect(selectChallenge).toHaveBeenCalledWith('numbered-v1-01');
        expect(setCampaignSelectedStage).toHaveBeenCalledWith(stage);
        expect(startCampaignStage).not.toHaveBeenCalled();
    });

    it('repaints an open Campaign Tracks list when lobby progress lands', () => {
        const renderCampaignPlaylist = vi.fn();
        const stages = campaignStages();
        campaignEngineMethods.syncOpenCampaignTracks.call({
            campaignLobbyState: { stages },
            _campaignBootstrapReady: true,
            selectedCampaignStageId: 'numbered-v1-01',
            dailyChallengeUi: {
                isCampaignTracksModalOpen: () => true,
                renderCampaignPlaylist,
            },
        });

        expect(renderCampaignPlaylist).toHaveBeenCalledWith(
            stages,
            null,
            { selectedStageId: 'numbered-v1-01' },
        );
    });
});
