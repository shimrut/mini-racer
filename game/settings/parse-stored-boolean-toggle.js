export function parseStoredBooleanToggle(raw, { treatMissingAsTrue = false } = {}) {
    if (raw === true || raw === 'true' || raw === 1 || raw === '1') {
        return true;
    }
    if (treatMissingAsTrue && raw === null) {
        return true;
    }
    return false;
}

export function createBooleanPreference(storageKey, {
    treatMissingAsTrue = false,
    label = 'boolean preference',
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
            console.error(`Error reading ${label}:`, error);
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
            console.error(`Error writing ${label}:`, error);
        }
        return next;
    }

    return { get, set };
}
