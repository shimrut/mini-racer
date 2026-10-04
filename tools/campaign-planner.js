import { TRACK_CATALOG, TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';
import { TRACK_GROUNDS, getTrackGround } from '../game/track/grounds.js';
import { getCampaignSeriesGrounds, getCampaignSeriesSurfaceLabel } from '../game/campaign/series-surfaces.js';
import { TRACKS } from '../game/track/tracks.js';
import seriesFileData from '../game/campaign/series.json' with { type: 'json' };
import medalTimesFileData from '../game/medals/medal-times.json' with { type: 'json' };
import { isAppCampaignSeriesLive } from '../game/campaign/series-rules.js';
import {
    applyScheduleDestination,
    applyTrackSeriesUpdate,
    DAILY_DESTINATION,
    findTrackStage,
    moveSeriesStage,
    normalizeCampaignSeriesData,
    parseTrackDestination,
    seriesDestination,
    suggestRequiredMedals,
    UNUSED_DESTINATION,
} from './mapmaker/campaign-series.js';
import { getMedalRowError } from './mapmaker/medal-times.js';
import { TrackPreviews } from './mapmaker/track-preview.js';

// A save rewrites files this page imports, so the dev server may reload the page
// right after it. The last status is kept briefly so it shows again after that reload.
const STATUS_KEY = 'campaign-planner:status:v1';
const STATUS_KEEP_MS = 5000;
const MAX_TRACK_RESULTS = 30;

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function getTrackName(trackKey) {
    return TRACK_CATALOG[trackKey]?.name ?? trackKey;
}

function getTrackGroundKey(trackKey) {
    const track = TRACKS[trackKey];
    return track ? getTrackGround(track).key : null;
}

function seriesSurfaces(series) {
    return { ...series, grounds: getCampaignSeriesGrounds(series, getTrackGroundKey) };
}

function seriesIsLive(series) {
    return isAppCampaignSeriesLive(series);
}

function groundLabel(ground) {
    return TRACK_GROUNDS[ground]?.label ?? ground;
}

function stageNumber(index) {
    return String(index).padStart(2, '0');
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function matches(query, text) {
    return !query || text.toLowerCase().includes(query.toLowerCase());
}

function seriesStateText(series) {
    return seriesIsLive(series) ? 'live' : 'not live';
}

async function postJson(path, body) {
    let response;
    try {
        response = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error('Cannot reach the local server. Start it with npm run mapmaker.');
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed with status ${response.status}.`);
    return result;
}

class CampaignPlannerApp {
    constructor() {
        this.statusText = document.getElementById('status-text');
        this.listSearch = document.getElementById('list-search');
        this.listNav = document.getElementById('list-nav');
        this.listTitle = document.getElementById('list-title');
        this.listMeta = document.getElementById('list-meta');
        this.addTrackBtn = document.getElementById('add-track-btn');
        this.listBody = document.getElementById('list-body');
        this.pickerDialog = document.getElementById('picker-dialog');
        this.pickerTitle = document.getElementById('picker-title');
        this.pickerChoose = document.getElementById('picker-choose');
        this.pickerSearch = document.getElementById('picker-search');
        this.pickerList = document.getElementById('picker-list');
        this.pickerConfirm = document.getElementById('picker-confirm');
        this.pickerSummary = document.getElementById('picker-summary');
        this.pickerStageFields = document.getElementById('picker-stage-fields');
        this.pickerLaps = document.getElementById('picker-laps');
        this.pickerTarget = document.getElementById('picker-target');
        this.pickerNotes = document.getElementById('picker-notes');
        this.pickerBackBtn = document.getElementById('picker-back-btn');
        this.pickerConfirmBtn = document.getElementById('picker-confirm-btn');

        this.seriesData = normalizeCampaignSeriesData(seriesFileData);
        this.scheduleKeys = [...TRACK_SCHEDULE_KEYS];
        this.query = '';
        this.picker = null;
        this.previews = new TrackPreviews((trackKey) => TRACKS[trackKey]);

        const hashList = decodeURIComponent(window.location.hash.slice(1));
        this.selectedList = parseTrackDestination(hashList, this.seriesData)
            ? hashList
            : (this.getUnusedKeys().length ? UNUSED_DESTINATION : DAILY_DESTINATION);

        this.bindEvents();
        this.render();
        this.restoreStatus();
    }

    bindEvents() {
        this.listSearch.addEventListener('input', () => {
            this.query = this.listSearch.value.trim();
            this.renderNav();
        });
        this.listNav.addEventListener('click', (event) => {
            const listButton = event.target.closest('button[data-list]');
            if (listButton) this.selectList(listButton.dataset.list);
            const trackButton = event.target.closest('button[data-find-track]');
            if (trackButton) this.findTrack(trackButton.dataset.findTrack);
        });
        this.addTrackBtn.addEventListener('click', () => this.openAddPicker());
        this.listBody.addEventListener('click', (event) => {
            const moveButton = event.target.closest('button[data-direction]');
            if (moveButton) {
                void this.moveStage(moveButton.closest('[data-track-key]').dataset.trackKey, Number(moveButton.dataset.direction));
                return;
            }
            const pickButton = event.target.closest('button[data-move-track]');
            if (pickButton) this.openMovePicker(pickButton.dataset.moveTrack);
        });
        this.listBody.addEventListener('change', (event) => {
            const row = event.target.closest('[data-stage-field]')?.closest('[data-track-key]');
            if (row) void this.updateStage(row);
        });
        this.pickerSearch.addEventListener('input', () => this.renderPickerList());
        this.pickerList.addEventListener('click', (event) => {
            const listButton = event.target.closest('button[data-pick-list]');
            if (listButton) this.choose(this.picker.trackKey, listButton.dataset.pickList);
            const trackButton = event.target.closest('button[data-pick-track]');
            if (trackButton) this.choose(trackButton.dataset.pickTrack, this.picker.destination);
        });
        this.pickerBackBtn.addEventListener('click', () => this.showPickerChoose());
        this.pickerConfirmBtn.addEventListener('click', () => this.confirmPicker());
        this.pickerDialog.addEventListener('close', () => { this.picker = null; });
    }

    setStatus(message, isError = false) {
        this.statusText.textContent = message;
        this.statusText.dataset.error = String(isError);
    }

    announce(message) {
        this.setStatus(message);
        try {
            window.sessionStorage.setItem(STATUS_KEY, JSON.stringify({ message, at: Date.now() }));
        } catch {}
    }

    restoreStatus() {
        try {
            const saved = JSON.parse(window.sessionStorage.getItem(STATUS_KEY) ?? 'null');
            window.sessionStorage.removeItem(STATUS_KEY);
            if (saved && Date.now() - saved.at < STATUS_KEEP_MS) this.setStatus(saved.message);
        } catch {}
    }

    // Lists use the same values as destinations: 'daily', 'none' or 'series:<id>'.
    getSeries(list) {
        const parsed = parseTrackDestination(list, this.seriesData);
        return parsed?.type === 'series'
            ? this.seriesData.series.find((series) => series.id === parsed.seriesId) ?? null
            : null;
    }

    getTrackDestination(trackKey) {
        const stage = findTrackStage(this.seriesData, trackKey);
        if (stage) return seriesDestination(stage.series.id);
        return this.scheduleKeys.includes(trackKey) ? DAILY_DESTINATION : UNUSED_DESTINATION;
    }

    getUnusedKeys() {
        const inSeries = new Set(this.seriesData.series.flatMap((series) => series.stages.map((stage) => stage.trackKey)));
        return Object.keys(TRACK_CATALOG).filter((key) => !this.scheduleKeys.includes(key) && !inSeries.has(key));
    }

    getListTrackKeys(list) {
        if (list === DAILY_DESTINATION) return this.scheduleKeys;
        if (list === UNUSED_DESTINATION) return this.getUnusedKeys();
        return this.getSeries(list)?.stages.map((stage) => stage.trackKey) ?? [];
    }

    getListName(list) {
        if (list === DAILY_DESTINATION) return 'Daily Challenge';
        if (list === UNUSED_DESTINATION) return 'Not used';
        return this.getSeries(list)?.name ?? list;
    }

    getListMeta(list) {
        const count = this.getListTrackKeys(list).length;
        const series = this.getSeries(list);
        if (!series) return plural(count, 'track');
        return `${getCampaignSeriesSurfaceLabel(seriesSurfaces(series))} · ${plural(count, 'stage')} · ${seriesStateText(series)}`;
    }

    isStageFixed(trackKey) {
        const stage = findTrackStage(this.seriesData, trackKey);
        return Boolean(stage && seriesIsLive(stage.series));
    }

    getTrackWarnings(trackKey) {
        const warnings = [];
        if (getMedalRowError(medalTimesFileData[trackKey])) warnings.push('No medal times.');
        return warnings;
    }

    render() {
        this.renderNav();
        this.renderMain();
    }

    selectList(list) {
        this.selectedList = list;
        window.history.replaceState(null, '', `#${encodeURIComponent(list)}`);
        this.render();
    }

    findTrack(trackKey) {
        this.selectList(this.getTrackDestination(trackKey));
        const target = [...this.listBody.querySelectorAll('[data-track-key]')]
            .find((node) => node.dataset.trackKey === trackKey);
        if (!target) return;
        target.scrollIntoView({ block: 'center' });
        target.dataset.highlight = 'true';
        setTimeout(() => { delete target.dataset.highlight; }, 1600);
    }

    createNavButton(list) {
        const button = el('button', 'planner-nav-btn');
        button.type = 'button';
        button.dataset.list = list;
        if (list === this.selectedList) button.setAttribute('aria-current', 'true');
        button.append(el('span', 'planner-nav-name', this.getListName(list)), el('span', 'planner-nav-meta', this.getListMeta(list)));
        if (list === UNUSED_DESTINATION && this.getUnusedKeys().length) button.dataset.attention = 'true';
        return button;
    }

    renderNav() {
        const campaigns = this.seriesData.series.filter((series) => matches(this.query, series.name));
        const children = [
            this.createNavButton(UNUSED_DESTINATION),
            this.createNavButton(DAILY_DESTINATION),
            el('h3', 'planner-nav-heading', `Campaigns (${campaigns.length})`),
            ...campaigns.map((series) => this.createNavButton(seriesDestination(series.id))),
        ];
        if (!campaigns.length) children.push(el('p', 'field-hint', 'No campaign matches.'));
        if (this.query) {
            const tracks = Object.keys(TRACK_CATALOG)
                .filter((key) => matches(this.query, getTrackName(key)))
                .slice(0, MAX_TRACK_RESULTS);
            children.push(el('h3', 'planner-nav-heading', 'Tracks'));
            for (const trackKey of tracks) {
                const button = el('button', 'planner-nav-btn');
                button.type = 'button';
                button.dataset.findTrack = trackKey;
                button.append(
                    el('span', 'planner-nav-name', getTrackName(trackKey)),
                    el('span', 'planner-nav-meta', this.getListName(this.getTrackDestination(trackKey))),
                );
                children.push(button);
            }
            if (!tracks.length) children.push(el('p', 'field-hint', 'No track matches.'));
        }
        this.listNav.replaceChildren(...children);
    }

    renderMain() {
        const list = this.selectedList;
        const series = this.getSeries(list);
        this.listTitle.textContent = this.getListName(list);
        const hints = {
            [UNUSED_DESTINATION]: 'New tracks from the Mapmaker land here.',
            [DAILY_DESTINATION]: 'In schedule order. New Daily tracks go at the end.',
        };
        const hint = series
            ? (seriesIsLive(series) ? 'Players can see it, so its stages are fixed. New tracks go at the end.' : 'Hidden from players, so you can change anything.')
            : hints[list];
        this.listMeta.textContent = `${this.getListMeta(list)}. ${hint}`;
        this.addTrackBtn.hidden = !series;
        this.previews.reset();
        this.listBody.replaceChildren(series ? this.renderStages(series) : this.renderCards(list));
    }

    createMoveButton(trackKey) {
        const button = el('button', 'planner-small-btn', 'Move to…');
        button.type = 'button';
        button.dataset.moveTrack = trackKey;
        return button;
    }

    renderStages(series) {
        if (!series.stages.length) return el('p', 'planner-empty', 'No stages yet. Use Add track.');
        const live = seriesIsLive(series);
        const list = el('ol', 'planner-stages');
        series.stages.forEach((stage, index) => {
            const item = el('li', 'planner-stage');
            item.dataset.trackKey = stage.trackKey;
            const info = el('div', 'planner-stage-info');
            info.append(el('strong', '', getTrackName(stage.trackKey)));
            const warnings = this.getTrackWarnings(stage.trackKey);
            if (warnings.length) info.append(el('span', 'planner-warn', warnings.join(' ')));
            item.append(
                el('span', 'planner-stage-number', stageNumber(index)),
                this.previews.create(stage.trackKey, 'planner-stage-preview'),
                info,
            );
            if (live) {
                item.append(el('span', 'planner-stage-fixed', `${plural(stage.laps, 'lap')} · target ${stage.requiredMedals}`));
            } else {
                item.append(this.createStageFields(stage, index), this.createStageActions(index, series.stages.length, stage.trackKey));
            }
            list.appendChild(item);
        });
        return list;
    }

    createStageFields(stage, index) {
        const fields = el('div', 'planner-stage-fields');
        const laps = el('select');
        laps.dataset.stageField = 'laps';
        laps.setAttribute('aria-label', 'Laps');
        for (const value of [1, 2, 3]) {
            const option = el('option', '', plural(value, 'lap'));
            option.value = String(value);
            laps.appendChild(option);
        }
        laps.value = String(stage.laps);
        const target = el('input');
        target.type = 'number';
        target.min = '0';
        target.step = '1';
        target.value = String(stage.requiredMedals);
        target.disabled = index === 0;
        target.dataset.stageField = 'requiredMedals';
        target.setAttribute('aria-label', 'Medal target');
        target.title = index === 0 ? 'The first stage is always open.' : 'Medals needed to open this stage.';
        const targetLabel = el('label', 'planner-target');
        targetLabel.append(el('span', '', 'Target'), target);
        fields.append(laps, targetLabel);
        return fields;
    }

    createStageActions(index, count, trackKey) {
        const actions = el('div', 'planner-stage-actions');
        for (const [direction, label, title] of [[-1, '↑', 'Move up'], [1, '↓', 'Move down']]) {
            const button = el('button', 'icon-btn', label);
            button.type = 'button';
            button.title = title;
            button.setAttribute('aria-label', title);
            button.dataset.direction = String(direction);
            button.disabled = index + direction < 0 || index + direction >= count;
            actions.appendChild(button);
        }
        actions.appendChild(this.createMoveButton(trackKey));
        return actions;
    }

    renderCards(list) {
        const trackKeys = this.getListTrackKeys(list);
        if (!trackKeys.length) {
            return el('p', 'planner-empty', list === UNUSED_DESTINATION
                ? 'Every track is in use. New tracks from the Mapmaker land here.'
                : 'No tracks here.');
        }
        const grid = el('div', 'track-cards');
        trackKeys.forEach((trackKey, index) => {
            const ground = groundLabel(getTrackGroundKey(trackKey));
            const card = this.previews.createCard(
                'div',
                trackKey,
                getTrackName(trackKey),
                list === DAILY_DESTINATION ? `#${index + 1} · ${ground}` : ground,
            );
            const warnings = this.getTrackWarnings(trackKey);
            if (warnings.length) card.append(el('span', 'planner-warn', warnings.join(' ')));
            card.append(this.createMoveButton(trackKey));
            grid.appendChild(card);
        });
        return grid;
    }

    openMovePicker(trackKey) {
        this.picker = { mode: 'move', trackKey, destination: null };
        this.pickerTitle.textContent = `Move ${getTrackName(trackKey)} to…`;
        this.showPickerChoose();
        this.pickerDialog.showModal();
    }

    openAddPicker() {
        const series = this.getSeries(this.selectedList);
        this.picker = { mode: 'add', trackKey: null, destination: seriesDestination(series.id) };
        this.pickerTitle.textContent = `Add a track to ${series.name}`;
        this.showPickerChoose();
        this.pickerDialog.showModal();
    }

    showPickerChoose() {
        this.pickerChoose.hidden = false;
        this.pickerConfirm.hidden = true;
        this.pickerBackBtn.hidden = true;
        this.pickerConfirmBtn.hidden = true;
        this.pickerSearch.value = '';
        this.renderPickerList();
        this.pickerSearch.focus();
    }

    createPickerButton(name, meta, warning = '') {
        const button = el('button', 'planner-pick-btn');
        button.type = 'button';
        const text = el('span', 'planner-pick-text');
        text.append(el('strong', '', name), el('span', 'planner-nav-meta', meta));
        if (warning) text.append(el('span', 'planner-warn', warning));
        button.appendChild(text);
        return button;
    }

    renderPickerList() {
        const query = this.pickerSearch.value.trim();
        const { mode, trackKey, destination } = this.picker;
        const items = [];
        if (mode === 'move') {
            const current = this.getTrackDestination(trackKey);
            const lists = [DAILY_DESTINATION, UNUSED_DESTINATION, ...this.seriesData.series.map((series) => seriesDestination(series.id))]
                .filter((list) => list !== current && matches(query, this.getListName(list)));
            for (const list of lists) {
                const button = this.createPickerButton(
                    this.getListName(list),
                    this.getListMeta(list),
                );
                button.dataset.pickList = list;
                items.push(button);
            }
        } else {
            if (!query) items.push(el('p', 'field-hint', 'Not used tracks. Search to pick any track.'));
            const trackKeys = (query
                ? Object.keys(TRACK_CATALOG).filter((key) => matches(query, getTrackName(key)))
                : this.getUnusedKeys()
            ).filter((key) => this.getTrackDestination(key) !== destination);
            for (const key of trackKeys) {
                const warnings = this.getTrackWarnings(key);
                const button = this.createPickerButton(getTrackName(key), this.getListName(this.getTrackDestination(key)), warnings.join(' '));
                button.prepend(this.previews.create(key, 'planner-pick-preview'));
                button.dataset.pickTrack = key;
                button.disabled = this.isStageFixed(key);
                if (button.disabled) button.title = 'It is a stage of a live campaign, so it cannot move.';
                items.push(button);
            }
        }
        if (!items.some((item) => item.tagName === 'BUTTON')) items.push(el('p', 'field-hint', 'Nothing matches.'));
        this.pickerList.replaceChildren(...items);
    }

    // Moves that only add a track to Daily or take it out of a hidden campaign need no questions.
    choose(trackKey, destination) {
        const from = this.getTrackDestination(trackKey);
        if (!this.getSeries(destination) && from !== DAILY_DESTINATION) {
            this.pickerDialog.close();
            void this.assign({ trackKey, destination });
            return;
        }
        this.picker = { ...this.picker, trackKey, destination };
        this.showPickerConfirm();
    }

    showPickerConfirm() {
        const { trackKey, destination } = this.picker;
        const series = this.getSeries(destination);
        const name = getTrackName(trackKey);
        const from = this.getTrackDestination(trackKey);
        const fromSeries = this.getSeries(from);
        this.pickerSummary.textContent = series
            ? `${name} becomes ${series.name} Stage ${stageNumber(series.stages.length)}.`
            : destination === DAILY_DESTINATION
                ? `${name} goes on the Daily schedule at position ${this.scheduleKeys.length + 1}.`
                : `${name} becomes Not used.`;

        this.pickerStageFields.hidden = !series;
        if (series) {
            this.pickerLaps.value = '1';
            this.pickerTarget.value = String(suggestRequiredMedals(series));
            this.pickerTarget.disabled = series.stages.length === 0;
        }

        const notes = [];
        if (from === DAILY_DESTINATION) notes.push(['', 'It leaves the Daily schedule and will not appear in future Daily GP days.']);
        if (fromSeries) notes.push(['', `It leaves ${fromSeries.name}. The stages after it move up.`]);
        if (series && seriesIsLive(series)) {
            notes.push(['warn', `${series.name} is live. After this, the stage is fixed: its place, laps, medal target and medal times cannot change.`]);
        }
        const missingMedals = Boolean(series) && Boolean(getMedalRowError(medalTimesFileData[trackKey]));
        if (missingMedals) notes.push(['error', 'A campaign stage needs all four medal times. Set them in the Mapmaker first.']);
        this.pickerNotes.replaceChildren(...notes.map(([kind, text]) => {
            const item = el('li', '', text);
            if (kind) item.dataset.kind = kind;
            return item;
        }));

        this.pickerChoose.hidden = true;
        this.pickerConfirm.hidden = false;
        this.pickerBackBtn.hidden = false;
        this.pickerConfirmBtn.hidden = false;
        this.pickerConfirmBtn.disabled = missingMedals;
        this.pickerConfirmBtn.focus();
    }

    async confirmPicker() {
        const { trackKey, destination } = this.picker;
        const series = this.getSeries(destination);
        this.pickerConfirmBtn.disabled = true;
        const error = await this.assign({
            trackKey,
            destination,
            laps: series ? Number(this.pickerLaps.value) : null,
            requiredMedals: series ? Number(this.pickerTarget.value) : null,
        });
        if (!error) {
            this.pickerDialog.close();
            return;
        }
        const item = el('li', '', error);
        item.dataset.kind = 'error';
        this.pickerNotes.appendChild(item);
        this.pickerConfirmBtn.disabled = false;
    }

    // Returns null on success, or the error message.
    async assign(assignment) {
        const { trackKey, destination } = assignment;
        const name = getTrackName(trackKey);
        const staysInPlace = this.getTrackDestination(trackKey) === destination;
        try {
            const result = await postJson('/__mapmaker/assign-track', assignment);
            this.seriesData = applyTrackSeriesUpdate(this.seriesData, assignment).data;
            applyScheduleDestination(this.scheduleKeys, trackKey, parseTrackDestination(destination));
            const series = this.getSeries(destination);
            this.announce(staysInPlace
                ? `Updated ${name}: ${plural(assignment.laps, 'lap')}, target ${assignment.requiredMedals}.`
                : series
                    ? `${name} is now ${series.name} Stage ${stageNumber(result.stageIndex)}.`
                    : destination === DAILY_DESTINATION
                        ? `${name} is on the Daily schedule at position ${result.scheduleIndex + 1}.`
                        : `${name} is now Not used.`);
            this.render();
            return null;
        } catch (error) {
            console.error(error);
            this.setStatus(error.message, true);
            this.render();
            return error.message;
        }
    }

    async updateStage(row) {
        await this.assign({
            trackKey: row.dataset.trackKey,
            destination: this.selectedList,
            laps: Number(row.querySelector('[data-stage-field="laps"]').value),
            requiredMedals: Number(row.querySelector('[data-stage-field="requiredMedals"]').value),
        });
    }

    async moveStage(trackKey, direction) {
        const series = this.getSeries(this.selectedList);
        try {
            await postJson('/__mapmaker/move-stage', { seriesId: series.id, trackKey, direction });
            this.seriesData = moveSeriesStage(this.seriesData, series.id, trackKey, direction);
            this.announce(`Moved ${getTrackName(trackKey)} ${direction < 0 ? 'up' : 'down'} in ${series.name}.`);
            this.render();
        } catch (error) {
            console.error(error);
            this.setStatus(error.message, true);
        }
    }
}

new CampaignPlannerApp();
