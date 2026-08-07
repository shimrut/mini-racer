/**
 * The empty seat in a duel. Drawn locally rather than fetched: the viewer's
 * side is empty for exactly the signed-out stranger a Challenge post invites,
 * and a remote placeholder that fails to load leaves a broken box in the one
 * frame that has to sell the race.
 */
const SILHOUETTE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<circle cx="32" cy="24" r="11" fill="%23475569"/>`
    + `<path d="M12 58c0-11 9-19 20-19s20 8 20 19z" fill="%23475569"/>`
    + `</svg>`;

export const AVATAR_PLACEHOLDER_SRC = `data:image/svg+xml,${SILHOUETTE}`;
