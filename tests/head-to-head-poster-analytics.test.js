import { describe, expect, it, vi } from 'vitest';
import {
    reportChallengePosterEvent,
    startChallengePosterViews,
} from '../game/head-to-head/poster-analytics.js';
import { bindAcceptChallenge } from '../game/head-to-head/poster-access.js';

function fixture({ hidden = false, observer = true } = {}) {
    const listeners = new Map();
    const target = {};
    const document = {
        hidden,
        querySelector: () => target,
        addEventListener: (event, callback) => listeners.set(event, callback),
        removeEventListener: (event) => listeners.delete(event),
    };
    let intersection;
    let observerOptions;
    const disconnect = vi.fn();
    const root = {
        document,
        fetch: vi.fn(async () => ({ ok: true })),
        devvit: { context: {
            postId: 't3_post1',
            postData: { postType: 'head-to-head', challengeId: 'challenge-1' },
        } },
        addEventListener: (event, callback) => listeners.set(event, callback),
        removeEventListener: (event) => listeners.delete(event),
        ...(observer ? { IntersectionObserver: class {
            constructor(callback, options) { intersection = callback; observerOptions = options; }
            observe() {}
            disconnect = disconnect;
        } } : {}),
    };
    return {
        root, document, disconnect,
        options: () => observerOptions,
        edge: () => intersection([{ target, isIntersecting: true, intersectionRatio: 0 }]),
        batch: (states) => intersection(states.map((visible) => ({
            target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
        }))),
        emit: (event) => listeners.get(event)?.(),
        visible: (visible) => intersection([{
            target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
        }]),
    };
}

describe('challenge poster view reporting', () => {
    it('processes queued visibility changes in order rather than leaving a stale state', () => {
        const f = fixture();
        const report = vi.fn();
        const dispose = startChallengePosterViews(f.document, f.root, report);
        f.batch([true, false]);
        f.visible(true);
        expect(report).toHaveBeenCalledTimes(2);
        f.batch([false, true, false]);
        f.visible(true);
        expect(report).toHaveBeenCalledTimes(4);
        dispose();
    });

    it('requests a positive visibility threshold so an edge-adjacent poster can subsequently enter', () => {
        const f = fixture();
        const report = vi.fn();
        const dispose = startChallengePosterViews(f.document, f.root, report);
        expect(f.options().threshold).toBeGreaterThan(0);
        f.edge();
        expect(report).not.toHaveBeenCalled();
        f.visible(true);
        expect(report).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('counts visibility episodes, including repeat visits, without counting redraw notifications', () => {
        const f = fixture();
        const report = vi.fn();
        const dispose = startChallengePosterViews(f.document, f.root, report);
        expect(report).not.toHaveBeenCalled();
        f.visible(false);
        f.visible(true);
        f.visible(true);
        f.emit('visibilitychange');
        expect(report).toHaveBeenCalledTimes(1);
        f.visible(false);
        f.visible(true);
        expect(report.mock.calls).toEqual([['view'], ['view']]);
        dispose();
        f.visible(false);
        f.visible(true);
        expect(report).toHaveBeenCalledTimes(2);
        expect(f.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not count background loads, but counts becoming visible and returning from background', () => {
        const f = fixture({ hidden: true });
        const report = vi.fn();
        const dispose = startChallengePosterViews(f.document, f.root, report);
        f.visible(true);
        expect(report).not.toHaveBeenCalled();
        f.document.hidden = false;
        f.emit('visibilitychange');
        f.document.hidden = true;
        f.emit('visibilitychange');
        f.document.hidden = false;
        f.emit('visibilitychange');
        expect(report).toHaveBeenCalledTimes(2);
        dispose();
    });

    it('counts a restored page and a fresh reload as new views of the same post', () => {
        const f = fixture();
        const report = vi.fn();
        const dispose = startChallengePosterViews(f.document, f.root, report);
        f.visible(true);
        f.emit('pagehide');
        f.emit('pageshow');
        expect(report).toHaveBeenCalledTimes(2);
        dispose();
        const reload = fixture();
        const stopReload = startChallengePosterViews(reload.document, reload.root, report);
        reload.visible(true);
        expect(report).toHaveBeenCalledTimes(3);
        stopReload();
    });

    it('installs once per document and includes logged-out and author views', () => {
        const f = fixture();
        f.root.devvit.context.userId = 't2_author';
        f.root.devvit.context.postData.challengerUserId = 't2_author';
        const report = vi.fn();
        const dispose = startChallengePosterViews(f.document, f.root, report);
        expect(startChallengePosterViews(f.document, f.root, report)).toBe(dispose);
        f.visible(true);
        delete f.root.devvit.context.userId;
        f.visible(false);
        f.visible(true);
        expect(report).toHaveBeenCalledTimes(2);
        dispose();
    });

    it('falls back to visible-document loads when IntersectionObserver is unavailable', () => {
        const f = fixture({ observer: false, hidden: true });
        const report = vi.fn();
        const dispose = startChallengePosterViews(f.document, f.root, report);
        expect(report).not.toHaveBeenCalled();
        f.document.hidden = false;
        f.emit('visibilitychange');
        expect(report).toHaveBeenCalledWith('view');
        dispose();
    });

    it('contains visibility observer and reporter failures', () => {
        const f = fixture();
        f.root.IntersectionObserver = class { constructor() { throw new Error('unsupported'); } };
        const report = vi.fn(() => { throw new Error('offline'); });
        let dispose;
        expect(() => { dispose = startChallengePosterViews(f.document, f.root, report); }).not.toThrow();
        expect(report).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('posts only the action with keepalive and does not create player/session state', async () => {
        const f = fixture();
        reportChallengePosterEvent('view', f.root);
        reportChallengePosterEvent('click', f.root);
        reportChallengePosterEvent('own_open', f.root);
        expect(f.root.fetch.mock.calls.map(([url, options]) => [url, JSON.parse(options.body)]))
            .toEqual([
                ['/api/analytics/challenge', { action: 'view' }],
                ['/api/analytics/challenge', { action: 'click' }],
                ['/api/analytics/challenge', { action: 'own_open' }],
            ]);
        expect(f.root.fetch.mock.calls[0][1].keepalive).toBe(true);
        f.root.fetch.mockRejectedValue(new Error('offline'));
        expect(() => reportChallengePosterEvent('view', f.root)).not.toThrow();
        await Promise.resolve();
        f.root.fetch.mockImplementation(() => { throw new Error('unsupported'); });
        expect(() => reportChallengePosterEvent('view', f.root)).not.toThrow();
    });

    it('ignores non-challenge/local pages and unsupported actions', () => {
        const f = fixture();
        reportChallengePosterEvent('finish', f.root);
        f.root.devvit.context.postData.postType = 'daily';
        reportChallengePosterEvent('view', f.root);
        expect(f.root.fetch).not.toHaveBeenCalled();
        expect(() => startChallengePosterViews(f.document, {})).not.toThrow();
    });
});

describe('Accept Challenge click reporting', () => {
    function buttonFixture() {
        const button = { dataset: {}, disabled: false, addEventListener: (_, handler) => { button.click = handler; } };
        return { button, document: { getElementById: () => button } };
    }

    it('counts every Accept tap and expands without awaiting analytics', async () => {
        const f = buttonFixture();
        const openGame = vi.fn(async () => {});
        const reportClick = vi.fn(() => new Promise(() => {}));
        bindAcceptChallenge(f.document, openGame, { reportClick });
        await f.button.click({});
        await f.button.click({});
        expect(reportClick).toHaveBeenCalledTimes(2);
        expect(reportClick.mock.calls).toEqual([['click'], ['click']]);
        expect(openGame).toHaveBeenCalledTimes(2);
    });

    it('counts every author Open Mini Racer tap without waiting, but ignores disabled actions', async () => {
        const author = buttonFixture();
        const reportClick = vi.fn(() => new Promise(() => {}));
        const openOwnChallenge = vi.fn(async () => {});
        const openGame = vi.fn();
        bindAcceptChallenge(author.document, openGame, { ownChallenge: true, openOwnChallenge, reportClick });
        await author.button.click({});
        await author.button.click({});
        const unavailable = buttonFixture();
        unavailable.button.disabled = true;
        bindAcceptChallenge(unavailable.document, openGame, { reportClick });
        await unavailable.button.click({});
        expect(reportClick.mock.calls).toEqual([['own_open'], ['own_open']]);
        expect(openGame).not.toHaveBeenCalled();
        expect(openOwnChallenge).toHaveBeenCalledTimes(2);
        author.button.disabled = true;
        await author.button.click({});
        expect(reportClick).toHaveBeenCalledTimes(2);
    });

    it('expands even if the reporting hook throws', async () => {
        const f = buttonFixture();
        const openGame = vi.fn(async () => {});
        bindAcceptChallenge(f.document, openGame, { reportClick: () => { throw new Error('offline'); } });
        await expect(f.button.click({})).resolves.toBeUndefined();
        expect(openGame).toHaveBeenCalledTimes(1);
    });
});
