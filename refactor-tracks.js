import fs from 'fs';

const tracksFile = 'game/track/tracks.js';
let content = fs.readFileSync(tracksFile, 'utf8');

const legacyTracks = new Set([
    'circuit', 'sunlitTemple', 'royalPlateau', 'mistwoodSerpent', 'harborParkLoop',
    'jadeSpiralCircuit', 'cedarRidgeCircuit', 'twinRise', 'sakuraWeave', 'kettleRun',
    'carbonBend', 'moebiusStrip', 'blueSector', 'alloyRing', 'twistedCanyon',
    'greenTroll', 'desertBridge', 'templeStraight', 'harborPrincipality', 'serpentCrossing',
    'ardennesRidge', 'pretzelArena', 'albertGardens', 'caspianBoulevard', 'velvetWombat',
    'cobaltRun', 'pebblePass', 'zenithRun', 'speedAltar', 'groundControl', 'crystalineHarbor',
]);

const newTracks = {
    'ironHook': '2026-06-03',
    'greatBazaar': '2026-06-03',
    'circuitPromax': '2026-06-03',
    'stretchingCat': '2026-06-03',
    'turboShell': '2026-06-03',
    'redLagoon': '2026-06-08',
    'copperVale': '2026-06-08',
    'obsidianRidge': '2026-06-08',
    'auroraRing': '2026-06-08',
    'lanternPier': '2026-06-08',
    'quartzHollow': '2026-06-08',
    'needleChicane': '2026-06-08',
    'cinderSpine': '2026-06-08',
    'glassSerpent': '2026-06-08',
};

const regex = /^(    [a-zA-Z0-9]+: \{\n        name: "[^"]+",\n)/gm;

let matchCount = 0;
content = content.replace(regex, (match, p1) => {
    matchCount++;
    const trackKeyMatch = match.match(/    ([a-zA-Z0-9]+): \{/);
    if (!trackKeyMatch) return match;
    const trackKey = trackKeyMatch[1];
    
    let releaseDate = '2026-05-01'; // Default for legacy as per user request
    if (newTracks[trackKey]) {
        releaseDate = newTracks[trackKey];
    }
    
    return `${p1}        releaseDate: '${releaseDate}',\n`;
});

fs.writeFileSync(tracksFile, content);
console.log(`Updated ${matchCount} tracks in ${tracksFile}`);
