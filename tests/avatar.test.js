import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
    applyAvatar,
    AVATAR_PLACEHOLDER_SRC,
    createAvatarImage,
    GENERIC_SNOO_URL,
    isRedditAvatarUrl,
    resolveAvatarUrl,
} from '../game/ui/avatar.js';

function imageIn(dom) {
    return dom.window.document.createElement('img');
}

describe('avatar seating', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });

    it('admits only Reddit-hosted https, matching the server allowlist', () => {
        expect(isRedditAvatarUrl('https://i.redd.it/a.png')).toBe(true);
        expect(isRedditAvatarUrl('https://styles.redditmedia.com/a.png')).toBe(true);
        expect(isRedditAvatarUrl('https://www.redditstatic.com/a.png')).toBe(true);

        expect(isRedditAvatarUrl('http://i.redd.it/a.png')).toBe(false);
        expect(isRedditAvatarUrl('https://example.com/leak.png')).toBe(false);
        expect(isRedditAvatarUrl('https://reddit.com/a.png')).toBe(false);
        expect(isRedditAvatarUrl('https://evil-redd.it.example.com/a.png')).toBe(false);
        expect(isRedditAvatarUrl('javascript:alert(1)')).toBe(false);
        expect(isRedditAvatarUrl(null)).toBe(false);
    });

    it('resolves anything it will not admit to the default Snoo', () => {
        expect(resolveAvatarUrl('https://i.redd.it/a.png')).toBe('https://i.redd.it/a.png');
        expect(resolveAvatarUrl('https://example.com/leak.png')).toBe(GENERIC_SNOO_URL);
        expect(resolveAvatarUrl(null)).toBe(GENERIC_SNOO_URL);
    });

    it('seats a racer with no avatar behind the default Snoo and plates it', () => {
        const img = imageIn(dom);
        const generic = applyAvatar(img, null, {
            alt: 'Your avatar',
            genericClass: 'challenge-avatar--generic',
        });

        expect(generic).toBe(true);
        expect(img.src).toBe(GENERIC_SNOO_URL);
        expect(img.classList.contains('challenge-avatar--generic')).toBe(true);
        expect(img.alt).toBe('Your avatar');
        expect(img.getAttribute('aria-hidden')).toBe('false');
    });

    it('leaves a racer with their own avatar unplated', () => {
        const img = imageIn(dom);
        const generic = applyAvatar(img, 'https://i.redd.it/racer.png', {
            alt: 'u/racer avatar',
            genericClass: 'challenge-avatar--generic',
        });

        expect(generic).toBe(false);
        expect(img.src).toBe('https://i.redd.it/racer.png');
        expect(img.classList.contains('challenge-avatar--generic')).toBe(false);
    });

    it('falls from a broken avatar to the Snoo, then to the local silhouette', () => {
        const img = imageIn(dom);
        applyAvatar(img, 'https://i.redd.it/gone.png', {
            genericClass: 'podium-row__avatar--generic',
        });
        expect(img.src).toBe('https://i.redd.it/gone.png');

        img.onerror();
        expect(img.src).toBe(GENERIC_SNOO_URL);
        expect(img.classList.contains('podium-row__avatar--generic')).toBe(true);

        img.onerror();
        expect(img.src).toBe(AVATAR_PLACEHOLDER_SRC);
        expect(img.classList.contains('podium-row__avatar--generic')).toBe(false);
        expect(img.onerror).toBe(null);
    });

    it('drops a faceless racer straight to the silhouette when the Snoo is unreachable', () => {
        const img = imageIn(dom);
        applyAvatar(img, null);
        expect(img.src).toBe(GENERIC_SNOO_URL);

        img.onerror();
        expect(img.src).toBe(AVATAR_PLACEHOLDER_SRC);
        expect(img.onerror).toBe(null);
    });

    it('hides a purely decorative seat from the accessibility tree', () => {
        const img = createAvatarImage(dom.window.document, null, {
            className: 'challenge-avatar challenge-avatar--hero',
            hidden: true,
        });

        expect(img.className).toBe('challenge-avatar challenge-avatar--hero');
        expect(img.getAttribute('aria-hidden')).toBe('true');
        expect(img.alt).toBe('');
    });
});
