import { TRACKS } from './game/track/tracks.js';
import { getTrackName } from './game/track/catalog.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from './game/track/presentation.js';
import { requestGameLaunchTarget } from './game/modes/launch-target.js';
import { exposeHeadToHeadLauncherTestHooks } from './game/debug/launcher-hooks.js';
import { applyAvatar, GENERIC_SNOO_URL, isRedditAvatarUrl } from './game/ui/avatar.js';
import { getMedalForRaceTime } from './game/medals/medal-timing.js';
import {
    applyHeadToHeadAccessState,
    HEAD_TO_HEAD_POST_TYPE,
    readHeadToHeadPosterPost,
    resolveHeadToHeadPosterAccess,
} from './game/head-to-head/poster-access.js';

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export const readHeadToHeadPostData = readHeadToHeadPosterPost;

export function normalizeHeadToHeadPostData(value) {
    const input = value && typeof value === 'object' ? value : {};
    const lapCount = input.lapCount === 2 || input.lapCount === 3 ? input.lapCount : 1;
    const targetTimeMs = Number(input.targetTimeMs);
    const origin = input.origin?.mode === 'daily'
        && typeof input.origin.challengeId === 'string'
        ? { mode: 'daily', challengeId: input.origin.challengeId }
        : input.origin?.mode === 'campaign'
            && input.origin.campaignId === 'numbered-v1'
            && typeof input.origin.raceId === 'string'
            ? {
                mode: 'campaign',
                campaignId: input.origin.campaignId,
                raceId: input.origin.raceId,
            }
            : input.campaignId === 'numbered-v1' && typeof input.raceId === 'string'
                ? {
                    mode: 'campaign',
                    campaignId: input.campaignId,
                    raceId: input.raceId,
                }
                : null;
    return {
        postType: HEAD_TO_HEAD_POST_TYPE,
        challengeId: cleanText(input.challengeId),
        campaignId: input.campaignId === 'numbered-v1' ? input.campaignId : '',
        raceId: cleanText(input.raceId),
        origin,
        challengerUsername: cleanText(input.challengerUsername) || 'A racer',
        challengerAvatarUrl: isRedditAvatarUrl(input.challengerAvatarUrl)
            ? input.challengerAvatarUrl
            : null,
        trackKey: TRACKS[cleanText(input.trackKey)] ? cleanText(input.trackKey) : '',
        lapCount,
        targetTimeMs: Number.isInteger(targetTimeMs) && targetTimeMs > 0 ? targetTimeMs : null,
        medal: cleanText(input.medal) || null,
    };
}

export function formatHeadToHeadPreviewTime(timeMs) {
    if (!Number.isInteger(timeMs) || timeMs <= 0) return '—';
    return `${Math.floor(timeMs / 1000)}.${String(timeMs % 1000).padStart(3, '0')}`;
}

function setAvatarImage(img, avatarUrl, label) {
    applyAvatar(img, avatarUrl, {
        alt: label ? `${label} avatar` : '',
        genericClass: 'challenge-avatar--generic',
    });
}

export function renderHeadToHeadAvatars(documentRef, {
    challengerUsername = 'A racer',
    challengerAvatarUrl = null,
    viewerUsername = 'You',
    viewerAvatarUrl = null,
} = {}) {
    if (!documentRef) return;
    const challengerName = cleanText(challengerUsername).replace(/^u\//i, '') || 'A racer';
    const viewerName = cleanText(viewerUsername).replace(/^u\//i, '') || 'You';
    const challengerLabel = documentRef.getElementById('challenger-name');
    const viewerLabel = documentRef.getElementById('viewer-name');
    if (challengerLabel) challengerLabel.textContent = challengerName;
    if (viewerLabel) viewerLabel.textContent = viewerName;
    setAvatarImage(
        documentRef.getElementById('challenger-avatar'),
        challengerAvatarUrl,
        challengerName,
    );
    setAvatarImage(
        documentRef.getElementById('viewer-avatar'),
        viewerAvatarUrl,
        viewerName,
    );
}

export function posterMedalForChallenge(value) {
    const challenge = value?.trackKey ? value : normalizeHeadToHeadPostData(value);
    if (!challenge.trackKey || !Number.isInteger(challenge.targetTimeMs)) return null;
    return getMedalForRaceTime(
        challenge.trackKey,
        challenge.targetTimeMs / 1000,
        challenge.lapCount,
    );
}

function applyPosterMedal(documentRef, medal) {
    const root = documentRef?.body || documentRef?.documentElement;
    if (!root) return;
    if (medal) root.setAttribute('data-medal', medal);
    else root.removeAttribute('data-medal');
}

export function renderHeadToHead(documentRef, rawValue) {
    const value = normalizeHeadToHeadPostData(rawValue);
    if (!documentRef) return value;
    applyPosterMedal(documentRef, posterMedalForChallenge(value));
    const trackName = documentRef.getElementById('challenge-track-name');
    const target = documentRef.getElementById('challenge-target-time');
    const format = documentRef.getElementById('challenge-format');
    renderHeadToHeadAvatars(documentRef, {
        challengerUsername: value.challengerUsername,
        challengerAvatarUrl: value.challengerAvatarUrl,
    });
    if (trackName) trackName.textContent = value.trackKey
        ? getTrackName(value.trackKey, value.trackKey)
        : value.origin?.mode === 'daily' ? 'Daily race' : 'Campaign race';
    if (target) target.textContent = formatHeadToHeadPreviewTime(value.targetTimeMs);
    if (format) {
        format.textContent = `${value.lapCount} ${value.lapCount === 1 ? 'LAP' : 'LAPS'}`;
    }
    renderChallengeTrack(documentRef, value.trackKey);
    return value;
}

export function readHeadToHeadViewerIdentity(root = globalThis) {
    const context = root?.devvit?.context;
    const username = cleanText(context?.username);
    return {
        username,
        avatarUrl: isRedditAvatarUrl(context?.snoovatar) ? context.snoovatar : null,
    };
}

function posterAvatars(challenge, viewer) {
    return {
        challengerUsername: challenge.challengerUsername,
        challengerAvatarUrl: challenge.challengerAvatarUrl,
        viewerUsername: viewer.username || 'You',
        viewerAvatarUrl: viewer.avatarUrl,
    };
}

function renderChallengeTrack(documentRef, trackKey) {
    const canvas = documentRef.getElementById('challenge-track');
    const track = TRACKS[trackKey];
    if (!canvas || !track) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (width < 2 || height < 2) return;
    canvas.width = width;
    canvas.height = height;
    renderTrackPreviewCanvas(canvas, {
        trackGeometry: { outer: track.outer, inner: track.inner },
        presentation: resolveTrackPresentation(trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
        }),
        startLine: track.startLine,
        startPos: track.startPos,
        startAngle: track.startAngle ?? 0,
        transparentBackground: true,
        previewRenderMode: 'schematic',
        showSchematicCarTrail: true,
        moveSchematicCarPastStartLine: true,
        hideSchematicStartArrow: true,
        runHistory: [],
    });
}

export async function openCampaignAsRedirect(event) {
    try {
        requestGameLaunchTarget('campaign');
        const { requestExpandedMode } = await import('@devvit/web/client');
        await requestExpandedMode(event, 'game');
    } catch (error) {
        console.error('Failed to open Mini Racer Campaign:', error);
    }
}

export async function openDailyAsRedirect(event) {
    try {
        requestGameLaunchTarget('daily');
        const { requestExpandedMode } = await import('@devvit/web/client');
        await requestExpandedMode(event, 'game');
    } catch (error) {
        console.error('Failed to open Mini Racer Daily:', error);
    }
}

let lastPosterAvatars = null;

export function bootHeadToHead(documentRef = document, root = globalThis) {
    const raw = readHeadToHeadPostData(root);
    const challenge = renderHeadToHead(documentRef, raw);
    const poster = resolveHeadToHeadPosterAccess(root);
    lastPosterAvatars = posterAvatars(challenge, readHeadToHeadViewerIdentity(root));
    renderHeadToHeadAvatars(documentRef, lastPosterAvatars);
    applyHeadToHeadAccessState(
        documentRef?.getElementById?.('accept-challenge'),
        documentRef?.getElementById?.('challenge-message'),
        poster,
    );
    exposeHeadToHeadLauncherTestHooks(challenge, poster);
}

if (typeof document !== 'undefined') {
    const start = () => bootHeadToHead();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
    globalThis.addEventListener('resize', () => {
        const challenge = renderHeadToHead(document, readHeadToHeadPostData());
        if (lastPosterAvatars) {
            renderHeadToHeadAvatars(document, {
                ...lastPosterAvatars,
                challengerUsername: lastPosterAvatars.challengerUsername
                    || challenge.challengerUsername,
                challengerAvatarUrl: lastPosterAvatars.challengerAvatarUrl
                    ?? challenge.challengerAvatarUrl,
            });
        }
    });
}

export { GENERIC_SNOO_URL };
export {
    OWN_CHALLENGE_MESSAGE,
    applyHeadToHeadAccessState,
    bindAcceptChallenge,
    openHeadToHead,
    openHomeAsRedirect,
    resolveHeadToHeadPosterAccess,
} from './game/head-to-head/poster-access.js';
