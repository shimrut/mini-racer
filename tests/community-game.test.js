import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { communityEngineMethods } from '../game/community/engine-methods.js';
import { COMMUNITY_VISIBLE } from '../game/community/visibility.js';
import { getCommunityMaps } from '../game/community/service.js';
import { modeRouterEngineMethods } from '../game/modes/engine-methods.js';
import {
    clearClientTrackRegistryForTests,
    getLoadedClientTrack,
    loadClientTrack,
    registerCommunityTrack,
} from '../game/track/client-registry.js';

const mapId = '0f187850-a763-476f-8892-53f8b124ac8b';
const map = {
    id: mapId,
    name: 'Bends and Bays',
    authorName: 'MapMod',
    track: { outer: [], inner: [], startPos: { x: 1, y: 2 }, startAngle: 0 },
};

beforeEach(() => {
    clearClientTrackRegistryForTests();
    vi.restoreAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('Community visibility', () => {
    it('keeps Community hidden from players for now', () => {
        const html = readFileSync(new URL('../pages/game.html', import.meta.url), 'utf8');
        const button = html.match(/<button id="lobby-home-community-btn"[^>]*>/)?.[0] ?? '';
        expect(COMMUNITY_VISIBLE).toBe(false);
        expect(button).toMatch(/\bhidden\b/);
    });

    it('does not open the Community lobby while it is hidden', () => {
        const engine = { lobbyUi: { showCommunity: vi.fn() }, reset: vi.fn() };
        communityEngineMethods.showCommunityLobby.call(engine);
        expect(engine.lobbyUi.showCommunity).not.toHaveBeenCalled();
        expect(engine.activeRaceMode).toBeUndefined();
    });
});

describe('Community race isolation', () => {
    it('uses an opaque cursor for the next published-map page', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ maps: [map], nextCursor: 'page:2' }),
        })));
        const page = await getCommunityMaps('page:1');
        expect(fetch).toHaveBeenCalledWith(
            '/api/community/maps?cursor=page%3A1',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(page.maps[0].authorName).toBe('MapMod');
        expect(page.nextCursor).toBe('page:2');
    });

    it('loads an immutable map under its own runtime key without putting it in the built-in catalog', async () => {
        const key = registerCommunityTrack(map.id, map.name, map.track);
        expect(key).toBe(`community:${mapId}`);
        expect(getLoadedClientTrack(key)?.name).toBe(map.name);
        expect(await loadClientTrack(key)).toEqual(getLoadedClientTrack(key));
        expect(await loadClientTrack('community:missing')).toBeNull();
    });

    it('starts one unranked lap from a published detail and does not prepare a ranked result', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ map }),
        })));
        const engine = {
            activeRaceMode: 'home',
            currentTrackKey: 'circuit',
            lobbyUi: {
                communitySelectedMapId: mapId,
                setCommunityStartPending: vi.fn(),
                setCommunityStartError: vi.fn(),
            },
            loadTrack: vi.fn(async (key) => { engine.currentTrackKey = key; }),
            startOverlay: { beginRaceStartTransition: vi.fn(async () => {}) },
            syncCurrentRunPolicy: vi.fn(),
            hud: {
                setBestTime: vi.fn(),
                setHudBestMetric: vi.fn(),
                setHudPrimaryMetric: vi.fn(),
            },
            dailyChallengeUi: { setDailyChallengeHud: vi.fn() },
            startSequence: vi.fn(),
            prepareCommunityRun: communityEngineMethods.prepareCommunityRun,
            showCommunityLobby: vi.fn(),
        };

        await communityEngineMethods.startCommunityMap.call(engine);

        expect(fetch).toHaveBeenCalledWith(`/api/community/maps/${mapId}`, expect.any(Object));
        expect(engine.currentTrackKey).toBe(`community:${mapId}`);
        expect(engine.currentChallengeRun).toMatchObject({
            challengeId: mapId,
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1,
        });
        expect(engine.bestLapTime).toBeNull();
        expect(engine.hud.setHudBestMetric).toHaveBeenCalledWith({ visible: false });
        expect(engine.startSequence).toHaveBeenCalledOnce();
        expect(engine.showCommunityLobby).not.toHaveBeenCalled();
    });

    it('shows only elapsed time and Unranked on finish, then returns to Community', () => {
        const modal = { showModal: vi.fn() };
        const engine = {
            activeRaceMode: 'community',
            activeCommunityMap: map,
            currentTrackKey: `community:${mapId}`,
            currentChallengeRun: { challengeId: mapId },
            hud: { setPauseVisible: vi.fn(), syncHud: vi.fn() },
            journeys: { endAttempt: vi.fn() },
            modal,
            restartCommunityRace: vi.fn(),
            showCommunityLobby: vi.fn(),
            handleCommunityWin: communityEngineMethods.handleCommunityWin,
            handleDailyChallengeWin: vi.fn(),
            handleChallengeLapCompleted: vi.fn(),
            handleDailyChallengeLapCompleted: vi.fn(),
        };
        modeRouterEngineMethods.handleActiveRaceLapCompleted.call(engine, 12.345, {});
        modeRouterEngineMethods.handleActiveRaceWin.call(engine, {
            trackKey: `community:${mapId}`,
            lapTime: 12.345,
        });
        expect(engine.handleChallengeLapCompleted).not.toHaveBeenCalled();
        expect(engine.handleDailyChallengeLapCompleted).not.toHaveBeenCalled();
        expect(engine.handleDailyChallengeWin).not.toHaveBeenCalled();
        expect(modal.showModal).toHaveBeenCalledWith(
            'FINISHED',
            'Bends and Bays · 0:12.345 · Unranked',
            null,
            expect.objectContaining({
                primaryActionLabel: 'Retry',
                secondaryActionLabel: 'Community',
            }),
        );
        const actions = modal.showModal.mock.calls[0][3];
        actions.secondaryAction();
        expect(engine.showCommunityLobby).toHaveBeenCalledOnce();
    });
});
