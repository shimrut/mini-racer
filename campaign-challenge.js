import { TRACKS } from './game/track/tracks.js';
import { getTrackName } from './game/track/catalog.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from './game/track/presentation.js';
import { requestGameLaunchTarget } from './game/modes/launch-target.js';

const POST_TYPE = 'campaign-challenge';
const GENERIC_SNOO_URL = 'https://www.redditstatic.com/avatars/defaults/v2/avatar_default_0.png';
const OWN_CHALLENGE_MESSAGE = "You can't accept your own Head to Head. Opening your Campaign.";

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function isRedditAvatarUrl(value) {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        return url.protocol === 'https:' && (
            hostname === 'redd.it'
            || hostname.endsWith('.redd.it')
            || hostname === 'redditmedia.com'
            || hostname.endsWith('.redditmedia.com')
            || hostname === 'redditstatic.com'
            || hostname.endsWith('.redditstatic.com')
        );
    } catch {
        return false;
    }
}

export function resolveDisplayAvatarUrl(value) {
    return isRedditAvatarUrl(value) ? value : GENERIC_SNOO_URL;
}

export function readCampaignChallengePostData(root = globalThis) {
    const value = root?.devvit?.context?.postData;
    return value && typeof value === 'object' && value.postType === POST_TYPE
        ? value
        : null;
}

export function normalizeCampaignChallengePostData(value) {
    const input = value && typeof value === 'object' ? value : {};
    const lapCount = input.lapCount === 2 || input.lapCount === 3 ? input.lapCount : 1;
    const targetTimeMs = Number(input.targetTimeMs);
    return {
        postType: POST_TYPE,
        challengeId: cleanText(input.challengeId),
        campaignId: input.campaignId === 'numbered-v1' ? input.campaignId : '',
        raceId: cleanText(input.raceId),
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

export function formatCampaignChallengePreviewTime(timeMs) {
    if (!Number.isInteger(timeMs) || timeMs <= 0) return '—';
    return `${Math.floor(timeMs / 1000)}.${String(timeMs % 1000).padStart(3, '0')}`;
}

function setAvatarImage(img, avatarUrl, label) {
    if (!img) return;
    const resolved = resolveDisplayAvatarUrl(avatarUrl);
    img.src = resolved;
    img.alt = label ? `${label} avatar` : '';
    img.classList.toggle('challenge-avatar--generic', resolved === GENERIC_SNOO_URL);
}

export function renderCampaignChallengeAvatars(documentRef, {
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

export function renderCampaignChallenge(documentRef, rawValue) {
    const value = normalizeCampaignChallengePostData(rawValue);
    if (!documentRef) return value;
    const trackName = documentRef.getElementById('challenge-track-name');
    const target = documentRef.getElementById('challenge-target-time');
    const format = documentRef.getElementById('challenge-format');
    renderCampaignChallengeAvatars(documentRef, {
        challengerUsername: value.challengerUsername,
        challengerAvatarUrl: value.challengerAvatarUrl,
    });
    if (trackName) trackName.textContent = value.trackKey
        ? getTrackName(value.trackKey, value.trackKey)
        : 'Campaign race';
    if (target) target.textContent = formatCampaignChallengePreviewTime(value.targetTimeMs);
    if (format) {
        format.textContent = `${value.lapCount} ${value.lapCount === 1 ? 'LAP' : 'LAPS'} · VERIFIED GHOST`;
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
    canvas.width = Math.max(320, Math.round(rect.width * dpr));
    canvas.height = Math.max(240, Math.round(rect.height * dpr));
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

export async function resolveCampaignChallengeAccess(root = globalThis) {
    if (typeof root?.fetch !== 'function') return { signedIn: false, ownChallenge: false };
    try {
        const response = await root.fetch('/api/campaign/challenge');
        const body = await response?.json?.().catch?.(() => null) ?? null;
        if (body?.status === 'own_challenge') {
            return { signedIn: true, ownChallenge: true, body };
        }
        if (!response?.ok) return { signedIn: false, ownChallenge: false, body };
        return { signedIn: body?.status === 'ready', ownChallenge: false, body };
    } catch {
        return { signedIn: false, ownChallenge: false };
    }
}

export function showOwnChallengeMessage(documentRef, openCampaign = openCampaignAsRedirect) {
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
        await openCampaign(event);
    });

    overlay.append(message, button);
    doc.body.append(overlay);
    button.focus();
    return overlay;
}

export function bindAcceptChallenge(
    documentRef,
    openGame = openCampaignChallenge,
    { ownChallenge = false } = {},
) {
    const button = documentRef?.getElementById('accept-challenge');
    if (!button || button.dataset.bound === '1') return button || null;
    button.dataset.bound = '1';
    button.addEventListener('click', async (event) => {
        if (ownChallenge) {
            event.preventDefault?.();
            showOwnChallengeMessage(documentRef);
            return;
        }
        await openGame(event);
    });
    return button;
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

export async function openCampaignChallenge(event) {
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
    renderCampaignChallengeAvatars(documentRef, lastAccessAvatars);
}

async function boot() {
    const challenge = renderCampaignChallenge(document, readCampaignChallengePostData());
    const message = document.getElementById('challenge-message');
    const access = await resolveCampaignChallengeAccess(globalThis);
    applyAccessAvatars(document, challenge, access);
    const button = bindAcceptChallenge(document, openCampaignChallenge, {
        ownChallenge: access.ownChallenge === true,
    });
    if (!access.signedIn && button) {
        button.disabled = true;
        button.textContent = 'Sign in to Race';
        if (message) message.textContent = 'Reddit sign-in is required to race a Head to Head.';
    }
    globalThis.render_game_to_text = () => JSON.stringify({
        screen: 'campaign-challenge-preview',
        challengeId: challenge.challengeId,
        challengerUsername: challenge.challengerUsername,
        trackKey: challenge.trackKey,
        lapCount: challenge.lapCount,
        targetTimeMs: challenge.targetTimeMs,
        signedIn: access.signedIn,
        ownChallenge: access.ownChallenge === true,
    });
    globalThis.advanceTime = () => {};
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', boot);
    globalThis.addEventListener('resize', () => {
        const challenge = renderCampaignChallenge(document, readCampaignChallengePostData());
        if (lastAccessAvatars) {
            renderCampaignChallengeAvatars(document, {
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
