import { getCommunityMap, getCommunityMaps } from './service.js';
import { registerCommunityTrack } from '../track/client-registry.js';
import { formatRaceClock } from '../shared/race-time-text.js';
import { COMMUNITY_VISIBLE } from './visibility.js';

function newCommunityRun(map, trackKey) {
    return {
        challengeId: map.id,
        trackKey,
        objectiveType: 'single_lap_fastest',
        requiredLaps: 1,
        completedLaps: 0,
        lastLapAt: 0,
        recentLaps: [],
    };
}

export const communityEngineMethods = {
    showCommunityLobby() {
        if (!COMMUNITY_VISIBLE) return;
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'community';
        this.activeCampaignStage = null;
        this.activeHeadToHead = null;
        this.clearDailyChallengeRun();
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showCommunity();
        if (!this.communityMaps?.length && !this.communityMapsLoading) {
            void this.loadCommunityMaps();
        }
    },

    async loadCommunityMaps({ more = false } = {}) {
        if (this.communityMapsLoading) return;
        this.communityMapsLoading = true;
        const generation = this.communityMapsGeneration = (this.communityMapsGeneration || 0) + 1;
        const cursor = more ? this.communityNextCursor : null;
        if (!more) {
            this.communityMaps = [];
            this.communityNextCursor = null;
        }
        this.lobbyUi.setCommunityMaps({
            maps: this.communityMaps,
            loading: true,
            nextCursor: this.communityNextCursor,
        });
        try {
            const page = await getCommunityMaps(cursor);
            if (generation !== this.communityMapsGeneration) return;
            const incoming = Array.isArray(page?.maps) ? page.maps : [];
            const existing = new Set((this.communityMaps || []).map((map) => map.id));
            this.communityMaps = [...(this.communityMaps || []), ...incoming.filter((map) =>
                typeof map?.id === 'string' && !existing.has(map.id))];
            this.communityNextCursor = typeof page?.nextCursor === 'string' ? page.nextCursor : null;
            this.lobbyUi.setCommunityMaps({
                maps: this.communityMaps,
                nextCursor: this.communityNextCursor,
            });
        } catch (error) {
            this.lobbyUi.setCommunityMaps({
                maps: this.communityMaps || [],
                nextCursor: cursor,
                error: error?.message || 'Could not load Community maps.',
            });
        } finally {
            this.communityMapsLoading = false;
        }
    },

    async startCommunityMap(mapId = this.lobbyUi.communitySelectedMapId) {
        if (!mapId || this.communityStartPending) return;
        this.communityStartPending = true;
        this.lobbyUi.setCommunityStartPending(true);
        try {
            const { map } = await getCommunityMap(mapId);
            if (!map?.track || map.id !== mapId) throw new Error('Community map unavailable.');
            const trackKey = registerCommunityTrack(map.id, map.name, map.track);
            this.activeRaceMode = 'community';
            this.activeCommunityMap = map;
            await this.loadTrack(trackKey, {
                loadPlayerProgress: false,
                showStartOverlayOnReset: false,
            });
            if (this.currentTrackKey !== trackKey) throw new Error('Map failed to load.');
            this.prepareCommunityRun();
            await this.startOverlay.beginRaceStartTransition();
            this.startSequence();
        } catch (error) {
            this.showCommunityLobby();
            this.lobbyUi.setCommunityStartError(error?.message || 'Map failed to load.');
        } finally {
            this.communityStartPending = false;
            this.lobbyUi.setCommunityStartPending(false);
        }
    },

    prepareCommunityRun() {
        const map = this.activeCommunityMap;
        if (!map) return;
        this.currentChallengeRun = newCommunityRun(map, this.currentTrackKey);
        this.syncCurrentRunPolicy();
        this.bestLapTime = null;
        this.hud.setBestTime(null, { persistToTrackCard: false });
        this.hud.setHudBestMetric({ visible: false });
        this.hud.setHudPrimaryMetric({ label: 'TIME', useTimer: true, visible: true });
        this.dailyChallengeUi?.setDailyChallengeHud?.(null);
    },

    restartCommunityRace() {
        if (!this.activeCommunityMap) return this.showCommunityLobby();
        this.reset(false, { showStartOverlay: false });
        this.activeRaceMode = 'community';
        this.prepareCommunityRun();
        this.startSequence();
    },

    handleCommunityWin(winData) {
        if (this.activeRaceMode !== 'community' || !this.activeCommunityMap
            || this.currentChallengeRun?.challengeId !== this.activeCommunityMap.id
            || winData?.trackKey !== this.currentTrackKey
            || !Number.isFinite(winData?.lapTime)) return;
        this.status = 'won';
        this.hud.setPauseVisible(false);
        this.hud.syncHud({ time: winData.lapTime, speed: 0, force: true });
        void this.journeys?.endAttempt?.({ complete: true });
        this.modal.showModal(
            'FINISHED',
            `${this.activeCommunityMap.name} · ${formatRaceClock(winData.lapTime * 1000)} · Unranked`,
            null,
            {
                primaryActionLabel: 'Retry',
                primaryAction: () => this.restartCommunityRace(),
                secondaryActionLabel: 'Community',
                secondaryAction: () => this.showCommunityLobby(),
            },
        );
    },
};
