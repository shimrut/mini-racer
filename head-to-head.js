import { TRACKS } from './game/track/tracks.js';
import { getTrackName } from './game/track/catalog.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from './game/track/presentation.js';
import { requestGameLaunchTarget } from './game/modes/launch-target.js';
import {
    getGuestPlayerToken,
    getOrCreatePlayerId,
    setGuestPlayerToken,
} from './game/scoreboard/player-identity.js';
import { applyAvatar, GENERIC_SNOO_URL, isRedditAvatarUrl } from './game/ui/avatar.js';

const POST_TYPE = 'head-to-head';
const OWN_CHALLENGE_MESSAGE = "You can't accept your own Head to Head.";
export const HEAD_TO_HEAD_PREVIEW_REQUEST_TIMEOUT_MS = 20_000;

function createPreviewTimeoutError() {
    const error = new Error('Head to Head preview request timed out.');
    error.name = 'AbortError';
    return error;
}

async function fetchPreviewWithTimeout(root, url, options = {}) {
    const AbortControllerClass = root?.AbortController || globalThis.AbortController;
    const controller = typeof AbortControllerClass === 'function' && !options.signal
        ? new AbortControllerClass()
        : null;
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            controller?.abort();
            reject(createPreviewTimeoutError());
        }, HEAD_TO_HEAD_PREVIEW_REQUEST_TIMEOUT_MS);
    });
    const request = Promise.resolve().then(() => root.fetch(
        url,
        controller ? { ...options, signal: controller.signal } : options,
    ));
    try {
        return await Promise.race([request, timeout]);
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
    }
}

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function readChallengePostId(root = globalThis) {
    const postId = root?.devvit?.context?.postId;
    return typeof postId === 'string' && postId.startsWith('t3_')
        ? postId
        : '';
}

export function readHeadToHeadPostData(root = globalThis) {
    const value = root?.devvit?.context?.postData;
    return value && typeof value === 'object' && value.postType === POST_TYPE
        ? value
        : null;
}

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
        postType: POST_TYPE,
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

export function renderHeadToHead(documentRef, rawValue) {
    const value = normalizeHeadToHeadPostData(rawValue);
    if (!documentRef) return value;
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

export async function resolveHeadToHeadAccess(root = globalThis, challengeId = null) {
    if (typeof root?.fetch !== 'function') {
        return { signedIn: false, canRace: false, ownChallenge: false };
    }
    try {
        const url = new URL(
            '/api/head-to-head',
            root.location?.origin || 'http://localhost',
        );
        const requestedChallengeId = cleanText(challengeId);
        if (requestedChallengeId) {
            url.searchParams.set('challengeId', requestedChallengeId);
        }
        const postId = readChallengePostId(root);
        if (postId) url.searchParams.set('postId', postId);
        url.searchParams.set('playerId', getOrCreatePlayerId('challenge preview'));
        const guestToken = getGuestPlayerToken();
        if (guestToken) url.searchParams.set('guestToken', guestToken);
        const response = await fetchPreviewWithTimeout(root, url.toString());
        const body = await response?.json?.().catch?.(() => null) ?? null;
        if (body?.status === 'own_challenge') {
            return { signedIn: true, canRace: false, ownChallenge: true, body };
        }
        if (!response?.ok) return { signedIn: false, canRace: false, ownChallenge: false, body };
        return {
            signedIn: body?.viewerType === 'reddit',
            canRace: body?.status === 'ready',
            ownChallenge: false,
            body,
        };
    } catch {
        return { signedIn: false, canRace: false, ownChallenge: false };
    }
}

export async function ensureChallengePlayerIdentity(root = globalThis) {
    if (typeof root?.fetch !== 'function') return false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const url = new URL(
                '/api/player/bootstrap',
                root.location?.origin || 'http://localhost',
            );
            url.searchParams.set('playerId', getOrCreatePlayerId('challenge preview'));
            const guestToken = getGuestPlayerToken();
            if (guestToken) url.searchParams.set('guestToken', guestToken);
            const response = await fetchPreviewWithTimeout(root, url.toString(), { method: 'GET' });
            if (response?.status === 401 && attempt === 0) {
                // Drop the rejected token and re-present the id: the server re-authorizes a guest profile it already holds.
                setGuestPlayerToken(null);
                continue;
            }
            if (!response?.ok) return false;
            const body = await response.json?.().catch?.(() => null) ?? null;
            if (body && Object.prototype.hasOwnProperty.call(body, 'guestToken')) {
                setGuestPlayerToken(body.guestToken);
            }
            return Boolean(body?.playerId);
        } catch (error) {
            if (error?.status === 401 && attempt === 0) {
                setGuestPlayerToken(null);
                continue;
            }
            return false;
        }
    }

    return false;
}

export function showOwnChallengeMessage(documentRef, openLobby = openHomeAsRedirect) {
    const doc = documentRef || document;
    const existing = doc.getElementById('own-challenge-message');
    if (existing) existing.remove();

    const overlay = doc.createElement('div');
    overlay.id = 'own-challenge-message';
    overlay.className = 'expired-message';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const message = doc.createElement('p');
    message.className = 'expired-message__text';
    message.textContent = OWN_CHALLENGE_MESSAGE;

    const button = doc.createElement('button');
    button.className = 'expired-message__ok';
    button.type = 'button';
    button.textContent = 'OK';
    button.addEventListener('click', async (event) => {
        await openLobby(event);
    });

    overlay.append(message, button);
    doc.body.append(overlay);
    button.focus();
    return overlay;
}

export function bindAcceptChallenge(
    documentRef,
    openGame = openHeadToHead,
    { ownChallenge = false, openOwnChallenge = openHomeAsRedirect } = {},
) {
    const button = documentRef?.getElementById('accept-challenge');
    if (!button || button.dataset.bound === '1') return button || null;
    button.dataset.bound = '1';
    button.addEventListener('click', async (event) => {
        if (ownChallenge) {
            event.preventDefault?.();
            await openOwnChallenge(event);
            return;
        }
        await openGame(event);
    });
    return button;
}

export function applyHeadToHeadAccessState(button, message, access = {}) {
    if (!button) return;
    const canRace = access.canRace === true;
    const ownChallenge = access.ownChallenge === true;
    button.disabled = !canRace && !ownChallenge;
    button.textContent = ownChallenge
        ? 'Open Mini Racer'
        : canRace
            ? 'Accept Challenge'
            : 'Challenge Unavailable';
    if (message) {
        message.textContent = ownChallenge
            ? OWN_CHALLENGE_MESSAGE
            : canRace
                ? ''
                : access.body?.error || 'This Head to Head is unavailable right now.';
    }
}

export async function openHomeAsRedirect(event) {
    try {
        requestGameLaunchTarget('home');
        const { requestExpandedMode } = await import('@devvit/web/client');
        await requestExpandedMode(event, 'game');
    } catch (error) {
        console.error('Failed to open Mini Racer Lobby:', error);
    }
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

export async function openHeadToHead(event) {
    try {
        const { requestExpandedMode } = await import('@devvit/web/client');
        await requestExpandedMode(event, 'game');
    } catch (error) {
        console.error('Failed to open Mini Racer Head to Head:', error);
    }
}

let lastAccessAvatars = null;

function applyAccessAvatars(documentRef, challenge, access) {
    const body = access?.body && typeof access.body === 'object' ? access.body : {};
    const challengeBody = body.challenge && typeof body.challenge === 'object'
        ? body.challenge
        : {};
    lastAccessAvatars = {
        challengerUsername: challengeBody.challengerUsername || challenge.challengerUsername,
        challengerAvatarUrl: challengeBody.challengerAvatarUrl
            ?? challenge.challengerAvatarUrl
            ?? body.challengerAvatarUrl,
        viewerUsername: body.viewerUsername || 'You',
        viewerAvatarUrl: body.viewerAvatarUrl,
    };
    renderHeadToHeadAvatars(documentRef, lastAccessAvatars);
}

async function boot() {
    const challenge = renderHeadToHead(document, readHeadToHeadPostData());
    const message = document.getElementById('challenge-message');
    await ensureChallengePlayerIdentity(globalThis);
    const access = await resolveHeadToHeadAccess(globalThis, challenge.challengeId);
    applyAccessAvatars(document, challenge, access);
    const button = bindAcceptChallenge(document, openHeadToHead, {
        ownChallenge: access.ownChallenge === true,
        openOwnChallenge: openHomeAsRedirect,
    });
    applyHeadToHeadAccessState(button, message, access);
    globalThis.render_game_to_text = () => JSON.stringify({
        screen: 'head-to-head-preview',
        challengeId: challenge.challengeId,
        challengerUsername: challenge.challengerUsername,
        trackKey: challenge.trackKey,
        lapCount: challenge.lapCount,
        targetTimeMs: challenge.targetTimeMs,
        signedIn: access.signedIn,
        canRace: access.canRace,
        ownChallenge: access.ownChallenge === true,
    });
    globalThis.advanceTime = () => {};
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', boot);
    globalThis.addEventListener('resize', () => {
        const challenge = renderHeadToHead(document, readHeadToHeadPostData());
        if (lastAccessAvatars) {
            renderHeadToHeadAvatars(document, {
                ...lastAccessAvatars,
                challengerUsername: lastAccessAvatars.challengerUsername
                    || challenge.challengerUsername,
                challengerAvatarUrl: lastAccessAvatars.challengerAvatarUrl
                    ?? challenge.challengerAvatarUrl,
            });
        }
    });
}

export { GENERIC_SNOO_URL, OWN_CHALLENGE_MESSAGE };
