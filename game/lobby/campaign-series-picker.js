import { resolveTrackPresentation } from '../track/presentation.js';
import { getCampaignSeriesGrounds, getCampaignSeriesSurfaceLabel } from '../campaign/series-surfaces.js';

// The series choice on the Campaign screen. It sits where the Daily screen shows
// the selected track. In the list, each series has a kerb mark in the colours of
// its first stage: red and white tarmac, clay and cream dirt, blue and white snow.

const MEDALS_PER_STAGE = 4;

export function getSeriesKerbColors(ground) {
    const look = resolveTrackPresentation(null, { ground });
    return { a: look.curbRed, b: look.curbWhite };
}

// "12/64": the medals a player holds in a series, of the most it can give.
export function formatSeriesMedals(series) {
    const medalCount = Number.isInteger(series?.medalCount) ? series.medalCount : 0;
    const stageCount = Number.isInteger(series?.stageCount) ? series.stageCount : 0;
    return `${medalCount}/${stageCount * MEDALS_PER_STAGE}`;
}

function setKerbColors(element, ground) {
    const { a, b } = getSeriesKerbColors(ground);
    element.style.setProperty('--series-kerb-a', a);
    element.style.setProperty('--series-kerb-b', b);
}

export class CampaignSeriesPicker {
    constructor({ onSelect = null } = {}) {
        this.onSelect = onSelect;
        this.series = [];
        this.currentId = null;
        this._outsidePointerHandler = (event) => {
            if (this.isOpen() && !this.root?.contains?.(event.target)) this.close();
        };
    }

    get root() { return document.querySelector?.('[data-campaign-series]') ?? null; }
    get button() { return document.getElementById('campaign-series-btn'); }
    get menu() { return document.getElementById('campaign-series-menu'); }

    bind() {
        this.button?.addEventListener('click', () => {
            if (this.isOpen()) this.close();
            else this.open();
        });
        this.menu?.addEventListener('click', (event) => {
            const option = event.target?.closest?.('[data-series-id]');
            if (option) this.choose(option.dataset.seriesId);
        });
        document.addEventListener('pointerdown', this._outsidePointerHandler, true);
    }

    isOpen() {
        return Boolean(this.menu && !this.menu.hidden);
    }

    isInteractive() {
        return this.series.length > 1;
    }

    // Shows the series of `state`, or hides the picker when `state` is null.
    // Returns true when the picker is shown.
    sync(state) {
        const root = this.root;
        const series = Array.isArray(state?.series) ? state.series : [];
        if (!root || !state || !series.length) {
            if (root) root.hidden = true;
            this.close({ restoreFocus: false });
            return false;
        }

        this.series = series;
        const current = series.find((entry) => entry.id === state.seriesId) ?? series[0];
        this.currentId = current.id;
        root.hidden = false;

        const button = this.button;
        const medals = formatSeriesMedals(current);
        button.querySelector('.campaign-series__name').textContent = current.name;
        button.querySelector('.campaign-series__medals').textContent = `${medals} Medals`;
        button.disabled = !this.isInteractive();
        button.setAttribute('aria-label', this.isInteractive()
            ? `Series: ${current.name}, ${medals} medals. Change series`
            : `Series: ${current.name}, ${medals} medals`);
        if (this.isOpen()) this.renderOptions();
        return true;
    }

    renderOptions() {
        const menu = this.menu;
        if (!menu) return;
        menu.replaceChildren(...this.series.map((series) => {
            const option = document.createElement('div');
            option.className = 'campaign-series__option';
            option.id = `campaign-series-option-${series.id}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(series.id === this.currentId));
            option.tabIndex = -1;
            option.dataset.seriesId = series.id;
            setKerbColors(option, getCampaignSeriesGrounds(series)[0]);

            const kerb = document.createElement('span');
            kerb.className = 'campaign-series__kerb';
            kerb.setAttribute('aria-hidden', 'true');

            const text = document.createElement('span');
            text.className = 'campaign-series__option-text';
            const name = document.createElement('span');
            name.className = 'campaign-series__option-name';
            name.textContent = series.name;
            const ground = document.createElement('span');
            ground.className = 'campaign-series__option-ground';
            ground.textContent = `${getCampaignSeriesSurfaceLabel(series)} · ${series.stageCount} stages`;
            text.append(name, ground);

            const medals = document.createElement('span');
            medals.className = 'campaign-series__option-medals';
            medals.textContent = formatSeriesMedals(series);
            if (series.finished) medals.dataset.finished = 'true';
            medals.setAttribute('aria-label', `${formatSeriesMedals(series)} medals${series.finished ? ', finished' : ''}`);

            option.append(kerb, text, medals);
            return option;
        }));
    }

    getOptions() {
        return Array.from(this.menu?.querySelectorAll?.('[role="option"]') ?? []);
    }

    open() {
        if (!this.isInteractive() || !this.menu) return;
        this.renderOptions();
        this.menu.hidden = false;
        this.button?.setAttribute('aria-expanded', 'true');
        const options = this.getOptions();
        (options.find((option) => option.getAttribute('aria-selected') === 'true') ?? options[0])?.focus();
    }

    close({ restoreFocus = true } = {}) {
        if (!this.isOpen()) return;
        this.menu.hidden = true;
        this.button?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) this.button?.focus();
    }

    choose(seriesId) {
        this.close();
        if (seriesId && seriesId !== this.currentId) this.onSelect?.(seriesId);
    }

    // Keys while the list is open. Returns true when the key was used here.
    handleKeydown(event) {
        if (!this.isOpen()) return false;
        const options = this.getOptions();
        const index = options.indexOf(document.activeElement);
        const focusAt = (next) => options[(next + options.length) % options.length]?.focus();
        switch (event.key) {
        case 'ArrowDown':
        case 's':
        case 'S':
            focusAt(index + 1);
            break;
        case 'ArrowUp':
        case 'w':
        case 'W':
            focusAt(index - 1);
            break;
        case 'Home':
            focusAt(0);
            break;
        case 'End':
            focusAt(options.length - 1);
            break;
        case 'Enter':
        case ' ':
            this.choose(options[index]?.dataset.seriesId ?? null);
            break;
        case 'Escape':
            this.close();
            break;
        case 'Tab':
            this.close({ restoreFocus: false });
            return true;
        default:
            return false;
        }
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
    }
}
