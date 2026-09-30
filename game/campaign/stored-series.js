// Campaign series made in the Creator live in the game's database, not in the
// app. The game and the server give the manifest the published ones before
// they read the Campaign. A stored series with the name of an app series
// replaces it. Each entry has the form of an entry in series.json:
// { id, name, ground, stages: [{ trackKey, laps, requiredMedals }] }.
// This file has no imports, so the manifest can use it.

const EMPTY = Object.freeze([]);
let localStoredSeries = EMPTY;
let storedSeriesResolver = () => localStoredSeries;

// The same list object comes back until the list changes, so the manifest
// builds the series again only after a change.
export function getStoredSeriesDefinitions() {
    const definitions = storedSeriesResolver();
    return Array.isArray(definitions) ? definitions : EMPTY;
}

// The server gives each subreddit its own series, so it replaces the lookup
// for the current request. The game keeps the local list.
export function setStoredSeriesResolver(resolver) {
    storedSeriesResolver = typeof resolver === 'function' ? resolver : () => localStoredSeries;
}

export function registerStoredSeries(definitions) {
    localStoredSeries = Object.freeze((Array.isArray(definitions) ? definitions : [])
        .filter((definition) => definition && typeof definition.id === 'string')
        .map((definition) => Object.freeze({ ...definition })));
    return localStoredSeries;
}

export function clearStoredSeriesForTests() {
    localStoredSeries = EMPTY;
    setStoredSeriesResolver(null);
}
