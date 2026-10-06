import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealTimeRacer } from '../game/engine.js';
import { GarageUi } from '../game/settings/garage-ui.js';
import { PLAYER_CAR_SKINS, readPlayerCarSkinAssetName, writePlayerCarSkinAssetName } from '../game/car/player-car-skin.js';
import { writePlayerCarDecalStyle } from '../game/car/player-car-decals.js';
import { readPlayerCarPaint, writePlayerCarPaint } from '../game/car/player-car-paint.js';
import { readPlayerCarTrails, readPlayerTrailId, trailStrokeStyleForId } from '../game/car/player-trail.js';
import { raceEngineMethods } from '../game/race/engine-methods.js';

beforeEach(() => {
    const storage = new Map();
    vi.stubGlobal('window', { localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
    } });
    vi.stubGlobal('document', { getElementById: () => null, querySelectorAll: () => [] });
});
afterEach(() => vi.unstubAllGlobals());

function createEngine(garage) {
    return {
        garage,
        pbGhost: { setEnabled: vi.fn() },
        routeTrace: { clear: vi.fn() },
        settings: Object.fromEntries([
            'CarAudio', 'Music', 'CollisionAutoRestart', 'QuickRestart',
            'CollisionRestartDelay', 'PausePlacement', 'HideHud', 'PbGhost',
        ].map((name) => [`refresh${name}Panel`, vi.fn()])),
        hud: { syncPauseControls: vi.fn() },
        syncCarSpriteAsset: vi.fn().mockResolvedValue(undefined),
        requestRender: vi.fn(),
    };
}

const applyProfile = (engine, profile, options) =>
    RealTimeRacer.prototype.applyPersistedPlayerPreferences.call(engine, profile, options);

describe('Garage saved-profile previews', () => {
    it('edits the preview skin trail, keeps other skins independent and saves once per choice', () => {
        const save = vi.fn();
        const garage = new GarageUi({ onPlayerPreferencesChanged: save });
        garage.bind();
        garage.selectTrail('gold');
        garage.selectCarSkin('drawn/formula-gold');
        const nextCar = garage.previewSkin.assetName;
        garage.selectTrail('none');
        garage.selectCarSkin('drawn/formula-red');
        expect(readPlayerTrailId(garage.trailAssetName)).toBe('gold');
        expect(readPlayerTrailId(nextCar)).toBe('none');
        expect(readPlayerTrailId()).toBe('sky');
        expect(save).toHaveBeenCalledTimes(4); // Two trail choices and two car changes.

        garage.setGarageTab('legacy', { focusTab: false });
        garage.selectCarSkin('assets/cars/mr_mr_red.webp');
        garage.selectTrail('white');
        expect(garage.trailAssetName).toBe('assets/cars/mr_mr_red.webp');
        expect(readPlayerCarTrails()).toEqual({
            'drawn/formula-red': 'gold', [nextCar]: 'none', 'assets/cars/mr_mr_red.webp': 'white',
        });
    });

    it('uses the actual track skin trail on profile replacement and clears missing owner maps', async () => {
        const garage = new GarageUi();
        garage.bind();
        const engine = createEngine(garage);
        engine.currentTrack = { ground: 'grip' };
        garage.setGarageTab('street', { focusTab: false });
        await applyProfile(engine, {
            carSkin: 'drawn/formula-gold',
            carSkinGrip: 'drawn/mr_grip_circuit',
            trailId: 'gold',
            carTrails: { 'drawn/formula-gold': 'coral', 'drawn/mr_grip_circuit': 'none' },
        }, { loadCar: false });
        expect(engine.routeTraceStrokeStyle).toBeNull();
        expect(readPlayerTrailId(garage.trailAssetName)).toBe('coral');
        expect(engine.routeTrace.clear).toHaveBeenCalledOnce();
        await applyProfile(engine, { trailId: 'white' }, { loadCar: false });
        expect(readPlayerCarTrails()).toEqual({});
        expect(engine.routeTraceStrokeStyle).toBe(trailStrokeStyleForId('white'));
    });

    it('keeps the active ground trail when another ground is customized, then follows cached track changes', () => {
        const garage = new GarageUi();
        garage.bind();
        const engine = {
            currentTrack: { ground: 'tarmac' },
            getSelectedCarAssetName: raceEngineMethods.getSelectedCarAssetName,
            routeTrace: { clear: vi.fn() },
            loadCarSpriteAsset: vi.fn().mockResolvedValue(undefined),
        };
        garage.selectTrail('gold');
        raceEngineMethods.syncCarSpriteAsset.call(engine);
        expect(engine.routeTraceStrokeStyle).toBe(trailStrokeStyleForId('gold'));
        engine.routeTrace.clear.mockClear();
        garage.setGarageTab('snow', { focusTab: false });
        garage.selectTrail('none');
        raceEngineMethods.syncCarSpriteAsset.call(engine);
        expect(engine.routeTraceStrokeStyle).toBe(trailStrokeStyleForId('gold'));
        expect(engine.routeTrace.clear).not.toHaveBeenCalled();
        engine.currentTrack = { ground: 'snow' };
        // reset() resolves the trail even when the sprite loader reuses a cached car.
        raceEngineMethods.syncCarTrailStyle.call(engine, { resetTrace: true, seedTrace: false });
        expect(engine.routeTraceStrokeStyle).toBeNull();
        expect(engine.routeTrace.clear).toHaveBeenCalledOnce();
        engine.currentTrack = { ground: 'tarmac' };
        raceEngineMethods.syncCarSpriteAsset.call(engine);
        expect(engine.routeTraceStrokeStyle).toBe(trailStrokeStyleForId('gold'));
    });

    it('replaces the early default preview before a paint choice can equip the wrong car', async () => {
        const onCarSkinChanged = vi.fn();
        const garage = new GarageUi({ onCarSkinChanged });
        garage.bind();
        expect(garage.previewSkin.assetName).toBe('drawn/formula-red');
        const engine = createEngine(garage);
        await applyProfile(engine, {
            carSkin: 'drawn/formula-gold',
            carPaints: { 'drawn/formula-gold': { main: '#246bff' } },
        });
        expect(garage.previewSkin.assetName).toBe('drawn/formula-gold');
        expect(readPlayerCarPaint(garage.previewSkin.assetName).main).toBe('#246bff');
        garage.setGarageTab('street', { focusTab: false });
        writePlayerCarPaint(garage.previewSkin.assetName, 'accent', '#a8ed35');
        garage.selectCarSkin(garage.previewSkin.assetName);
        expect(readPlayerCarSkinAssetName('tarmac')).toBe('drawn/formula-gold');
        expect(readPlayerCarPaint('drawn/formula-red')).toEqual({});
        expect(onCarSkinChanged).toHaveBeenCalledWith('drawn/formula-gold');
        expect(engine.syncCarSpriteAsset).toHaveBeenCalledOnce();
    });

    it('equips the street car when a decal is chosen over a legacy car', () => {
        writePlayerCarSkinAssetName('assets/cars/mr_mr_red.webp');
        const garage = new GarageUi();
        garage.activeGarageTab = 'street';
        const street = garage.previewSkin;
        expect(street.series).toBe('formula');
        expect(readPlayerCarSkinAssetName('tarmac')).toBe('assets/cars/mr_mr_red.webp');
        writePlayerCarDecalStyle(street.assetName, 'drawn/formula-gold');
        garage.selectCarSkin(street.assetName);
        expect(readPlayerCarSkinAssetName('tarmac')).toBe(street.assetName);
    });

    it('reconciles previously visited types when another account profile replaces their choices', async () => {
        const garage = new GarageUi();
        garage.bind();
        const engine = createEngine(garage);
        const types = [
            ['street', 'formula', 'carSkin', 'tarmac'],
            ['circuit', 'grip', 'carSkinGrip', 'grip'],
            ['dirt', 'dirt', 'carSkinDirt', 'dirt'],
            ['snow', 'snow', 'carSkinSnow', 'snow'],
            ['water', 'water', 'carSkinWater', 'water'],
            ['space', 'space', 'carSkinSpace', 'space'],
        ];
        const profile = (index) => Object.fromEntries(types.map(([, series, field]) =>
            [field, PLAYER_CAR_SKINS.filter((skin) => skin.series === series)[index].assetName]));
        await applyProfile(engine, profile(1), { loadCar: false });
        for (const [tab] of types) garage.setGarageTab(tab, { focusTab: false });
        garage.setGarageTab('legacy', { focusTab: false });
        await applyProfile(engine, profile(2), { loadCar: false });
        expect(garage.activeGarageTab).toBe('legacy');
        for (const [tab, , field, ground] of types) {
            garage.setGarageTab(tab, { focusTab: false });
            expect(garage.previewSkin.assetName).toBe(profile(2)[field]);
            expect(readPlayerCarSkinAssetName(ground)).toBe(profile(2)[field]);
        }
        expect(engine.syncCarSpriteAsset).not.toHaveBeenCalled();
    });

    it('follows the equipped skin on refresh without changing it on tab entry', async () => {
        const garage = new GarageUi();
        garage.bind();
        const engine = createEngine(garage);
        await applyProfile(engine, { carSkin: 'drawn/formula-gold' });
        garage.syncSkinSelection();
        garage.setGarageTab('dirt', { focusTab: false });
        garage.setGarageTab('street', { focusTab: false });
        expect(garage.previewSkin.assetName).toBe('drawn/formula-gold');
        expect(readPlayerCarSkinAssetName('tarmac')).toBe('drawn/formula-gold');
        await applyProfile(engine, null);
        expect(garage.previewSkin.assetName).toBe('drawn/formula-gold');
        await applyProfile(engine, { carSkin: 'assets/cars/mr_mr_red.webp' });
        garage.setGarageTab('dirt', { focusTab: false });
        garage.setGarageTab('street', { focusTab: false });
        expect(garage.previewSkin.assetName).toBe('drawn/formula-red');
        expect(readPlayerCarSkinAssetName('tarmac')).toBe('assets/cars/mr_mr_red.webp');
        garage.selectCarSkin(garage.previewSkin.assetName);
        expect(readPlayerCarSkinAssetName('tarmac')).toBe('drawn/formula-red');
    });
});
