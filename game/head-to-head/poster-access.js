import { requestGameLaunchTarget } from '../modes/launch-target.js';

export const HEAD_TO_HEAD_POST_TYPE = 'head-to-head';
export const OWN_CHALLENGE_MESSAGE = "You can't accept your own Head to Head.";
export const CHALLENGE_UNAVAILABLE_MESSAGE = 'This Head to Head is unavailable right now.';

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function accountId(value) {
    const id = cleanText(value);
    return id.startsWith('t2_') ? id : '';
}

export function readHeadToHeadPosterPost(root = globalThis) {
    const value = root?.devvit?.context?.postData;
    return value && typeof value === 'object' && value.postType === HEAD_TO_HEAD_POST_TYPE
        ? value
        : null;
}

export function resolveHeadToHeadPosterAccess(root = globalThis) {
    const post = readHeadToHeadPosterPost(root);
    const challengeId = cleanText(post?.challengeId);
    const playable = Boolean(challengeId);
    const viewerId = accountId(root?.devvit?.context?.userId);
    const storedId = accountId(post?.challengerUserId);
    const postAuthorId = accountId(root?.devvit?.context?.postAuthorId);
    const ownChallenge = playable
        && Boolean(viewerId)
        && (storedId ? viewerId === storedId : Boolean(postAuthorId) && viewerId === postAuthorId);
    return {
        signedIn: Boolean(viewerId),
        canRace: playable && !ownChallenge,
        ownChallenge,
        challengeId,
    };
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
                : CHALLENGE_UNAVAILABLE_MESSAGE;
    }
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

export async function openHomeAsRedirect(event) {
    try {
        requestGameLaunchTarget('home');
        const { requestExpandedMode } = await import('@devvit/web/client');
        await requestExpandedMode(event, 'game');
    } catch (error) {
        console.error('Failed to open Mini Racer Lobby:', error);
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

export function bootHeadToHeadAccept(root = globalThis, documentRef = root.document) {
    const access = resolveHeadToHeadPosterAccess(root);
    const button = bindAcceptChallenge(documentRef, openHeadToHead, {
        ownChallenge: access.ownChallenge === true,
        openOwnChallenge: openHomeAsRedirect,
    });
    applyHeadToHeadAccessState(
        button,
        documentRef?.getElementById?.('challenge-message'),
        access,
    );
    return { access, button };
}
