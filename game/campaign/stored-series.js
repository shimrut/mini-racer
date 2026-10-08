// Published Creator series, given to the manifest before it reads the Campaign; same name replaces an app series.
// Entry: { id, name, ground, grounds, finalStageId, stages: [{ trackKey, laps, requiredMedals }] }. No imports.

const EMPTY = Object.freeze([]);
let localStoredSeries = EMPTY;
let storedSeriesResolver = () => localStoredSeries;
let storedSeriesListLoaded = false;

// The same object returns until the list changes, so the manifest rebuilds only then.
export function getStoredSeriesDefinitions() {
    const definitions = storedSeriesResolver();
    return Array.isArray(definitions) ? definitions : EMPTY;
}

// The server replaces this lookup per request, so each subreddit has its own series.
export function setStoredSeriesResolver(resolver) {
    storedSeriesResolver = typeof resolver === 'function' ? resolver : () => localStoredSeries;
}

export function registerStoredSeries(definitions) {
    localStoredSeries = Object.freeze((Array.isArray(definitions) ? definitions : [])
        .filter((definition) => definition && typeof definition.id === 'string')
        .map((definition) => Object.freeze({ ...definition })));
    return localStoredSeries;
}

// Before the first Campaign answer, a Creator stage is unknown, not gone.
export function markStoredSeriesLoaded() {
    storedSeriesListLoaded = true;
}

export function isStoredSeriesListLoaded() {
    return storedSeriesListLoaded;
}

export function clearStoredSeriesForTests() {
    localStoredSeries = EMPTY;
    storedSeriesListLoaded = false;
    setStoredSeriesResolver(null);
}
