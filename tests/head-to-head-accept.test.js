import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHALLENGE_UNAVAILABLE_MESSAGE, OWN_CHALLENGE_MESSAGE } from '../game/head-to-head/poster-access.js';
import { LAUNCH_TARGET_KEY } from '../game/modes/launch-target.js';

vi.mock('@devvit/web/client', () => ({
    requestExpandedMode: vi.fn(async () => undefined),
}));

const PLAYABLE_POST = {
    postType: 'head-to-head',
    challengeId: 'challenge-1',
    challengerUsername: 'RaceFan',
    challengerUserId: 't2_racefan',
};

function stubStorage() {
    const values = new Map();
    const previous = globalThis.localStorage;
    globalThis.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
    };
    return {
        values,
        restore() {
            if (previous === undefined) delete globalThis.localStorage;
            else globalThis.localStorage = previous;
        },
    };
}

function posterDocument() {
    const button = {
        dataset: {},
        disabled: false,
        textContent: 'Accept Challenge',
        addEventListener: vi.fn((type, handler) => {
            button._handler = handler;
        }),
    };
    const message = { textContent: '' };
    return {
        button,
        message,
        getElementById: vi.fn((id) => {
            if (id === 'accept-challenge') return button;
            if (id === 'challenge-message') return message;
            return null;
        }),
    };
}

describe('head-to-head early accept entry', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('paints own-post, unavailable, and ready states', async () => {
        const { bootHeadToHeadAccept } = await import('../game/head-to-head/poster-access.js');
        const own = posterDocument();
        bootHeadToHeadAccept({
            devvit: {
                context: {
                    postData: PLAYABLE_POST,
                    userId: 't2_racefan',
                },
            },
            document: own,
        }, own);
        expect(own.button).toMatchObject({ disabled: false, textContent: 'Open Mini Racer' });
        expect(own.message.textContent).toBe(OWN_CHALLENGE_MESSAGE);

        const missing = posterDocument();
        bootHeadToHeadAccept({
            devvit: { context: { postData: { postType: 'head-to-head' } } },
            document: missing,
        }, missing);
        expect(missing.button).toMatchObject({
            disabled: true,
            textContent: 'Challenge Unavailable',
        });
        expect(missing.message.textContent).toBe(CHALLENGE_UNAVAILABLE_MESSAGE);

        const ready = posterDocument();
        bootHeadToHeadAccept({
            devvit: { context: { postData: PLAYABLE_POST, userId: 't2_other' } },
            document: ready,
        }, ready);
        expect(ready.button).toMatchObject({ disabled: false, textContent: 'Accept Challenge' });
        expect(ready.message.textContent).toBe('');
    });

    it('binds once and writes the lobby launch target before opening an own post', async () => {
        const { requestExpandedMode } = await import('@devvit/web/client');
        const { bootHeadToHeadAccept } = await import('../game/head-to-head/poster-access.js');
        const storage = stubStorage();
        const documentRef = posterDocument();
        const root = {
            devvit: {
                context: {
                    postData: PLAYABLE_POST,
                    userId: 't2_racefan',
                },
            },
            document: documentRef,
            localStorage: globalThis.localStorage,
        };
        try {
            bootHeadToHeadAccept(root, documentRef);
            bootHeadToHeadAccept(root, documentRef);
            expect(documentRef.button.addEventListener).toHaveBeenCalledTimes(1);
            await documentRef.button._handler({ type: 'click', preventDefault: vi.fn() });
            expect(JSON.parse(storage.values.get(LAUNCH_TARGET_KEY)).mode).toBe('home');
            expect(requestExpandedMode).toHaveBeenCalledTimes(1);
        } finally {
            storage.restore();
        }
    });

    it('opens the game directly when the post is not the author\'s', async () => {
        const { requestExpandedMode } = await import('@devvit/web/client');
        const { bootHeadToHeadAccept } = await import('../game/head-to-head/poster-access.js');
        const storage = stubStorage();
        const documentRef = posterDocument();
        const root = {
            devvit: {
                context: {
                    postData: PLAYABLE_POST,
                    userId: 't2_other',
                },
            },
            document: documentRef,
            localStorage: globalThis.localStorage,
        };
        try {
            bootHeadToHeadAccept(root, documentRef);
            await documentRef.button._handler({ type: 'click' });
            expect(storage.values.has(LAUNCH_TARGET_KEY)).toBe(false);
            expect(requestExpandedMode).toHaveBeenCalledTimes(1);
        } finally {
            storage.restore();
        }
    });

    it('does not attach a second click when the late card boots', async () => {
        const { bootHeadToHeadAccept } = await import('../game/head-to-head/poster-access.js');
        const { bootHeadToHead } = await import('../head-to-head.js');
        const documentRef = posterDocument();
        documentRef.body = { attributes: {}, setAttribute() {}, removeAttribute() {} };
        const root = {
            devvit: { context: { postData: PLAYABLE_POST, userId: 't2_other' } },
            document: documentRef,
        };
        bootHeadToHeadAccept(root, documentRef);
        bootHeadToHead(documentRef, root);
        expect(documentRef.button.addEventListener).toHaveBeenCalledTimes(1);
    });
});
