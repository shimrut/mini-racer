/**
 * Every racer's face, seated by one function.
 *
 * Four surfaces show a racer — the lobby's duel seats, the finish hero, the
 * Head to Head poster and the podium — and each used to build its own <img>.
 * The fallback then went missing on one surface at a time: a hard `if (avatarUrl)`
 * dropped the finish hero's portrait entirely, and the lobby drew a grey
 * silhouette where the poster drew a Snoo. Seating is decided here now, so a
 * racer without a Snoovatar cannot look different depending on where you meet them.
 *
 * The ladder, in order:
 *   1. the racer's own avatar, when Reddit gave us one;
 *   2. Reddit's official default Snoo, for the signed-out stranger and for the
 *      many signed-in racers who never set a Snoovatar;
 *   3. the local silhouette, only if that remote Snoo fails to load — a broken
 *      image box on the frame that has to sell the race is worse than a flat head.
 */
export const GENERIC_SNOO_URL = 'https://www.redditstatic.com/avatars/defaults/v2/avatar_default_0.png';

const SILHOUETTE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<circle cx="32" cy="24" r="11" fill="%23475569"/>`
    + `<path d="M12 58c0-11 9-19 20-19s20 8 20 19z" fill="%23475569"/>`
    + `</svg>`;

export const AVATAR_PLACEHOLDER_SRC = `data:image/svg+xml,${SILHOUETTE}`;

// Deliberately the same three hosts the server admits in
// `src/server/daily-podium-service.ts` — media hosts only, not reddit.com.
const REDDIT_AVATAR_HOSTS = [
    'redd.it',
    'redditmedia.com',
    'redditstatic.com',
];

/**
 * Reddit-hosted https only. A racer's avatar URL reaches us from post data and
 * from the API, so it is never trusted enough to put straight into a `src`.
 */
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

/** The URL a racer is actually shown at: their own, or the default Snoo. */
export function resolveAvatarUrl(value) {
    return isRedditAvatarUrl(value) ? value : GENERIC_SNOO_URL;
}

/**
 * Seat a racer in an existing <img>.
 *
 * @param {HTMLImageElement|null|undefined} img
 * @param {string|null|undefined} url the racer's own avatar, if Reddit gave us one
 * @param {{ alt?: string, genericClass?: string, hidden?: boolean }} [options]
 *   `genericClass` is the modifier that insets and plates the default Snoo,
 *   which is drawn edge to edge and cannot simply fill the circle like a
 *   photographic avatar. Surfaces name their own because the podium's rows and
 *   the challenge seats are styled apart.
 * @returns {boolean} whether the seat fell back to the default Snoo
 */
export function applyAvatar(img, url, { alt = '', genericClass = '', hidden = false } = {}) {
    if (!img) return false;
    const own = isRedditAvatarUrl(url) ? url : null;
    const ladder = own
        ? [own, GENERIC_SNOO_URL, AVATAR_PLACEHOLDER_SRC]
        : [GENERIC_SNOO_URL, AVATAR_PLACEHOLDER_SRC];
    let step = 0;

    const seat = () => {
        const src = ladder[step];
        // The plate follows the Snoo down the ladder: a face that fails to load
        // must not leave the styling of the face behind it.
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

/**
 * Build a seated racer from nothing, for surfaces that compose their portrait
 * rather than paint into markup.
 *
 * @returns {HTMLImageElement}
 */
export function createAvatarImage(documentRef, url, { className = '', ...options } = {}) {
    const img = documentRef.createElement('img');
    if (className) img.className = className;
    applyAvatar(img, url, options);
    return img;
}
