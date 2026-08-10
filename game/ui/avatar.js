export const GENERIC_SNOO_URL = 'https://www.redditstatic.com/avatars/defaults/v2/avatar_default_0.png';

const SILHOUETTE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<circle cx="32" cy="24" r="11" fill="%23475569"/>`
    + `<path d="M12 58c0-11 9-19 20-19s20 8 20 19z" fill="%23475569"/>`
    + `</svg>`;

export const AVATAR_PLACEHOLDER_SRC = `data:image/svg+xml,${SILHOUETTE}`;

// The same three media hosts the server admits in `src/server/daily-podium-service.ts` — not reddit.com.
const REDDIT_AVATAR_HOSTS = [
    'redd.it',
    'redditmedia.com',
    'redditstatic.com',
];

export function isRedditAvatarUrl(value) {
    if (typeof value !== 'string') return false;
    try {
        const { protocol, hostname } = new URL(value);
        if (protocol !== 'https:') return false;
        return REDDIT_AVATAR_HOSTS.some(
            (host) => hostname === host || hostname.endsWith(`.${host}`),
        );
    } catch {
        return false;
    }
}

export function resolveAvatarUrl(value) {
    return isRedditAvatarUrl(value) ? value : GENERIC_SNOO_URL;
}

export function applyAvatar(img, url, { alt = '', genericClass = '', hidden = false } = {}) {
    if (!img) return false;
    const own = isRedditAvatarUrl(url) ? url : null;
    const ladder = own
        ? [own, GENERIC_SNOO_URL, AVATAR_PLACEHOLDER_SRC]
        : [GENERIC_SNOO_URL, AVATAR_PLACEHOLDER_SRC];
    let step = 0;

    const seat = () => {
        const src = ladder[step];
        if (genericClass) img.classList?.toggle?.(genericClass, src === GENERIC_SNOO_URL);
        img.src = src;
    };

    img.onerror = () => {
        step += 1;
        // The last rung is a data URI and always paints, so nothing can loop here.
        if (step >= ladder.length - 1) img.onerror = null;
        if (step < ladder.length) seat();
    };

    seat();
    img.alt = alt;
    img.setAttribute?.('aria-hidden', hidden || !alt ? 'true' : 'false');
    return !own;
}

export function createAvatarImage(documentRef, url, { className = '', ...options } = {}) {
    const img = documentRef.createElement('img');
    if (className) img.className = className;
    applyAvatar(img, url, options);
    return img;
}
