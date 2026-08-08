import circuit from './definitions/circuit.js';
import sunlitTemple from './definitions/sunlit-temple.js';
import royalPlateau from './definitions/royal-plateau.js';
import mistwoodSerpent from './definitions/mistwood-serpent.js';
import harborParkLoop from './definitions/harbor-park-loop.js';
import jadeSpiralCircuit from './definitions/jade-spiral-circuit.js';
import cedarRidgeCircuit from './definitions/cedar-ridge-circuit.js';
import twinRise from './definitions/twin-rise.js';
import sakuraWeave from './definitions/sakura-weave.js';
import kettleRun from './definitions/kettle-run.js';
import carbonBend from './definitions/carbon-bend.js';
import moebiusStrip from './definitions/moebius-strip.js';
import blueSector from './definitions/blue-sector.js';
import alloyRing from './definitions/alloy-ring.js';
import twistedCanyon from './definitions/twisted-canyon.js';
import greenTroll from './definitions/green-troll.js';
import desertBridge from './definitions/desert-bridge.js';
import templeStraight from './definitions/temple-straight.js';
import goldenMarsh from './definitions/golden-marsh.js';
import harborPrincipality from './definitions/harbor-principality.js';
import serpentCrossing from './definitions/serpent-crossing.js';
import ardennesRidge from './definitions/ardennes-ridge.js';
import pretzelArena from './definitions/pretzel-arena.js';
import albertGardens from './definitions/albert-gardens.js';
import jumpingJack from './definitions/jumping-jack.js';
import caspianBoulevard from './definitions/caspian-boulevard.js';
import velvetWombat from './definitions/velvet-wombat.js';
import cobaltRun from './definitions/cobalt-run.js';
import pebblePass from './definitions/pebble-pass.js';
import zenithRun from './definitions/zenith-run.js';
import speedAltar from './definitions/speed-altar.js';
import groundControl from './definitions/ground-control.js';
import crystalineHarbor from './definitions/crystaline-harbor.js';
import ironHook from './definitions/iron-hook.js';
import greatBazaar from './definitions/great-bazaar.js';
import circuitPromax from './definitions/circuit-promax.js';
import mistfallCircuit from './definitions/mistfall-circuit.js';
import stretchingCat from './definitions/stretching-cat.js';
import turboShell from './definitions/turbo-shell.js';
import redLagoon from './definitions/red-lagoon.js';
import copperVale from './definitions/copper-vale.js';
import obsidianRidge from './definitions/obsidian-ridge.js';
import auroraRing from './definitions/aurora-ring.js';
import lanternPier from './definitions/lantern-pier.js';
import quartzHollow from './definitions/quartz-hollow.js';
import needleChicane from './definitions/needle-chicane.js';
import cinderSpine from './definitions/cinder-spine.js';
import glassSerpent from './definitions/glass-serpent.js';
import numberZero from './definitions/number-zero.js';
import numberOne from './definitions/number-one.js';
import numberTwo from './definitions/number-two.js';
import numberThree from './definitions/number-three.js';
import numberFour from './definitions/number-four.js';
import numberFive from './definitions/number-five.js';
import numberSix from './definitions/number-six.js';
import numberSeven from './definitions/number-seven.js';
import numberEight from './definitions/number-eight.js';
import numberNine from './definitions/number-nine.js';
import analogAudio from './definitions/analog-audio.js';
import sundayMarket from './definitions/sunday-market.js';
import hardHitter from './definitions/hard-hitter.js';
import roadRage from './definitions/road-rage.js';
import yellowYard from './definitions/yellow-yard.js';
import lunarLimbo from './definitions/lunar-limbo.js';
import furiousFast from './definitions/furious-fast.js';
import blackstoneRun from './definitions/blackstone-run.js';
import titanTown from './definitions/titan-town.js';
import eulersNumber from './definitions/eulers-number.js';
import imaginaryNumber from './definitions/imaginary-number.js';
import infinitePie from './definitions/infinite-pie.js';
import centralDrop from './definitions/central-drop.js';
import goldenRatio from './definitions/golden-ratio.js';
import fedoraHat from './definitions/fedora-hat.js';
import infinityIsle from './definitions/infinity-isle.js';
import kangarooKyle from './definitions/kangaroo-kyle.js';
import quarterlyQuestion from './definitions/quarterly-question.js';
import romanianRhapsody from './definitions/romanian-rhapsody.js';
import fairyLand from './definitions/fairy-land.js';
import felineFace from './definitions/feline-face.js';
import darkMatter from './definitions/dark-matter.js';
import appleStrudel from './definitions/apple-strudel.js';
import heavyMetal from './definitions/heavy-metal.js';
import knifesEdge from './definitions/knifes-edge.js';
import pocketRun from './definitions/pocket-run.js';
import crossCurrent from './definitions/cross-current.js';
import squareDeal from './definitions/square-deal.js';
import doubleHook from './definitions/double-hook.js';
import doubleCrest from './definitions/double-crest.js';
import { TRACK_CATALOG, getTrackName } from './catalog.js';

const TRACK_GEOMETRY = {
    circuit,
    sunlitTemple,
    royalPlateau,
    mistwoodSerpent,
    harborParkLoop,
    jadeSpiralCircuit,
    cedarRidgeCircuit,
    twinRise,
    sakuraWeave,
    kettleRun,
    carbonBend,
    moebiusStrip,
    blueSector,
    alloyRing,
    twistedCanyon,
    greenTroll,
    desertBridge,
    templeStraight,
    goldenMarsh,
    harborPrincipality,
    serpentCrossing,
    ardennesRidge,
    pretzelArena,
    albertGardens,
    jumpingJack,
    caspianBoulevard,
    velvetWombat,
    cobaltRun,
    pebblePass,
    zenithRun,
    speedAltar,
    groundControl,
    crystalineHarbor,
    ironHook,
    greatBazaar,
    circuitPromax,
    mistfallCircuit,
    stretchingCat,
    turboShell,
    redLagoon,
    copperVale,
    obsidianRidge,
    auroraRing,
    lanternPier,
    quartzHollow,
    needleChicane,
    cinderSpine,
    glassSerpent,
    numberZero,
    numberOne,
    numberTwo,
    numberThree,
    numberFour,
    numberFive,
    numberSix,
    numberSeven,
    numberEight,
    numberNine,
    analogAudio,
    sundayMarket,
    hardHitter,
    roadRage,
    yellowYard,
    lunarLimbo,
    furiousFast,
    blackstoneRun,
    titanTown,
    eulersNumber,
    imaginaryNumber,
    infinitePie,
    centralDrop,
    goldenRatio,
    fedoraHat,
    infinityIsle,
    kangarooKyle,
    quarterlyQuestion,
    romanianRhapsody,
    fairyLand,
    felineFace,
    darkMatter,
    appleStrudel,
    heavyMetal,
    knifesEdge,
    pocketRun,
    crossCurrent,
    squareDeal,
    doubleHook,
    doubleCrest,
};

// Compatibility registry for existing gameplay and server consumers.
export const TRACKS = Object.fromEntries(
    Object.keys(TRACK_CATALOG).map((trackKey) => [
        trackKey,
        { name: getTrackName(trackKey), ...TRACK_GEOMETRY[trackKey] },
    ]),
);
