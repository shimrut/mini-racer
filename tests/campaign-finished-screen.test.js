// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCampaignFinishedScreen } from '../game/campaign/finished-screen.js';
import { ModalShell } from '../game/race/ui-modal-shell.js';
import { ModalContentUi } from '../game/race/ui-modal-content.js';
import { GENERIC_SNOO_URL } from '../game/ui/avatar.js';
import {
    CAMPAIGN_NUMBERS_SERIES_ID,
    getCampaignSeriesStages,
} from '../game/campaign/manifest.js';
import {
    clearStoredSeriesForTests,
    registerStoredSeries,
} from '../game/campaign/stored-series.js';

const NUMBERS_STAGES = getCampaignSeriesStages(CAMPAIGN_NUMBERS_SERIES_ID);
const frameTimeouts = [];

function resultsFor(stages, medalFor = () => 'bronze') {
    return Object.fromEntries(stages.map((stage, index) => [stage.raceId, {
        bestTimeMs: 10000,
        medal: medalFor(stage, index),
    }]));
}

afterEach(() => {
    frameTimeouts.splice(0).forEach(clearTimeout);
    clearStoredSeriesForTests();
});

describe('buildCampaignFinishedScreen', () => {
    it('fills the screen from the finished series', () => {
        const screen = buildCampaignFinishedScreen(
            CAMPAIGN_NUMBERS_SERIES_ID,
            resultsFor(NUMBERS_STAGES),
        );

        expect(screen).toMatchObject({
            seriesId: CAMPAIGN_NUMBERS_SERIES_ID,
            title: 'Numbers',
            status: 'Complete',
            bestTier: 'bronze',
            stageCount: NUMBERS_STAGES.length,
            medalDistribution: { author: 0, gold: 0, silver: 0, bronze: NUMBERS_STAGES.length },
            medalTotal: `${NUMBERS_STAGES.length}/${NUMBERS_STAGES.length * 4}`,
        });
        expect(screen.medals).toEqual(NUMBERS_STAGES.map((stage) => ({
            stageNumber: stage.stageNumber,
            tier: 'bronze',
        })));
    });

    it('uses another campaign’s name, size and medals', () => {
        registerStoredSeries([{
            id: 'harbour-v1',
            name: 'Grey Harbour',
            finalStageId: 'harbour-v1-01',
            ground: 'dirt',
            stages: [
                { trackKey: 'countryRoad', laps: 1, requiredMedals: 0 },
                { trackKey: 'forestTrail', laps: 2, requiredMedals: 1 },
            ],
        }]);
        const stages = getCampaignSeriesStages('harbour-v1');

        const screen = buildCampaignFinishedScreen(
            'harbour-v1',
            resultsFor(stages, (_stage, index) => (index === 0 ? 'author' : 'gold')),
        );

        expect(screen).toMatchObject({
            seriesId: 'harbour-v1',
            title: 'Grey Harbour',
            bestTier: 'author',
            medalDistribution: { author: 1, gold: 1, silver: 0, bronze: 0 },
            medalTotal: '7/8',
            medals: [
                { stageNumber: '00', tier: 'author' },
                { stageNumber: '01', tier: 'gold' },
            ],
        });
    });

    it('stays empty until the last stage has a medal', () => {
        const unfinished = resultsFor(NUMBERS_STAGES, (_stage, index) => (
            index === NUMBERS_STAGES.length - 1 ? null : 'bronze'
        ));
        delete unfinished[NUMBERS_STAGES.at(-1).raceId];

        expect(buildCampaignFinishedScreen(CAMPAIGN_NUMBERS_SERIES_ID, unfinished)).toBeNull();
        expect(buildCampaignFinishedScreen('missing-series', {})).toBeNull();
    });

    it('waits for the designated final stage instead of the published tail', () => {
        const series = {
            id: 'extended-v1', name: 'Extended', ground: 'dirt',
            finalStageId: 'extended-v1-02',
            stages: [
                { trackKey: 'countryRoad', laps: 1, requiredMedals: 0 },
                { trackKey: 'forestTrail', laps: 1, requiredMedals: 1 },
            ],
        };
        registerStoredSeries([series]);
        const results = resultsFor(getCampaignSeriesStages(series.id));
        expect(buildCampaignFinishedScreen(series.id, results)).toBeNull();

        registerStoredSeries([{
            ...series,
            stages: [...series.stages, { trackKey: 'countryRoad', laps: 2, requiredMedals: 2 }],
        }]);
        expect(buildCampaignFinishedScreen(series.id, results)).toBeNull();
        const stages = getCampaignSeriesStages(series.id);
        results[stages.at(-1).raceId] = { bestTimeMs: 20000, medal: 'silver' };
        expect(buildCampaignFinishedScreen(series.id, results).medals).toHaveLength(3);
    });
});

describe('the Campaign finished screen', () => {
    function mountShell(options = {}) {
        const html = readFileSync(join(process.cwd(), 'pages/game.html'), 'utf8');
        document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
        globalThis.requestAnimationFrame = (callback) => {
            const timeout = setTimeout(callback, 0);
            frameTimeouts.push(timeout);
            return timeout;
        };
        const playUnlockSound = vi.fn();
        return { shell: new ModalShell({ content: new ModalContentUi(), playUnlockSound, ...options }), playUnlockSound };
    }

    it('can add or enable Next after the result opens without running its action', () => {
        const { shell } = mountShell();
        const action = vi.fn();
        const button = document.getElementById('combined-next-btn');
        shell.setCombinedNextRace(null);
        expect(button.hidden).toBe(true);

        shell.setCombinedNextRace({ label: 'Finish', enabled: false, action });
        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(true);
        button.click();
        expect(action).not.toHaveBeenCalled();

        shell.setCombinedNextRace(null);
        shell.setCombinedNextRace({ label: 'Finish', enabled: true, action });
        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-label')).toBe('Finish');
        expect(button.textContent.trim()).toBe('FINISH');
        expect(button.classList.contains('combined-action-btn--primary')).toBe(true);
        expect(document.getElementById('combined-restart-btn').classList.contains('combined-action-btn--primary'))
            .toBe(false);
        expect(action).not.toHaveBeenCalled();
        button.click();
        expect(action).toHaveBeenCalledOnce();
    });

    it('shows each tier’s best-stage medal count and the existing medal total', () => {
        const { shell, playUnlockSound } = mountShell();
        const screen = buildCampaignFinishedScreen(
            CAMPAIGN_NUMBERS_SERIES_ID,
            resultsFor(NUMBERS_STAGES, (_stage, index) => (index === 1 ? 'author' : 'gold')),
        );

        shell.showCampaignFinished(screen, {
            primaryAction: vi.fn(),
            secondaryAction: vi.fn(),
        });

        const view = document.getElementById('modal-campaign-finished-view');
        expect(view.classList.contains('active-view')).toBe(true);
        expect(document.getElementById('campaign-finished-title').textContent.replace(/\s+/g, ' ').trim())
            .toBe('Numbers Complete');
        const medals = [...document.querySelectorAll('#campaign-finished-medals .medal-svg')];
        expect(medals.map((medal) => medal.dataset.tier)).toEqual(['bronze', 'silver', 'gold', 'author']);
        expect(medals.map((medal) => medal.querySelector('.medal-svg__center-time').textContent))
            .toEqual(['0', '0', String(NUMBERS_STAGES.length - 1), '1']);
        expect(medals.every((medal) => medal.getAttribute('aria-hidden') === 'true')).toBe(true);
        expect(medals[3].parentElement.getAttribute('aria-label')).toBe('1 author medal');
        expect(medals[2].parentElement.getAttribute('aria-label')).toBe(`${NUMBERS_STAGES.length - 1} gold medals`);
        expect(document.getElementById('campaign-finished-total').textContent).toBe(screen.medalTotal);
        expect(document.getElementById('campaign-finished-primary').hidden).toBe(false);
        expect(document.getElementById('campaign-finished-secondary').hidden).toBe(false);
        expect(document.getElementById('campaign-finished-primary').textContent.trim()).toBe('VIEW CAMPAIGN');
        expect(document.getElementById('campaign-finished-primary').getAttribute('aria-label')).toBe('View Campaign');
        expect(document.getElementById('campaign-finished-secondary').textContent.trim()).toBe('VIEW SERIES');
        expect(document.getElementById('campaign-finished-secondary').getAttribute('aria-label')).toBe('View Series');
        expect(playUnlockSound).toHaveBeenCalledOnce();
        expect(playUnlockSound).toHaveBeenCalledWith('author');
    });

    it('hides Home for pending and confirmed Results, then restores it for replays', () => {
        const { shell } = mountShell();
        const menu = document.getElementById('combined-menu-btn');
        shell.setCombinedNextRace({ label: 'Results', enabled: false, replaceMenu: true, action: vi.fn() });
        expect(menu.hidden).toBe(true);
        shell.setCombinedNextRace({ label: 'Results', replaceMenu: true, action: vi.fn() });
        expect(menu.hidden).toBe(true);
        expect(document.getElementById('combined-next-btn').textContent.trim()).toBe('RESULTS');
        shell.setCombinedNextRace({ label: 'Next', action: vi.fn() });
        expect(menu.hidden).toBe(false);
        shell.setCombinedNextRace(null);
        expect(menu.hidden).toBe(false);
    });

    it('shows the player identity and safely falls back for a missing or invalid avatar', () => {
        const { shell } = mountShell();
        const screen = buildCampaignFinishedScreen(CAMPAIGN_NUMBERS_SERIES_ID, resultsFor(NUMBERS_STAGES));
        shell.showCampaignFinished(screen, {
            playerUsername: 'racer_one',
            playerAvatarUrl: 'https://i.redd.it/racer.png',
        });
        expect(document.getElementById('campaign-finished-player-name').textContent).toBe('racer_one');
        const avatar = document.getElementById('campaign-finished-avatar');
        expect(avatar.src).toBe('https://i.redd.it/racer.png');
        avatar.onerror();
        expect(avatar.src).toBe(GENERIC_SNOO_URL);
        shell.showCampaignFinished(screen, { playerAvatarUrl: 'https://example.com/unsafe.png' });
        expect(avatar.src).toBe(GENERIC_SNOO_URL);
        expect(document.getElementById('campaign-finished-player-name').textContent).toBe('Guest racer');
    });

    const shareRequest = { kind: 'campaign-finished', seriesId: CAMPAIGN_NUMBERS_SERIES_ID, ownerPlayerId: 'reddit:racer_one' };
    const readyPreview = { ok: true, body: {
        status: 'ready', username: 'racer_one', shareToken: 'campaign-token',
        title: 'I finished the Numbers campaign', medalSummary: 'Gold: 1 · Bronze: 16',
        placeSummary: 'Overall place #2 / 17',
    } };

    it('previews results and the posting account, and Cancel never publishes', async () => {
        const previewShare = vi.fn().mockResolvedValue(readyPreview);
        const confirmShare = vi.fn();
        const { shell } = mountShell({ getRedditUsername: () => 'racer_one', previewShare, confirmShare });
        shell.showCampaignFinished(buildCampaignFinishedScreen(CAMPAIGN_NUMBERS_SERIES_ID, resultsFor(NUMBERS_STAGES)), { shareRequest });
        const button = document.getElementById('campaign-finished-share');
        expect(button.classList.contains('combined-action-btn--primary')).toBe(true);
        expect(button.parentElement.lastElementChild).toBe(button);
        button.click();
        await vi.waitFor(() => expect(document.querySelector('.result-share-panel__copy')?.textContent).toContain('I finished the Numbers campaign'));
        expect(previewShare).toHaveBeenCalledWith(shareRequest);
        expect(document.querySelector('.result-share-panel__copy').textContent).toContain('Gold: 1 · Bronze: 16');
        expect(document.querySelector('.result-share-panel__copy').textContent).toContain('Overall place #2 / 17');
        expect(document.querySelector('.result-share-panel__status').textContent).toBe('Post these results as u/racer_one?');
        expect(confirmShare).not.toHaveBeenCalled();
        document.querySelector('.result-share-panel__button--dismiss').click();
        expect(document.querySelector('.result-share-panel')).toBeNull();
        expect(button.disabled).toBe(false);
        expect(button.textContent.trim()).toBe('SHARE RESULTS');
        expect(confirmShare).not.toHaveBeenCalled();
    });

    it('uses the shared confirmation, posting, retry and success controls', async () => {
        let resolveConfirm;
        const confirmShare = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { resolveConfirm = resolve; }))
            .mockResolvedValueOnce({ ok: true, body: { status: 'shared', postId: 't3_campaign', postUrl: 'https://www.reddit.com/r/test/comments/campaign' } });
        const { shell } = mountShell({ getRedditUsername: () => 'racer_one', previewShare: vi.fn().mockResolvedValue(readyPreview), confirmShare });
        shell.showCampaignFinished(buildCampaignFinishedScreen(CAMPAIGN_NUMBERS_SERIES_ID, resultsFor(NUMBERS_STAGES)), { shareRequest });
        document.getElementById('campaign-finished-share').click();
        await vi.waitFor(() => expect(document.querySelector('.result-share-panel__button--primary')?.textContent).toBe('Post Results'));
        // A prior posted Concede must never redirect a Campaign result.
        shell._challengeFinishCommentSpent = 'posted';
        shell._challengeFinishShareRequest = { kind: 'challenge-comment', outcome: 'lost' };
        const confirm = document.querySelector('.result-share-panel__button--primary');
        confirm.click();
        confirm.click();
        expect(confirmShare).toHaveBeenCalledOnce();
        expect(confirmShare).toHaveBeenCalledWith('campaign-token', shareRequest);
        expect(confirm.textContent).toBe('Posting…');
        expect(confirm.disabled).toBe(true);
        expect(document.querySelector('.result-share-panel__button--dismiss').disabled).toBe(true);
        shell._activeTrapModal = shell.modal;
        shell.handleModalTrapKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.querySelector('.result-share-panel')).not.toBeNull();
        resolveConfirm({ ok: false, body: { error: 'Could not confirm your post. Try again to check.' } });
        await vi.waitFor(() => expect(confirm.textContent).toBe('Try Again'));
        confirm.click();
        await vi.waitFor(() => expect(document.querySelector('.result-share-panel__title').textContent).toBe('Results shared'));
        expect(confirmShare).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.result-share-panel__button--primary').textContent).toBe('Send Results');
        expect(document.querySelector('[aria-label="Copy results link"]')).not.toBeNull();
        expect(document.getElementById('campaign-finished-share').textContent.trim()).toBe('SHARED');
        expect(document.getElementById('campaign-finished-share').disabled).toBe(true);
        document.querySelector('.result-share-panel__button--dismiss').click();
        expect(document.querySelector('.result-share-panel')).toBeNull();
    });

    it('opens the existing post outcome without confirming or publishing again', async () => {
        const confirmShare = vi.fn();
        const { shell } = mountShell({ getRedditUsername: () => 'racer_one', confirmShare,
            previewShare: vi.fn().mockResolvedValue({ ok: true, body: { status: 'already_shared', postId: 't3_campaign', postUrl: 'https://www.reddit.com/r/test/comments/campaign' } }),
        });
        shell.showCampaignFinished(buildCampaignFinishedScreen(CAMPAIGN_NUMBERS_SERIES_ID, resultsFor(NUMBERS_STAGES)), { shareRequest });
        document.getElementById('campaign-finished-share').click();
        await vi.waitFor(() => expect(document.querySelector('.result-share-panel__title')?.textContent).toBe('Already posted'));
        expect(document.querySelector('.result-share-panel__copy').textContent).toBe('Your Campaign results are already shared.');
        expect(document.querySelector('.result-share-panel__button--primary').textContent).toBe('Send Results');
        expect(confirmShare).not.toHaveBeenCalled();
    });

    it('uses the shared guest message and discards a cancelled preview response', async () => {
        const previewShare = vi.fn();
        const { shell } = mountShell({ getRedditUsername: () => null, previewShare, confirmShare: vi.fn() });
        const screen = buildCampaignFinishedScreen(CAMPAIGN_NUMBERS_SERIES_ID, resultsFor(NUMBERS_STAGES));
        shell.showCampaignFinished(screen, { shareRequest });
        const button = document.getElementById('campaign-finished-share');
        button.click();
        expect(document.querySelector('.result-share-panel__status').textContent).toContain('Sign in');
        expect(previewShare).not.toHaveBeenCalled();
        document.querySelector('.result-share-panel__button').click();
        shell.getRedditUsername = () => 'racer_one';
        let resolvePreview;
        previewShare.mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve; }));
        button.click();
        shell._activeTrapModal = shell.modal;
        shell.handleModalTrapKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
        resolvePreview(readyPreview);
        await Promise.resolve();
        await Promise.resolve();
        expect(document.querySelector('.result-share-panel')).toBeNull();
        expect(button.disabled).toBe(false);
        expect(button.textContent.trim()).toBe('SHARE RESULTS');
    });

    it('keeps four tier counts for both a single-stage and a long campaign', () => {
        const { shell } = mountShell();
        for (const count of [1, 50]) {
            shell.showCampaignFinished({
                title: 'Test',
                status: 'Complete',
                medals: Array.from({ length: count }, (_value, index) => ({
                    stageNumber: String(index).padStart(2, '0'),
                    tier: 'gold',
                })),
                medalDistribution: { bronze: 0, silver: 0, gold: count, author: 0 },
                medalTotal: '',
            });
            const medals = document.getElementById('campaign-finished-medals');
            expect(medals.children).toHaveLength(4);
            expect(medals.querySelector('[data-campaign-medal="gold"] .medal-svg__center-time').textContent)
                .toBe(String(count));
        }
    });
});
