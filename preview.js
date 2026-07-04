import { TRACKS } from './game/track/tracks.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from './game/track/presentation.js';
import {
    getActiveDailyChallenge,
    getDailyChallengeCardStatus,
    requestFeaturedDailyChallengeStart
} from './game/daily-challenge/service.js';
import {
    getTimeToBeatSeconds,
} from './game/medals/medals.js';

document.addEventListener('DOMContentLoaded', async () => {
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

    try {
        const challenge = await getActiveDailyChallenge({ allowExpiredPost: true });
        currentChallenge = challenge;
        currentTrackKey = TRACKS[challenge.trackKey] ? challenge.trackKey : 'circuit';
        currentTrack = TRACKS[currentTrackKey] || fallbackTrack;
        currentSkin = challenge.skin || 'default';

        setTrackName(trackNameEl, currentTrack.name);
        renderTrackPreview(canvas, currentTrackKey, currentTrack, currentSkin);
        await applyTimeToBeat(timeToBeatEl, currentTrackKey);
        renderChallengeStatus(challenge);
    } catch (error) {
        console.error('Error loading daily challenge preview:', error);
        setTrackName(trackNameEl, 'Challenge active');
        if (fallbackTrack) {
            renderTrackPreview(canvas, 'circuit', fallbackTrack, 'default');
        }
        await applyTimeToBeat(timeToBeatEl, 'circuit');
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

    // Dynamic resize handler to keep track drawing resolution extremely sharp and responsive
    window.addEventListener('resize', () => {
        renderTrackPreview(canvas, currentTrackKey, currentTrack, currentSkin);
    });
});

async function openGame(event) {
    try {
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

async function applyTimeToBeat(el, trackKey) {
    if (!el) return;
    const textEl = el.querySelector('#time-to-beat-text');
    let seconds = getTimeToBeatSeconds(trackKey, null);

    if (!Number.isFinite(seconds)) {
        if (textEl) textEl.textContent = '';
        el.hidden = true;
        return;
    }
    el.hidden = false;
    if (textEl) {
        textEl.textContent = formatTimeToBeat(seconds);
    }
}

function formatTimeToBeat(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(2).padStart(5, '0');
    return `${mins}:${secs}`;
}

function renderChallengeStatus(challenge) {
    const statusEl = document.getElementById('challenge-status');
    if (!statusEl || !challenge) return;

    const status = getDailyChallengeCardStatus(challenge);
    statusEl.textContent = status.label.toUpperCase();
    statusEl.className = `challenge-status challenge-status--${status.key}`;
}

function renderTrackPreview(canvas, trackKey, track, skin = 'default') {
    const presentation = resolveTrackPresentation(trackKey, {
        surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
        event: skin ? { key: 'daily-challenge', trackKey, skin } : null
    });

    // Set canvas dimensions dynamically based on its client display bounds (handling devicePixelRatio)
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
