/**
 * Normalizes checkbox / localStorage values written as `'1'` / `'0'` or loose truthy strings.
 * @param {unknown} raw
 * @param {{ treatMissingAsTrue?: boolean }} [opts] When true, `null` (missing storage key) counts as enabled (music default).
 * @returns {boolean}
 */
export function parseStoredBooleanToggle(raw, { treatMissingAsTrue = false } = {}) {
    if (raw === true || raw === 'true' || raw === 1 || raw === '1') {
        return true;
    }
    if (treatMissingAsTrue && raw === null) {
        return true;
    }
    return false;
}
