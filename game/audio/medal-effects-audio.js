import { getCarProceduralAudioEnabled } from '../settings/car-audio-preference.js';
import { registerAudioPrepareOnFirstUserGesture } from './first-user-gesture-unlock.js';

let registeredApi = null;

export function userGesturePrepareMedalEffects() {
    registeredApi?.prepareOnUserGesture?.();
}

export function createMedalEffectsAudio(externalCtx, externalOutput) {
    const activeNodes = new Set();
    function keepAlive(node) {
        activeNodes.add(node);
        node.onended = () => activeNodes.delete(node);
    }

    let ctx = null;
    let masterGain = null;
    let graphBuilt = false;
    let tabHidden = false;

    function buildGraph() {
        if (graphBuilt) return;

        if (externalCtx) {
            ctx = externalCtx;
        } else {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (typeof Ctor !== 'function') {
                graphBuilt = true;
                return;
            }
            ctx = new Ctor();
        }

        masterGain = ctx.createGain();
        masterGain.gain.value = 1.0; // The master volume level of medal effect gains themselves
        masterGain.connect(externalOutput || ctx.destination);

        graphBuilt = true;
    }

    const api = {
        prepareOnUserGesture() {
            buildGraph();
            if (ctx && ctx.state === 'suspended') {
                void ctx.resume();
            }
        },

        setTabHidden(hidden) {
            tabHidden = Boolean(hidden);
            if (hidden && ctx && ctx.state === 'running') {
                void ctx.suspend();
            } else if (!hidden && ctx && ctx.state === 'suspended' && getCarProceduralAudioEnabled()) {
                void ctx.resume();
            }
        },

        scheduleMedalUnlock(tier) {
            if (!getCarProceduralAudioEnabled() || tabHidden) return;
            buildGraph();
            if (!ctx || !masterGain) return;

            // Ensure AudioContext is running
            if (ctx.state === 'suspended') {
                void ctx.resume();
            }

            const t = ctx.currentTime;
            const isAuthor = tier === 'author';
            const isGold = tier === 'gold';
            
            // Tier-based pitches (Clear harmonic steps)
            let freq = 329.63; // Bronze (E4)
            if (tier === 'silver') freq = 440.00; // Silver (A4)
            if (tier === 'gold') freq = 659.25; // Gold (E5)
            if (tier === 'author') freq = 880.00; // Author (A5)
            if (tier === 'personal-best') freq = 523.25; // Personal best (C5)

            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(freq * 1.02, t + 0.15);

            const g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.45, t + 0.005);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);

            osc.connect(g);
            g.connect(masterGain);
            keepAlive(osc);
            osc.start(t);
            osc.stop(t + 1.0);

            // Add a high "chime" for gold and author
            if (isGold || isAuthor) {
                const chime = ctx.createOscillator();
                chime.type = 'sine';
                chime.frequency.setValueAtTime(freq * 2, t + 0.02);
                const chimeG = ctx.createGain();
                chimeG.gain.setValueAtTime(0, t + 0.02);
                chimeG.gain.linearRampToValueAtTime(0.15, t + 0.03);
                chimeG.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
                chime.connect(chimeG);
                chimeG.connect(masterGain);
                keepAlive(chime);
                chime.start(t + 0.02);
                chime.stop(t + 0.5);
            }
        }
    };

    registeredApi = api;
    registerAudioPrepareOnFirstUserGesture(() => registeredApi?.prepareOnUserGesture?.());
    return api;
}
