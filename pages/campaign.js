import { formatCampaignPlace, readCampaignPlace } from '../game/campaign/aggregate.js';
import { requestGameLaunchTarget } from '../game/modes/launch-target.js';
import { exposeCampaignLauncherTestHooks } from '../game/debug/launcher-hooks.js';
import { applyAvatar, isRedditAvatarUrl } from '../game/ui/avatar.js';
import { createMedalIconSvg } from '../game/medals/medal-icon.js';
import { formatRaceClock } from '../game/shared/race-time-text.js';
import { cleanText } from '../game/shared/values.js';

const MEDAL_TIERS = ['author', 'gold', 'silver', 'bronze'];

function readPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
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

export function renderCampaignFinishedPoster(documentRef, value) {
    if (!documentRef || !value) return;
    const byId = (id) => documentRef.getElementById(id);
    const launcher = byId('campaign-launcher');
    if (launcher) launcher.hidden = true;
    const poster = byId('campaign-finished-poster');
    if (poster) poster.hidden = false;
    const playerName = byId('campaign-finished-name');
    if (playerName) playerName.textContent = value.playerUsername;
    applyAvatar(byId('campaign-finished-avatar'), value.playerAvatarUrl, {
        alt: `${value.playerUsername} avatar`,
        genericClass: 'finished-avatar--generic',
    });
    const summary = byId('campaign-finished-summary');
    if (summary) summary.textContent = `I finished the ${value.seriesName} campaign.`;
    const hasTime = value.totalTimeMs !== null;
    const timeLabel = byId('campaign-finished-label');
    if (timeLabel) timeLabel.hidden = !hasTime;
    const time = byId('campaign-finished-time');
    if (time) {
        time.hidden = !hasTime;
        if (hasTime) {
            const clock = formatRaceClock(value.totalTimeMs);
            time.textContent = clock;
            time.style.setProperty('--time-chars', String(clock.length));
        }
    }
    const title = byId('campaign-finished-title');
    if (title) title.textContent = value.seriesName;
    const stages = byId('campaign-finished-stages');
    if (stages) {
        stages.textContent = value.stageCount
            ? `${value.stageCount} ${value.stageCount === 1 ? 'stage' : 'stages'}`
            : '';
    }
    const place = byId('campaign-finished-place');
    const placeValue = byId('campaign-finished-place-value');
    if (place && placeValue) {
        const label = formatCampaignPlace(value.place);
        place.hidden = !label;
        placeValue.textContent = label;
        if (label) place.setAttribute('aria-label', `Overall place ${value.place.rank} of ${value.place.total}`);
    }
    const medals = byId('campaign-finished-medals');
    if (medals) {
        for (const tier of MEDAL_TIERS) {
            const slot = medals.querySelector(`[data-campaign-medal="${tier}"]`);
            if (!slot) continue;
            const count = value.medalDistribution[tier];
            slot.setAttribute('aria-label', `${count} ${tier} ${count === 1 ? 'medal' : 'medals'}`);
            slot.replaceChildren(createMedalIconSvg(tier, {
                className: 'finished-medal-icon',
                centerText: String(count),
                showEmblem: false,
            }));
        }
    }
    const button = byId('campaign-finished-race-btn');
    if (button) button.disabled = !value.seriesId;
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
    const finishedShown = documentRef?.getElementById('campaign-finished-poster')?.hidden === false;
    const button = documentRef?.getElementById(finishedShown ? 'campaign-finished-race-btn' : 'campaign-race-btn');
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
