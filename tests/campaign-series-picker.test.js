// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CampaignSeriesPicker,
    formatSeriesMedals,
    getSeriesKerbColors,
} from '../game/lobby/campaign-series-picker.js';

const SERIES = [
    { id: 'numbered-v1', name: 'Numbers', ground: 'tarmac', stageCount: 16, medalCount: 23, finished: false },
    { id: 'dirt-v1', name: 'Dirt', ground: 'dirt', stageCount: 10, medalCount: 40, finished: true },
];

function mountSubhead() {
    document.body.innerHTML = `
        <div class="lobby-subhead" data-lobby-subhead>
            <span class="lobby-subhead__rule" data-lobby-subhead-rule></span>
            <div class="campaign-series" data-campaign-series hidden>
                <button id="campaign-series-btn" type="button" aria-expanded="false">
                    <span class="campaign-series__name"></span>
                    <span class="campaign-series__medals"></span>
                </button>
                <div id="campaign-series-menu" role="listbox" tabindex="-1" hidden></div>
            </div>
        </div>
        <button id="outside" type="button">Outside</button>`;
}

function key(name) {
    return new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
}

describe('Campaign series picker', () => {
    let onSelect;
    let picker;

    beforeEach(() => {
        mountSubhead();
        onSelect = vi.fn();
        picker = new CampaignSeriesPicker({ onSelect });
        picker.bind();
    });

    it('counts medals out of four for each stage', () => {
        expect(formatSeriesMedals(SERIES[0])).toBe('23/64');
        expect(formatSeriesMedals({})).toBe('0/0');
    });

    it('takes the kerb colours of each ground from the track look', () => {
        expect(getSeriesKerbColors('dirt')).toEqual({ a: '#b07a4c', b: '#f1e4cc' });
        expect(getSeriesKerbColors('snow')).toEqual({ a: '#6fa8d6', b: '#f8fafc' });
    });

    it('shows the series on screen and leaves the subhead rule as it is', () => {
        expect(picker.sync({ seriesId: 'dirt-v1', series: SERIES })).toBe(true);
        const subhead = document.querySelector('[data-lobby-subhead]');
        expect(document.querySelector('[data-campaign-series]').hidden).toBe(false);
        expect(document.querySelector('.campaign-series__name').textContent).toBe('Dirt');
        expect(document.querySelector('.campaign-series__medals').textContent).toBe('40/40 Medals');
        expect(subhead.getAttribute('style')).toBeNull();
        expect(subhead.dataset.seriesGround).toBeUndefined();
    });

    it('does not open with one series, and hides outside the Campaign screen', () => {
        picker.sync({ seriesId: 'numbered-v1', series: [SERIES[0]] });
        expect(document.getElementById('campaign-series-btn').disabled).toBe(true);
        picker.open();
        expect(picker.isOpen()).toBe(false);

        expect(picker.sync(null)).toBe(false);
        expect(document.querySelector('[data-campaign-series]').hidden).toBe(true);
    });

    it('lists every series with its ground and medals, and marks the one on screen', () => {
        picker.sync({ seriesId: 'numbered-v1', series: SERIES });
        document.getElementById('campaign-series-btn').click();
        const options = [...document.querySelectorAll('[role="option"]')];
        expect(options.map((option) => option.textContent)).toEqual([
            'NumbersTarmac · 16 stages23/64',
            'DirtDirt · 10 stages40/40',
        ]);
        expect(options[0].getAttribute('aria-selected')).toBe('true');
        expect(options[1].querySelector('[data-finished="true"]')).not.toBeNull();
        expect(document.activeElement).toBe(options[0]);
    });

    it('chooses a series with the keyboard and gives focus back to the button', () => {
        picker.sync({ seriesId: 'numbered-v1', series: SERIES });
        picker.open();
        picker.handleKeydown(key('ArrowDown'));
        picker.handleKeydown(key('Enter'));
        expect(onSelect).toHaveBeenCalledWith('dirt-v1');
        expect(picker.isOpen()).toBe(false);
        expect(document.activeElement).toBe(document.getElementById('campaign-series-btn'));
    });

    it('closes without a change on Escape, on the series on screen, and on a tap outside', () => {
        picker.sync({ seriesId: 'numbered-v1', series: SERIES });
        picker.open();
        picker.handleKeydown(key('Escape'));
        expect(picker.isOpen()).toBe(false);

        picker.open();
        document.querySelector('[data-series-id="numbered-v1"]').click();
        expect(picker.isOpen()).toBe(false);

        picker.open();
        document.getElementById('outside').dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(picker.isOpen()).toBe(false);
        expect(onSelect).not.toHaveBeenCalled();
    });
});
