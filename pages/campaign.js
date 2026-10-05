import { formatCampaignPlace, readCampaignPlace } from '../game/campaign/aggregate.js';
import { requestGameLaunchTarget } from '../game/modes/launch-target.js';
import { exposeCampaignLauncherTestHooks } from '../game/debug/launcher-hooks.js';
import { formatSeriesMedals } from '../game/lobby/campaign-series-picker.js';
import { STANDARD_MEDAL_TIER_RANK } from '../game/medals/medal-timing.js';
import { formatRaceClock } from '../game/shared/race-time-text.js';
import { cleanText } from '../game/shared/values.js';
import { createPosterCarDrive, loadPosterCar } from '../game/track/poster-car.js';
import { renderPosterTrack } from '../game/track/poster-track.js';
import { ensureStoredTracks } from '../game/track/stored-track-service.js';
import { TRACKS } from '../game/track/tracks.js';
import { applyAvatar, isRedditAvatarUrl } from '../game/ui/avatar.js';

const MEDAL_TIERS = ['author', 'gold', 'silver', 'bronze'];
const MAX_LISTED_PLACE = 100;

// Places past 100th read as a share of all finishers.
export function formatCampaignOverallPlace(place) {
    if (place.rank <= MAX_LISTED_PLACE) return formatCampaignPlace(place);
    return `TOP ${Math.ceil(place.rank * 100 / place.total)}%`;
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
        stageCount: readPositiveInteger(postData.stageCount),
        place: readCampaignPlace(postData.place),
        totalTimeMs: readPositiveInteger(postData.totalTimeMs),
        bestTrackKey: cleanText(postData.bestTrackKey),
    };
}

function readPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function formatFinishedMedals({ medalDistribution, stageCount }) {
    if (!stageCount) return '';
    const medalCount = MEDAL_TIERS.reduce(
        (sum, tier) => sum + medalDistribution[tier] * (STANDARD_MEDAL_TIER_RANK[tier] + 1),
        0,
    );
    return formatSeriesMedals({ medalCount, stageCount });
}

function showStat(documentRef, name, text) {
    documentRef.getElementById(`campaign-finished-${name}`).hidden = !text;
    documentRef.getElementById(`campaign-finished-${name}-value`).textContent = text;
}

export function renderCampaignFinishedPoster(documentRef, value) {
    if (!documentRef || !value) return;
    documentRef.getElementById('campaign-launcher').hidden = true;
    documentRef.getElementById('campaign-finished-poster').hidden = false;
    documentRef.getElementById('campaign-finished-name').textContent = value.playerUsername;
    applyAvatar(documentRef.getElementById('campaign-finished-avatar'), value.playerAvatarUrl, {
        alt: `${value.playerUsername} avatar`,
        genericClass: 'finished-avatar--generic',
    });
    documentRef.getElementById('campaign-finished-series').textContent = value.seriesName;
    showStat(documentRef, 'place', value.place ? formatCampaignOverallPlace(value.place) : '');
    showStat(documentRef, 'medals', formatFinishedMedals(value));
    showStat(documentRef, 'time', value.totalTimeMs ? formatRaceClock(value.totalTimeMs) : '');
    documentRef.getElementById('campaign-finished-race-btn').disabled = !value.seriesId;
}

let shownTrack = null;

function paintFinishedTrack(documentRef) {
    if (!shownTrack) return;
    renderPosterTrack(
        documentRef.getElementById('campaign-finished-track'),
        shownTrack.trackKey,
        shownTrack.image,
        shownTrack.travel,
    );
}

// A track made in the Creator is not in the app, so the page loads it first.
export async function showFinishedTrack(documentRef, trackKey) {
    if (!trackKey) return;
    await ensureStoredTracks([trackKey], { includeBuiltIn: true });
    const canvas = documentRef?.getElementById('campaign-finished-track');
    if (!canvas || !TRACKS[trackKey]) return;
    canvas.hidden = false;
    shownTrack = { trackKey, image: null, travel: 1 };
    paintFinishedTrack(documentRef);
    const drive = createPosterCarDrive((image, travel) => {
        shownTrack = { trackKey, image, travel };
        paintFinishedTrack(documentRef);
    });
    drive.drive(await loadPosterCar(TRACKS[trackKey]));
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
    void showFinishedTrack(documentRef, finished?.bestTrackKey).catch((error) => {
        console.error('The Campaign finished track could not be drawn:', error);
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => bootCampaignLauncher(), { once: true });
    } else {
        bootCampaignLauncher();
    }
    globalThis.addEventListener('resize', () => paintFinishedTrack(document));
}
