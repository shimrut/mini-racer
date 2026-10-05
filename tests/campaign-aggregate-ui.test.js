// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getCampaignAggregate: vi.fn() }));
vi.mock('../game/campaign/service.js', async (importOriginal) => ({
    ...(await importOriginal()), getCampaignAggregate: api.getCampaignAggregate,
}));
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { buildCampaignFinishedScreen } from '../game/campaign/finished-screen.js';
import { getCampaignSeriesStages } from '../game/campaign/manifest.js';
import { ModalShell } from '../game/race/ui-modal-shell.js';
import { ModalContentUi } from '../game/race/ui-modal-content.js';
import { clearActivePlayerOwnerId, setActivePlayerOwnerId } from '../game/player/active-owner.js';

const seriesId = 'numbered-v1';
const stages = getCampaignSeriesStages(seriesId);
const saved = Object.fromEntries(stages.map((stage) => [stage.raceId, { bestTimeMs: 10_001, medal: 'bronze' }]));
function reply(overrides = {}) {
    const row = { rank: 2, displayName: 'You', bestTimeMs: stages.length * 10_001, isCurrentPlayer: true };
    return { ok: true, body: {
        seriesId, finalStageId: stages.at(-1).raceId, ready: true,
        totalTimeMs: row.bestTimeMs, topRows: [
            { rank: 1, displayName: 'Anonymous Racer', bestTimeMs: row.bestTimeMs - 200, opponentRaceAvailable: true }, row,
        ], currentPlayerRow: row, playerRank: 2, playerRankLabel: '#2',
        totalCount: 3, leaderboardEntryCount: 3, pageOffset: 0, pageLimit: 50,
        hasMore: false, nextOffset: null, ...overrides,
    } };
}
function mount() {
    document.documentElement.innerHTML = readFileSync('pages/game.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    const sound = vi.fn();
    const modal = new ModalShell({ content: new ModalContentUi(), playUnlockSound: sound,
        getCurrentTrackKey: () => 'numberZero' });
    const engine = { ...campaignEngineMethods, activeRaceMode: 'campaign', modal,
        showCampaignLobby: vi.fn(), openCampaignTracks: vi.fn() };
    const screen = buildCampaignFinishedScreen(seriesId, saved);
    return { engine, modal, sound, screen };
}
beforeEach(() => {
    api.getCampaignAggregate.mockReset();
    setActivePlayerOwnerId('reddit:one');
    vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
});
afterEach(() => {
    clearActivePlayerOwnerId();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Campaign aggregate results', () => {
    it('opens only from saved results and Back restores that view and focus without celebrating again', async () => {
        api.getCampaignAggregate.mockResolvedValue(reply());
        const { engine, modal, sound, screen } = mount();
        engine.showCampaignFinishedNow(screen);
        await engine._campaignAggregateSession.inFlight;
        expect(document.getElementById('campaign-finished-rank').textContent).toBe('#2 / 3');
        expect(document.getElementById('campaign-finished-time').textContent).toBe('02:50.017');
        expect(document.querySelectorAll('.campaign-finished__actions > button')).toHaveLength(3);
        expect(document.querySelector('.campaign-finished__actions').textContent).not.toMatch(/Leaderboard|Refresh|Retry/);
        document.getElementById('campaign-finished-rank-button').click();
        expect(modal.isRunsViewActive()).toBe(true);
        expect(modal._modalRunsPayload.scoreboardTrackKey).toBeNull();
        expect(document.querySelector('#modal-runs-view [data-modal-title]').textContent).toBe('Numbers');
        expect(document.querySelector('.leaderboard-day-rail')).toBeNull();
        expect(document.querySelector('.leaderboard-row.is-raceable, .leaderboard-row.is-shareable')).toBeNull();
        modal.dismissRunsView();
        expect(modal.isCampaignFinishedViewActive()).toBe(true);
        await vi.waitFor(() => expect(document.activeElement.id).toBe('campaign-finished-rank-button'));
        expect(sound).toHaveBeenCalledTimes(1);
        modal.closeModal({ instant: true });
        engine.openCampaignAggregateStandings(engine._campaignAggregateSession);
        expect(modal.isModalActive()).toBe(false);
    });

    it('preserves completion and retries failed rank requests automatically without an extra action', async () => {
        vi.useFakeTimers();
        api.getCampaignAggregate.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(reply());
        const { engine, modal, screen } = mount();
        engine.showCampaignFinishedNow(screen);
        await engine._campaignAggregateSession.inFlight;
        expect(modal.isCampaignFinishedViewActive()).toBe(true);
        expect(document.getElementById('campaign-finished-rank').textContent).toBe('Unavailable');
        expect(document.getElementById('campaign-finished-rank-button').disabled).toBe(true);
        expect(document.querySelector('.campaign-finished__actions').textContent).not.toMatch(/Leaderboard|Refresh|Retry/);
        await vi.advanceTimersByTimeAsync(2000);
        expect(document.getElementById('campaign-finished-rank').textContent).toBe('#2 / 3');
        expect(modal.isCampaignFinishedViewActive()).toBe(true);
    });

    it('does not apply an old owner or dismissed results response', async () => {
        let resolve;
        api.getCampaignAggregate.mockReturnValue(new Promise((done) => { resolve = done; }));
        const { engine, modal, screen } = mount();
        engine.showCampaignFinishedNow(screen);
        const request = engine._campaignAggregateSession.inFlight;
        setActivePlayerOwnerId('reddit:two');
        modal.closeModal({ instant: true });
        resolve(reply());
        await request;
        expect(engine._campaignAggregateSession.snapshot).toBeNull();
        expect(modal.isModalActive()).toBe(false);
    });

    it('automatically retries a failed refresh and disables opening its older ready board', async () => {
        vi.useFakeTimers();
        api.getCampaignAggregate.mockResolvedValueOnce(reply())
            .mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(reply({ playerRank: 1 }));
        const { engine, modal, screen } = mount();
        engine.showCampaignFinishedNow(screen);
        await engine._campaignAggregateSession.inFlight;
        await engine.loadCampaignAggregate(engine._campaignAggregateSession);
        expect(document.getElementById('campaign-finished-rank').textContent).toBe('Unavailable');
        document.getElementById('campaign-finished-rank-button').click();
        expect(modal.isCampaignFinishedViewActive()).toBe(true);
        expect(document.getElementById('campaign-finished-rank-button').disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(2000);
        expect(api.getCampaignAggregate).toHaveBeenCalledTimes(3);
        expect(document.getElementById('campaign-finished-rank').textContent).toBe('#1 / 3');
    });

    it('withholds incomplete backfill places, then refreshes while the summary remains open', async () => {
        vi.useFakeTimers();
        api.getCampaignAggregate.mockResolvedValueOnce(reply({ ready: false, playerRank: null,
            totalCount: 0, leaderboardEntryCount: 0, topRows: [], currentPlayerRow: null }))
            .mockResolvedValueOnce(reply());
        const { engine, screen } = mount();
        engine.showCampaignFinishedNow(screen);
        await engine._campaignAggregateSession.inFlight;
        expect(document.getElementById('campaign-finished-rank').textContent).toBe('Loading…');
        await vi.advanceTimersByTimeAsync(2000);
        expect(document.getElementById('campaign-finished-rank').textContent).toBe('#2 / 3');
        expect(api.getCampaignAggregate).toHaveBeenCalledTimes(2);
    });

    it('refreshes the visible board after a late saved PB and ignores an older page', async () => {
        let resolvePage;
        api.getCampaignAggregate.mockResolvedValueOnce(reply({ hasMore: true, nextOffset: 50 }))
            .mockImplementationOnce(() => new Promise((done) => { resolvePage = done; }))
            .mockResolvedValueOnce(reply({ totalTimeMs: 160000, playerRank: 1,
                topRows: [{ rank: 1, displayName: 'You', bestTimeMs: 160000, isCurrentPlayer: true }],
                currentPlayerRow: { rank: 1, displayName: 'You', bestTimeMs: 160000, isCurrentPlayer: true } }));
        const { engine, modal, screen } = mount();
        engine.showCampaignFinishedNow(screen);
        const session = engine._campaignAggregateSession;
        await session.inFlight;
        document.getElementById('campaign-finished-rank-button').click();
        const page = modal._modalRunsPayload.onLoadMoreLeaderboard();
        await engine.loadCampaignAggregate(session);
        expect(modal._modalRunsPayload.scoreboardSnapshot.playerRank).toBe(1);
        expect(modal._modalRunsPayload.scoreboardSnapshot.currentPlayerRow.bestTimeMs).toBe(160000);
        resolvePage(reply({ pageOffset: 50, playerRank: 2, topRows: [{ rank: 51, displayName: 'Old page', bestTimeMs: 999999 }] }));
        await page;
        expect(modal._modalRunsPayload.scoreboardSnapshot.playerRank).toBe(1);
        expect(modal._modalRunsPayload.scoreboardSnapshot.topRows).toHaveLength(1);
        modal.dismissRunsView();
        expect(document.getElementById('campaign-finished-time').textContent).toBe('02:40.000');
        expect(document.getElementById('campaign-finished-rank').textContent).toBe('#1 / 3');
    });

    it('paginates with the shared rows and ignores a page arriving after Back', async () => {
        let resolvePage;
        api.getCampaignAggregate.mockResolvedValueOnce(reply({ hasMore: true, nextOffset: 50 }))
            .mockImplementationOnce(() => new Promise((done) => { resolvePage = done; }));
        const { engine, modal, screen } = mount();
        engine.showCampaignFinishedNow(screen, { celebrate: false });
        await engine._campaignAggregateSession.inFlight;
        document.getElementById('campaign-finished-rank-button').click();
        const original = modal._modalRunsPayload.scoreboardSnapshot;
        const page = modal._modalRunsPayload.onLoadMoreLeaderboard();
        modal.dismissRunsView();
        resolvePage(reply({ pageOffset: 50, topRows: [{ rank: 51, displayName: 'Later racer', bestTimeMs: 999999 }] }));
        await page;
        expect(modal._modalRunsPayload.scoreboardSnapshot).toBe(original);
        expect(modal.isCampaignFinishedViewActive()).toBe(true);
    });
});
