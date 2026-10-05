import { formatCampaignPlace, readCampaignPlace } from '../game/campaign/aggregate.js';
import { requestGameLaunchTarget } from '../game/modes/launch-target.js';
import { exposeCampaignLauncherTestHooks } from '../game/debug/launcher-hooks.js';
import { applyAvatar, isRedditAvatarUrl } from '../game/ui/avatar.js';
import { createMedalIconSvg } from '../game/medals/medal-icon.js';
import { cleanText } from '../game/shared/values.js';

const MEDAL_TIERS = ['author', 'gold', 'silver', 'bronze'];

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
    };
}

export function renderCampaignFinishedPoster(documentRef, value) {
    if (!documentRef || !value) return;
    documentRef.querySelector('.campaign-launcher')?.classList.add('campaign-launcher--finished');
    const player = documentRef.getElementById('campaign-player');
    if (player) player.hidden = false;
    const playerName = documentRef.getElementById('campaign-player-name');
    if (playerName) playerName.textContent = value.playerUsername;
    applyAvatar(documentRef.getElementById('campaign-player-avatar'), value.playerAvatarUrl, {
        alt: `${value.playerUsername} avatar`,
        genericClass: 'campaign-player__avatar--generic',
    });
    const eyebrow = documentRef.getElementById('campaign-eyebrow');
    if (eyebrow) eyebrow.textContent = 'Campaign finished';
    const title = documentRef.getElementById('campaign-title');
    if (title) title.textContent = value.seriesName;
    const description = documentRef.getElementById('campaign-description');
    if (description) description.textContent = `I finished the ${value.seriesName} campaign.`;
    const place = documentRef.getElementById('campaign-place');
    const placeValue = documentRef.getElementById('campaign-place-value');
    if (place && placeValue) {
        const label = formatCampaignPlace(value.place);
        place.hidden = !label;
        placeValue.textContent = label;
        if (label) place.setAttribute('aria-label', `Overall place ${value.place.rank} of ${value.place.total}`);
    }
    const medals = documentRef.getElementById('campaign-medals');
    if (medals) {
        medals.hidden = false;
        for (const tier of MEDAL_TIERS) {
            const slot = medals.querySelector(`[data-campaign-medal="${tier}"]`);
            if (!slot) continue;
            const count = value.medalDistribution[tier];
            slot.setAttribute('aria-label', `${count} ${tier} ${count === 1 ? 'medal' : 'medals'}`);
            slot.replaceChildren(createMedalIconSvg(tier, {
                className: 'campaign-medal-icon',
                centerText: String(count),
                showEmblem: false,
            }));
        }
    }
    const button = documentRef.getElementById('campaign-race-btn');
    if (button) {
        button.textContent = 'Play Campaign';
        button.disabled = !value.seriesId;
    }
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
    const button = documentRef?.getElementById('campaign-race-btn');
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
