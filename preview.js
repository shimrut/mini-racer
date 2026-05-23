import { requestExpandedMode } from '@devvit/web/client';
import { TRACKS } from './game/track/tracks.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from './game/track/presentation.js';
import { getDailyChallengeSnapshot } from './game/daily-challenge/service.js';
import { getBestTimeOneRankAbove } from './game/daily-challenge/snapshot-next-target.js';
import { getDailyChallengeData } from './game/daily-challenge/storage.js';
import {
    getMedalForLapTime,
    getNextMedalTarget,
    getTimeToBeatSeconds,
} from './game/medals/medals.js';

document.addEventListener('DOMContentLoaded', async () => {
    const playButton = document.getElementById('play-button');
    const trackNameEl = document.getElementById('track-name');
    const timeRemainingEl = document.getElementById('time-remaining');
    const canvas = document.getElementById('track-preview');

    if (!playButton || !trackNameEl || !timeRemainingEl || !canvas) {
        return;
    }

    playButton.addEventListener('click', async (event) => {
        try {
            await requestExpandedMode(event, 'game');
        } catch (error) {
            console.error('Failed to open Mini Racer in expanded mode:', error);
        }
    });

    const timerLabelEl = document.querySelector('.start-daily-card__eyebrow-timer .timer-label');
    const timeToBeatEl = document.getElementById('time-to-beat');
    const fallbackTrack = TRACKS.circuit;

    try {
        const challengeRes = await fetch('/api/daily/active', { method: 'GET' });
        if (!challengeRes.ok) throw new Error('Failed to fetch challenge');
        const challenge = await challengeRes.json();

        const trackKey = TRACKS[challenge.trackKey] ? challenge.trackKey : 'circuit';
        const track = TRACKS[trackKey] || fallbackTrack;
        trackNameEl.textContent = track.name;
        renderTrackPreview(canvas, trackKey, track);
        await applyTimeToBeat(timeToBeatEl, trackKey, challenge.id);

        if (timerLabelEl) timerLabelEl.textContent = 'ENDS IN';
        startCountdown(challenge.endsAt, timeRemainingEl);

    } catch (error) {
        console.error('Error loading daily challenge preview:', error);
        trackNameEl.textContent = 'Challenge active';
        if (timerLabelEl) timerLabelEl.textContent = '';
        timeRemainingEl.textContent = 'Live now';
        if (fallbackTrack) {
            renderTrackPreview(canvas, 'circuit', fallbackTrack);
        }
        await applyTimeToBeat(timeToBeatEl, 'circuit', null);
    }
});

async function applyTimeToBeat(el, trackKey, challengeId) {
    if (!el) return;
    const textEl = el.querySelector('#time-to-beat-text');
    const stored = challengeId ? getDailyChallengeData(challengeId) : null;
    const bestTime = stored?.bestTime;
    const bestMedal = Number.isFinite(bestTime)
        ? getMedalForLapTime(trackKey, bestTime)
        : null;
    let seconds = getTimeToBeatSeconds(trackKey, bestMedal);

    if (bestMedal === 'gold' && challengeId && !getNextMedalTarget(trackKey, 'gold')) {
        try {
            const snapshot = await getDailyChallengeSnapshot({ challengeId });
            const above = getBestTimeOneRankAbove(snapshot);
            if (Number.isFinite(above)) {
                seconds = above;
            }
        } catch (error) {
            console.error('Error loading leaderboard for time to beat:', error);
        }
    }

    if (!Number.isFinite(seconds)) {
        if (textEl) textEl.textContent = '';
        el.hidden = true;
        return;
    }
    el.hidden = false;
    if (textEl) {
        textEl.textContent = `Time to beat: ${Number(seconds).toFixed(2)}s`;
    }
}

function renderTrackPreview(canvas, trackKey, track) {
    const presentation = resolveTrackPresentation(trackKey, {
        surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
        event: null
    });
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

function startCountdown(endsAtIso, element) {
    const endsAt = new Date(endsAtIso).getTime();

    const update = () => {
        const now = Date.now();
        const diff = endsAt - now;

        if (diff <= 0) {
            element.textContent = '00:00:00';
            return;
        }

        const h = Math.floor(diff / (1000 * 60 * 60));
        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const s = Math.floor((diff % (1000 * 60)) / 1000);

        element.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        requestAnimationFrame(update);
    };

    update();
}
