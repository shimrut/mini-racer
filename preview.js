import { TRACKS } from './game/track/tracks.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from './game/track/presentation.js';
import { CarSpriteLoader, STOCK_CAR_ASSET_NAME } from './game/car/sprite.js';
import { createMedalIconSvg } from './game/medals/medal-icon.js';
import {
    getActiveDailyChallenge,
    getDailyChallengeCardStatus,
    requestFeaturedDailyChallengeStart
} from './game/daily-challenge/service.js';
import {
    getRaceMedalThresholds,
} from './game/medals/medal-timing.js';
import { formatLapsLabel } from './game/shared/laps-label.js';
import { requestGameLaunchTarget } from './game/modes/launch-target.js';

export function isCurrentDailyLauncherPost(root = globalThis) {
    return root?.devvit?.context?.postData?.postType === 'daily-launcher';
}

export function getDailyPreviewChallengeOptions(root = globalThis) {
    return {
        allowExpiredPost: true,
        ignorePostData: isCurrentDailyLauncherPost(root),
    };
}

const DAILY_POSTER_CAR_ENTRANCE_MS = 480;

export function dailyPosterCarTravelAt(elapsedMs, { reduceMotion = false } = {}) {
    if (reduceMotion) return 1;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
    const progress = Math.min(1, elapsedMs / DAILY_POSTER_CAR_ENTRANCE_MS);
    return 1 - (1 - progress) ** 3;
}

function prefersReducedDailyPosterMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

export async function bootDailyPreview() {
    const playButton = document.getElementById('play-button');
    const trackNameEl = document.getElementById('track-name');
    const canvas = document.getElementById('track-preview');

    if (!playButton || !trackNameEl || !canvas) {
        return;
    }

    const timeToBeatEl = document.getElementById('time-to-beat');
    const fallbackTrack = TRACKS.circuit;

    let currentTrackKey = 'circuit';
    let currentTrack = fallbackTrack;
    let currentSkin = 'default';
    let currentChallenge = null;
    let posterCarImage = null;
    let posterCarTravel = 1;
    let posterEntranceFrame = 0;
    const postPreviewCarPromise = loadPostPreviewCar();

    const paintPoster = () => {
        renderTrackPreview(
            canvas,
            currentTrackKey,
            currentTrack,
            currentSkin,
            posterCarImage,
            posterCarTravel,
        );
    };

    const drivePosterCar = (carImage) => {
        posterCarImage = carImage;
        cancelAnimationFrame(posterEntranceFrame);
        const reduceMotion = prefersReducedDailyPosterMotion();
        posterCarTravel = dailyPosterCarTravelAt(0, { reduceMotion });
        paintPoster();
        if (!carImage || posterCarTravel >= 1) return;
        const startedAt = performance.now();
        const frame = (now) => {
            posterCarTravel = dailyPosterCarTravelAt(now - startedAt, { reduceMotion });
            paintPoster();
            if (posterCarTravel < 1) posterEntranceFrame = requestAnimationFrame(frame);
        };
        posterEntranceFrame = requestAnimationFrame(frame);
    };

    try {
        const challenge = await getActiveDailyChallenge(getDailyPreviewChallengeOptions());
        currentChallenge = challenge;
        currentTrackKey = TRACKS[challenge.trackKey] ? challenge.trackKey : 'circuit';
        currentTrack = TRACKS[currentTrackKey] || fallbackTrack;
        currentSkin = challenge.skin || 'default';

        const lapCount = getChallengeLapCount(challenge);
        setTrackName(trackNameEl, currentTrack.name);
        await applyTimeToBeat(timeToBeatEl, currentTrackKey, lapCount);
        renderChallengeStatus(challenge);
        paintPoster();
        void postPreviewCarPromise.then(drivePosterCar);
    } catch (error) {
        console.error('Error loading daily challenge preview:', error);
        setTrackName(trackNameEl, 'Challenge active');
        currentTrackKey = 'circuit';
        currentTrack = fallbackTrack;
        currentSkin = 'default';
        if (fallbackTrack) {
            await applyTimeToBeat(timeToBeatEl, 'circuit', 1);
            paintPoster();
        }
        void postPreviewCarPromise.then(drivePosterCar);
    }

    playButton.addEventListener('click', async (event) => {
        const status = getDailyChallengeCardStatus(currentChallenge);
        if (status.key === 'expired') {
            event.preventDefault();
            await showExpiredChallengeMessage(currentChallenge);
            return;
        }

        await openGame(event);
    });

    window.addEventListener('resize', paintPoster);
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        void bootDailyPreview();
    });
}

function loadPostPreviewCar() {
    const loader = new CarSpriteLoader();
    return new Promise((resolve) => {
        loader.load(STOCK_CAR_ASSET_NAME, {
            onLoaded: resolve,
            onError: () => {
                console.warn(`Unable to load ${STOCK_CAR_ASSET_NAME} in the custom post preview.`);
                resolve(null);
            }
        });
    });
}

async function openGame(event) {
    try {
        requestGameLaunchTarget('daily');
        const { requestExpandedMode } = await import('@devvit/web/client');
        await requestExpandedMode(event, 'game');
    } catch (error) {
        console.error('Failed to open Mini Racer in expanded mode:', error);
    }
}

async function showExpiredChallengeMessage(expiredChallenge) {
    const expiredTrackName = getChallengeTrackName(expiredChallenge);
    const featuredChallenge = await getActiveDailyChallenge().catch(() => null);
    const featuredTrackName = getChallengeTrackName(featuredChallenge);
    const existing = document.getElementById('expired-challenge-message');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'expired-challenge-message';
    overlay.className = 'expired-message';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const message = document.createElement('p');
    message.className = 'expired-message__text';
    message.textContent = `${expiredTrackName} is no longer available. Today's featured track is ${featuredTrackName}.`;

    const button = document.createElement('button');
    button.className = 'expired-message__ok';
    button.type = 'button';
    button.textContent = 'OK';
    button.addEventListener('click', async (event) => {
        requestFeaturedDailyChallengeStart();
        await openGame(event);
    });

    overlay.append(message, button);
    document.body.append(overlay);
    button.focus();
}

function getChallengeTrackName(challenge) {
    const trackKey = typeof challenge?.trackKey === 'string' ? challenge.trackKey : '';
    return TRACKS[trackKey]?.name || 'This track';
}

function getChallengeLapCount(challenge) {
    const lapCount = challenge?.objectiveParams?.lapCount;
    return Number.isInteger(lapCount) && lapCount >= 1 && lapCount <= 3 ? lapCount : 1;
}

async function applyTimeToBeat(el, trackKey, lapCount = 1) {
    if (!el) return;
    const labelEl = el.querySelector('.hud-label');
    const textEl = el.querySelector('#time-to-beat-text');
    const medalEl = el.querySelector('#time-to-beat-medal');
    const seconds = getRaceMedalThresholds(trackKey, lapCount)?.gold;

    if (!Number.isFinite(seconds)) {
        if (textEl) textEl.textContent = '';
        medalEl?.replaceChildren();
        el.hidden = true;
        return;
    }
    el.hidden = false;
    medalEl?.replaceChildren(createMedalIconSvg('gold', {
        className: 'post-preview-gold-medal'
    }));
    if (labelEl) {
        labelEl.textContent = formatDailyPreviewTimeLabel(lapCount);
    }
    if (textEl) {
        textEl.textContent = formatTimeToBeat(seconds);
    }
}

export function formatDailyPreviewTimeLabel(lapCount = 1) {
    return `${formatLapsLabel(lapCount).toUpperCase()} · TIME TO BEAT`;
}

function formatTimeToBeat(seconds) {
    return seconds.toFixed(2).padStart(5, '0');
}

function renderChallengeStatus(challenge) {
    const statusEl = document.getElementById('challenge-status');
    if (!statusEl || !challenge) return;

    const status = getDailyChallengeCardStatus(challenge);
    statusEl.textContent = status.key === 'featured'
        ? 'TODAY'
        : status.label.toUpperCase();
    statusEl.className = `challenge-status challenge-status--${status.key}`;
}

function renderTrackPreview(canvas, trackKey, track, skin = 'default', carImage = null, carTravel = 1) {
    const presentation = resolveTrackPresentation(trackKey, {
        surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
        event: skin ? { key: 'daily-challenge', trackKey, skin } : null
    });

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(100, Math.round(rect.width * dpr));
    canvas.height = Math.max(100, Math.round(rect.height * dpr));

    renderTrackPreviewCanvas(canvas, {
        trackGeometry: { outer: track.outer, inner: track.inner },
        presentation,
        startLine: track.startLine,
        startPos: track.startPos,
        startAngle: track.startAngle ?? 0,
        transparentBackground: true,
        previewRenderMode: 'schematic',
        showSchematicCarTrail: true,
        moveSchematicCarPastStartLine: true,
        schematicCarImage: carImage,
        schematicCarTravel: carTravel,
        schematicReserveCarSlot: true,
        hideSchematicStartArrow: true,
        runHistory: []
    });
}



function setTrackName(el, name) {
    if (!el) return;
    const words = name.trim().split(/\s+/);
    let first = '';
    let second = '';
    if (words.length > 1) {
        first = words[0];
        second = words.slice(1).join(' ');
    } else {
        first = '';
        second = words[0] || '';
    }

    el.replaceChildren();

    if (first) {
        const span1 = document.createElement('span');
        span1.className = 'track-title__first';
        span1.textContent = first.toUpperCase();
        el.appendChild(span1);
    }
    if (second) {
        const span2 = document.createElement('span');
        span2.className = 'track-title__second';
        span2.textContent = second.toUpperCase();
        el.appendChild(span2);
    }
}
