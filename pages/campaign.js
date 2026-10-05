import { readCampaignPlace } from '../game/campaign/aggregate.js';
import { requestGameLaunchTarget } from '../game/modes/launch-target.js';
import { exposeCampaignLauncherTestHooks } from '../game/debug/launcher-hooks.js';
import { applyAvatar, isRedditAvatarUrl } from '../game/ui/avatar.js';
import { createMedalIconSvg } from '../game/medals/medal-icon.js';
import { formatRaceClock } from '../game/shared/race-time-text.js';
import { cleanText } from '../game/shared/values.js';

const MEDAL_TIERS = ['author', 'gold', 'silver', 'bronze'];
const PLACE_TIERS = ['gold', 'silver', 'bronze'];
const ORDINAL_SUFFIXES = { 1: 'ST', 2: 'ND', 3: 'RD' };
const MAX_ORDINAL_RANK = 100;
const LONG_SERIES_NAME = 16;

export function formatCampaignOrdinalSuffix(rank) {
    const lastTwo = rank % 100;
    if (lastTwo >= 11 && lastTwo <= 13) return 'TH';
    return ORDINAL_SUFFIXES[rank % 10] || 'TH';
}

// Ranks 1-100 read as an ordinal; below that, as a share of all finishers.
export function formatCampaignPlaceFigure({ rank, total }) {
    if (rank <= MAX_ORDINAL_RANK) {
        return { prefix: '', number: String(rank), suffix: formatCampaignOrdinalSuffix(rank) };
    }
    return { prefix: 'TOP', number: `${Math.ceil(rank * 100 / total)}%`, suffix: '' };
}

export function readCampaignFinishedPostData(root = globalThis) {
    const postData = root?.devvit?.context?.postData;
    if (postData?.postType !== 'campaign-finished') return null;
    return {
        seriesId: cleanText(postData.seriesId),
        seriesName: cleanText(postData.seriesName) || 'Campaign',
        playerUsername: cleanText(postData.playerUsername).replace(/^u\//i, '') || 'A racer',
        playerAvatarUrl: isRedditAvatarUrl(postData.playerAvatarUrl) ? postData.playerAvatarUrl : null,
        medalDistribution: Object.fromEntries(MEDAL_TIERS.map((tier) => {
            const count = postData.medalDistribution?.[tier];
            return [tier, Number.isSafeInteger(count) && count >= 0 ? count : 0];
        })),
        place: readCampaignPlace(postData.place),
        totalTimeMs: readPositiveInteger(postData.totalTimeMs),
        stageCount: readPositiveInteger(postData.stageCount),
    };
}

function readPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function renderCampaignPlace(byId, poster, place) {
    const block = byId('campaign-finished-place');
    if (!block) return;
    block.hidden = !place;
    const tier = PLACE_TIERS[place ? place.rank - 1 : -1];
    for (const name of PLACE_TIERS) poster?.classList.toggle(`finished-shell--${name}`, name === tier);
    if (!place) return;
    const figure = formatCampaignPlaceFigure(place);
    const total = place.total.toLocaleString('en-US');
    byId('campaign-finished-place-prefix').textContent = figure.prefix;
    byId('campaign-finished-place-number').textContent = figure.number;
    byId('campaign-finished-place-suffix').textContent = figure.suffix;
    byId('campaign-finished-place-total').textContent = `of ${total}`;
    byId('campaign-finished-place-text').textContent = `Overall place ${place.rank} of ${total}`;
    byId('campaign-finished-place-figure').style?.setProperty('--place-chars', String(figure.number.length));
}

export function renderCampaignFinishedPoster(documentRef, value) {
    if (!documentRef || !value) return;
    const byId = (id) => documentRef.getElementById(id);
    const launcher = byId('campaign-launcher');
    if (launcher) launcher.hidden = true;
    const poster = byId('campaign-finished-poster');
    if (poster) poster.hidden = false;
    byId('campaign-finished-summary').textContent = `I finished the ${value.seriesName} campaign.`;
    byId('campaign-finished-name').textContent = value.playerUsername;
    applyAvatar(byId('campaign-finished-avatar'), value.playerAvatarUrl, {
        alt: `${value.playerUsername} avatar`,
        genericClass: 'finished-avatar--generic',
    });
    const series = byId('campaign-finished-series');
    series.textContent = value.seriesName;
    series.classList.toggle('finished-headline__series--long', value.seriesName.length > LONG_SERIES_NAME);
    byId('campaign-finished-time').hidden = !value.totalTimeMs;
    byId('campaign-finished-time-value').textContent = value.totalTimeMs ? formatRaceClock(value.totalTimeMs) : '';
    byId('campaign-finished-stages').textContent = value.stageCount
        ? `${value.stageCount} ${value.stageCount === 1 ? 'stage' : 'stages'}`
        : '';
    renderCampaignPlace(byId, poster, value.place);
    const medals = byId('campaign-finished-medals');
    for (const tier of MEDAL_TIERS) {
        const slot = medals?.querySelector(`[data-campaign-medal="${tier}"]`);
        if (!slot) continue;
        const count = value.medalDistribution[tier];
        slot.setAttribute('aria-label', `${count} ${tier} ${count === 1 ? 'medal' : 'medals'}`);
        slot.replaceChildren(createMedalIconSvg(tier, {
            className: 'finished-medal-icon',
            centerText: String(count),
            showEmblem: false,
        }));
    }
    byId('campaign-finished-race-btn').disabled = !value.seriesId;
}

export async function openCampaignGame(event, {
    requestLaunchTarget = requestGameLaunchTarget,
    requestExpanded = null,
    root = globalThis,
} = {}) {
    const finished = readCampaignFinishedPostData(root);
    if (finished && !finished.seriesId) return false;
    if (finished) requestLaunchTarget('campaign', { seriesId: finished.seriesId });
    else requestLaunchTarget('campaign');
    try {
        const expand = requestExpanded
            || (await import('@devvit/web/client')).requestExpandedMode;
        await expand(event, 'game');
        return true;
    } catch (error) {
        console.error('Failed to open Mini Racer Campaign in expanded mode:', error);
        return false;
    }
}

export function bindCampaignRaceButton(
    documentRef = document,
    openGame = openCampaignGame,
) {
    const finished = documentRef?.getElementById('campaign-finished-poster')?.hidden === false;
    const button = documentRef?.getElementById(finished ? 'campaign-finished-race-btn' : 'campaign-race-btn');
    if (!button || button.dataset.bound === '1') return button || null;
    button.dataset.bound = '1';
    button.addEventListener('click', (event) => {
        void openGame(event);
    });
    return button;
}

export function bootCampaignLauncher(documentRef = document, root = globalThis) {
    const finished = readCampaignFinishedPostData(root);
    renderCampaignFinishedPoster(documentRef, finished);
    bindCampaignRaceButton(documentRef, (event) => openCampaignGame(event, { root }));
    exposeCampaignLauncherTestHooks(finished);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => bootCampaignLauncher(), { once: true });
    } else {
        bootCampaignLauncher();
    }
}
