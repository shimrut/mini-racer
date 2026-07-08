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

/**
 * Builds a boolean preference backed by localStorage, returning `{ get, set }`.
 * `readLabel`/`writeLabel` are used in console errors so each preference reports its own name.
 * @param {string} storageKey
 * @param {{ treatMissingAsTrue?: boolean, readLabel?: string, writeLabel?: string }} [opts]
 */
export function createBooleanPreference(storageKey, {
    treatMissingAsTrue = false,
    readLabel = 'boolean preference',
    writeLabel = readLabel,
} = {}) {
    function get() {
        if (typeof window === 'undefined' || !window.localStorage) {
            return treatMissingAsTrue;
        }
        try {
            return parseStoredBooleanToggle(
                window.localStorage.getItem(storageKey),
                { treatMissingAsTrue },
            );
        } catch (error) {
            console.error(`Error reading ${readLabel}:`, error);
            return treatMissingAsTrue;
        }
    }

    function set(value) {
        const next = parseStoredBooleanToggle(value, { treatMissingAsTrue });
        if (typeof window === 'undefined' || !window.localStorage) {
            return next;
        }
        try {
            window.localStorage.setItem(storageKey, next ? '1' : '0');
        } catch (error) {
            console.error(`Error writing ${writeLabel}:`, error);
        }
        return next;
    }

    return { get, set };
}
