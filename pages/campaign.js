import { formatCampaignTotalTime, readCampaignPlace } from '../game/campaign/aggregate.js';
import { getCampaignFinalStage, getCampaignSeries } from '../game/campaign/manifest.js';
import { getCampaignSeriesGrounds } from '../game/campaign/series-surfaces.js';
import { TRACKS } from '../game/track/tracks.js';
import { ensureStoredTracks, registerStoredTracksFromPayload } from '../game/track/stored-track-service.js';
import { requestJsonWithTimeout } from '../game/scoreboard/player-request.js';
import { renderTrackPreviewCanvas } from '../game/track/preview-renderer.js';
import { createPosterCarDrive, loadPosterCar } from '../game/track/poster-car.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from '../game/track/presentation.js';
import { requestGameLaunchTarget } from '../game/modes/launch-target.js';
import { exposeCampaignLauncherTestHooks } from '../game/debug/launcher-hooks.js';
import { applyAvatar, isRedditAvatarUrl } from '../game/ui/avatar.js';
import { cleanText } from '../game/shared/values.js';

import { campaignPosterTheme, campaignPosterTime, campaignPosterPlace, campaignCompletionAccent } from '../game/campaign/completion-presentation.js';
export { campaignPosterTheme, campaignPosterTime, campaignPosterPlace } from '../game/campaign/completion-presentation.js';

const MEDAL_TIERS = ['author', 'gold', 'silver', 'bronze'];

export function readCampaignFinishedPostData(root = globalThis) {
    const postData = root?.devvit?.context?.postData;
    if (postData?.postType !== 'campaign-finished') return null;
    const seriesId = cleanText(postData.seriesId);
    const series = getCampaignSeries(seriesId);
    const medalDistribution = Object.fromEntries(MEDAL_TIERS.map((tier) => {
        const count = postData.medalDistribution?.[tier];
        return [tier, Number.isSafeInteger(count) && count >= 0 ? count : 0];
    }));
    const completedTracks = MEDAL_TIERS.reduce((total, tier) => total + medalDistribution[tier], 0);
    const stageCount = Number.isSafeInteger(postData.stageCount) && postData.stageCount > 0
        ? postData.stageCount : completedTracks;
    return {
        seriesId,
        seriesName: cleanText(postData.seriesName) || 'Campaign',
        playerUsername: cleanText(postData.playerUsername).replace(/^u\//i, '') || 'A racer',
        playerAvatarUrl: isRedditAvatarUrl(postData.playerAvatarUrl) ? postData.playerAvatarUrl : null,
        medalDistribution,
        stageCount,
        completedTracks,
        medalCount: MEDAL_TIERS.reduce((total, tier, index) => total + medalDistribution[tier] * (4 - index), 0),
        totalTimeMs: Number.isSafeInteger(postData.totalTimeMs) && postData.totalTimeMs > 0
            ? postData.totalTimeMs : null,
        trackKey: cleanText(postData.trackKey) || getCampaignFinalStage(seriesId)?.trackKey || '',
        ground: cleanText(postData.ground) || series?.ground || 'tarmac',
        grounds: getCampaignSeriesGrounds({
            ground: cleanText(postData.ground) || series?.ground || 'tarmac',
            grounds: postData.grounds ?? series?.grounds,
        }),
        hasSurfaceMetadata: getCampaignSeriesGrounds({ grounds: postData.grounds ?? series?.grounds }).length > 0
            && Array.isArray(postData.grounds ?? series?.grounds),
        place: readCampaignPlace(postData.place),
    };
}

export function renderCampaignFinishedPoster(documentRef, value) {
    if (!documentRef || !value) return;
    documentRef.querySelector('.campaign-launcher')?.classList.add('campaign-launcher--finished');
    documentRef.body?.setAttribute('data-campaign-theme', campaignPosterTheme(value.seriesId, value.ground, value.grounds));
    documentRef.body?.style?.setProperty('--poster-accent', campaignCompletionAccent(value));
    const player = documentRef.getElementById('campaign-player');
    if (player) player.hidden = false;
    const playerName = documentRef.getElementById('campaign-player-name');
    if (playerName) playerName.textContent = value.playerUsername;
    applyAvatar(documentRef.getElementById('campaign-player-avatar'), value.playerAvatarUrl, {
        alt: `${value.playerUsername} avatar`,
        genericClass: 'campaign-player__avatar--generic',
    });
    const eyebrow = documentRef.getElementById('campaign-eyebrow');
    if (eyebrow) eyebrow.textContent = value.seriesName;
    const title = documentRef.getElementById('campaign-title');
    if (title) {
        title.textContent = '';
        const line = documentRef.createElement('span');
        line.textContent = 'Campaign';
        const completed = documentRef.createElement('span');
        completed.className = 'campaign-title__complete';
        completed.textContent = 'Complete!';
        title.append(line, completed);
    }
    const description = documentRef.getElementById('campaign-description');
    if (description) description.textContent = `I finished the ${value.seriesName} campaign.`;
    const results = documentRef.getElementById('campaign-results');
    if (results) results.hidden = false;
    for (const [id, text] of [
        ['campaign-tracks', value.stageCount > 0 ? String(value.completedTracks) : ''],
        ['campaign-medal-total', value.stageCount > 0 ? `${value.medalCount} / ${value.stageCount * 4}` : ''],
        ['campaign-total-time', campaignPosterTime(value.totalTimeMs)],
    ]) {
        const stat = documentRef.getElementById(id);
        const content = documentRef.getElementById(`${id}-value`);
        if (stat) stat.hidden = !text;
        if (content) content.textContent = text;
    }
    const exactTime = formatCampaignTotalTime(value.totalTimeMs);
    if (exactTime) documentRef.getElementById('campaign-total-time')?.setAttribute('aria-label', `Total best time ${exactTime}`);
    const place = documentRef.getElementById('campaign-place');
    const placeValue = documentRef.getElementById('campaign-place-value');
    if (place && placeValue) {
        const display = campaignPosterPlace(value.place);
        place.hidden = !display;
        placeValue.textContent = display?.headline || '';
        const caption = documentRef.getElementById('campaign-place-caption');
        if (caption) caption.textContent = display?.caption || '';
        if (display) place.setAttribute('aria-label', `Overall place ${value.place.rank} of ${value.place.total}`);
    }
    const button = documentRef.getElementById('campaign-race-btn');
    if (button) {
        button.textContent = 'Play Campaign';
        button.disabled = !value.seriesId;
    }
}

export function renderCampaignPosterTrack(documentRef, value, car = null) {
    const canvas = documentRef?.getElementById('campaign-track');
    const track = TRACKS[value?.trackKey];
    if (!canvas) return;
    canvas.hidden = !track;
    if (!track) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (width < 2 || height < 2) return;
    canvas.width = width;
    canvas.height = height;
    renderTrackPreviewCanvas(canvas, {
        trackGeometry: { outer: track.outer, inner: track.inner },
        cornerRadius: track.cornerRadius,
        presentation: resolveTrackPresentation(value.trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            ground: track.ground,
        }),
        startLine: track.startLine,
        startPos: track.startPos,
        startAngle: track.startAngle ?? 0,
        transparentBackground: true,
        previewRenderMode: 'schematic',
        showSchematicCarTrail: true,
        moveSchematicCarPastStartLine: true,
        schematicCarImage: car?.image ?? null,
        schematicCarTravel: car?.travel ?? 1,
        schematicReserveCarSlot: true,
        hideSchematicStartArrow: true,
        runHistory: [],
    });
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

// Old Creator posts lack final-track and surface data; this loads public artwork only, never viewer progress.
export async function prepareCampaignPoster(value, {
    requestMetadata = (seriesId) => requestJsonWithTimeout(
        `/api/campaign/poster?seriesId=${encodeURIComponent(seriesId)}`,
        { headers: { Accept: 'application/json' } },
        8_000,
    ),
    ensureTracks = ensureStoredTracks,
    registerTracks = registerStoredTracksFromPayload,
} = {}) {
    if (!value) return null;
    let prepared = value;
    if (value.seriesId && (!value.trackKey || !value.hasSurfaceMetadata)) {
        try {
            const response = await requestMetadata(value.seriesId);
            const metadata = response?.body;
            if (response?.ok && metadata?.seriesId === value.seriesId
                && typeof metadata.trackKey === 'string' && metadata.trackKey) {
                if (Array.isArray(metadata.storedTracks)) registerTracks(metadata.storedTracks);
                const grounds = getCampaignSeriesGrounds(metadata);
                prepared = {
                    ...value,
                    // An existing post pins its representative track; recovery only fills a missing key.
                    trackKey: value.trackKey || metadata.trackKey,
                    ground: cleanText(metadata.ground) || value.ground,
                    grounds: grounds.length ? grounds : value.grounds,
                    hasSurfaceMetadata: grounds.length > 0,
                };
            }
        } catch (error) {
            console.warn('Campaign poster artwork could not load:', error);
        }
    }
    if (prepared.trackKey) await ensureTracks([prepared.trackKey], { includeBuiltIn: true });
    return prepared;
}

export function bootCampaignLauncher(documentRef = document, root = globalThis) {
    const finished = readCampaignFinishedPostData(root);
    renderCampaignFinishedPoster(documentRef, finished);
    bindCampaignRaceButton(documentRef, (event) => openCampaignGame(event, { root }));
    exposeCampaignLauncherTestHooks(finished);
    if (finished) {
        let poster = finished;
        lastPoster = finished;
        const drive = createPosterCarDrive((image, travel) => {
            lastPosterCar = { image, travel };
            renderCampaignPosterTrack(documentRef, poster, lastPosterCar);
        });
        // Stats and the launch action are ready while cosmetic stored artwork loads.
        renderCampaignPosterTrack(documentRef, finished);
        return prepareCampaignPoster(finished).then(async (prepared) => {
            poster = prepared;
            lastPoster = prepared;
            renderCampaignFinishedPoster(documentRef, prepared);
            exposeCampaignLauncherTestHooks(prepared);
            renderCampaignPosterTrack(documentRef, prepared);
            if (TRACKS[prepared.trackKey]) drive.drive(await loadPosterCar(TRACKS[prepared.trackKey]));
        });
    }
}

let lastPosterCar = null;
let lastPoster = null;

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => bootCampaignLauncher(), { once: true });
    } else {
        bootCampaignLauncher();
    }
    globalThis.addEventListener('resize', () => {
        renderCampaignPosterTrack(document, lastPoster || readCampaignFinishedPostData(), lastPosterCar);
    });
}
