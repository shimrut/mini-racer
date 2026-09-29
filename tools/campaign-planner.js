import { TRACK_CATALOG, TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';
import { TRACK_GROUNDS, getTrackGround } from '../game/track/grounds.js';
import { isLiveGround } from '../game/track/live-grounds.js';
import { TRACKS } from '../game/track/tracks.js';
import seriesFileData from '../game/campaign/series.json' with { type: 'json' };
import medalTimesFileData from '../game/medals/medal-times.json' with { type: 'json' };
import { getCampaignSeriesMinStages, isCampaignSeriesLive } from '../game/campaign/series-rules.js';
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

// A save rewrites files this page imports, so the dev server may reload the page
// right after it. The last status is kept briefly so it shows again after that reload.
const STATUS_KEY = 'campaign-planner:status:v1';
const STATUS_KEEP_MS = 5000;

function getTrackName(trackKey) {
    return TRACK_CATALOG[trackKey]?.name ?? trackKey;
}

function groundLabel(ground) {
    return TRACK_GROUNDS[ground]?.label ?? ground;
}

function seriesStateText(series) {
    if (isCampaignSeriesLive(series)) return 'live';
    if (!isLiveGround(series.ground)) return 'hidden, ground not live';
    return `hidden, ${series.stages.length}/${getCampaignSeriesMinStages(series)} stages`;
}

function stageNumber(index) {
    return String(index).padStart(2, '0');
}

async function postJson(path, body) {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed with status ${response.status}.`);
    return result;
}

class CampaignPlannerApp {
    constructor() {
        this.trackSelect = document.getElementById('track-select');
        this.destinationSelect = document.getElementById('track-destination-select');
        this.seriesStageFields = document.getElementById('series-stage-fields');
        this.seriesStageLabel = document.getElementById('series-stage-label');
        this.seriesLapsSelect = document.getElementById('series-laps-select');
        this.seriesTargetInput = document.getElementById('series-target-input');
        this.seriesStageHint = document.getElementById('series-stage-hint');
        this.saveBtn = document.getElementById('save-use-btn');
        this.statusText = document.getElementById('status-text');
        this.overview = document.getElementById('planner-overview');

        this.seriesData = normalizeCampaignSeriesData(seriesFileData);
        this.scheduleKeys = [...TRACK_SCHEDULE_KEYS];
        const hashKey = decodeURIComponent(window.location.hash.slice(1));

        this.bindEvents();
        this.populateTrackSelect();
        this.loadTrack(TRACK_CATALOG[hashKey] ? hashKey : Object.keys(TRACK_CATALOG)[0]);
        this.restoreStatus();
    }

    bindEvents() {
        this.trackSelect.addEventListener('change', () => this.loadTrack(this.trackSelect.value));
        this.destinationSelect.addEventListener('change', () => {
            this.destination = this.destinationSelect.value;
            this.stageSettings = {};
            this.syncSeriesStageFields();
        });
        this.seriesLapsSelect.addEventListener('change', () => this.updateStageSettings());
        this.seriesTargetInput.addEventListener('change', () => this.updateStageSettings());
        this.saveBtn.addEventListener('click', () => this.saveUse());
        this.overview.addEventListener('click', (event) => {
            const moveButton = event.target.closest?.('button[data-direction]');
            if (moveButton) {
                void this.moveStage(moveButton.dataset.seriesId, moveButton.dataset.trackKey, Number(moveButton.dataset.direction));
                return;
            }
            const trackButton = event.target.closest?.('button[data-track-key]');
            if (trackButton) this.loadTrack(trackButton.dataset.trackKey);
        });
    }

    setStatus(message, isError = false) {
        this.statusText.textContent = message;
        this.statusText.style.color = isError ? '#fda4af' : '';
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

    // The saved stage of a track: { series, stageIndex }, or null.
    getSavedStage(trackKey = this.selectedTrackKey) {
        return findTrackStage(this.seriesData, trackKey);
    }

    getSavedDestination(trackKey) {
        const stage = this.getSavedStage(trackKey);
        if (stage) return seriesDestination(stage.series.id);
        return this.scheduleKeys.includes(trackKey) ? DAILY_DESTINATION : UNUSED_DESTINATION;
    }

    getDestinationSeries(destination) {
        const parsed = parseTrackDestination(destination, this.seriesData);
        return parsed?.type === 'series'
            ? this.seriesData.series.find((series) => series.id === parsed.seriesId) ?? null
            : null;
    }

    getUseLabel(destination) {
        if (destination === DAILY_DESTINATION) return 'Daily Challenge';
        return this.getDestinationSeries(destination)?.name ?? 'Not used';
    }

    populateTrackSelect() {
        this.trackSelect.replaceChildren();
        for (const trackKey of Object.keys(TRACK_CATALOG)) {
            const option = document.createElement('option');
            option.value = trackKey;
            option.textContent = `${getTrackName(trackKey)} · ${this.getUseLabel(this.getSavedDestination(trackKey))}`;
            this.trackSelect.appendChild(option);
        }
    }

    loadTrack(trackKey) {
        this.selectedTrackKey = trackKey;
        this.destination = this.getSavedDestination(trackKey);
        this.stageSettings = {};
        this.trackSelect.value = trackKey;
        window.history.replaceState(null, '', `#${encodeURIComponent(trackKey)}`);
        this.syncDestinationOptions();
        this.syncSeriesStageFields();
        this.renderOverview();
    }

    syncDestinationOptions() {
        const select = this.destinationSelect;
        select.replaceChildren();
        const addOption = (value, label) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
        };
        addOption(DAILY_DESTINATION, 'Daily Challenge');
        for (const series of this.seriesData.series) {
            addOption(seriesDestination(series.id), `Campaign · ${series.name} (${seriesStateText(series)})`);
        }
        addOption(UNUSED_DESTINATION, 'Not used');
        select.value = this.destination;
        const savedStage = this.getSavedStage();
        const locked = Boolean(savedStage && isCampaignSeriesLive(savedStage.series));
        select.disabled = locked;
        select.title = locked
            ? `${savedStage.series.name} is live, so this track stays in it.`
            : '';
    }

    // The stage that the selected track has, or gets when it is saved.
    getPlannedStage() {
        const series = this.getDestinationSeries(this.destination);
        if (!series) return null;
        const saved = this.getSavedStage();
        const existing = saved?.series.id === series.id ? saved : null;
        const stageIndex = existing ? existing.stageIndex : series.stages.length;
        const savedStage = existing ? series.stages[stageIndex] : null;
        return {
            series,
            stageIndex,
            savedStage,
            isNew: !existing,
            fixed: Boolean(existing) && isCampaignSeriesLive(series),
            laps: this.stageSettings.laps ?? savedStage?.laps ?? 1,
            requiredMedals: this.stageSettings.requiredMedals ?? savedStage?.requiredMedals ?? suggestRequiredMedals(series),
        };
    }

    hasChanges(planned = this.getPlannedStage()) {
        if (this.destination !== this.getSavedDestination(this.selectedTrackKey)) return true;
        return Boolean(planned?.savedStage && !planned.fixed && (
            planned.laps !== planned.savedStage.laps
            || planned.requiredMedals !== planned.savedStage.requiredMedals
        ));
    }

    syncSeriesStageFields() {
        const planned = this.getPlannedStage();
        this.saveBtn.disabled = !this.hasChanges(planned);
        this.seriesStageFields.hidden = !planned;
        const notes = [];
        if (planned) {
            const { series, stageIndex, fixed } = planned;
            this.seriesStageLabel.textContent = `${series.name} · Stage ${stageNumber(stageIndex)}${planned.isNew ? ' (new)' : ''}`;
            this.seriesLapsSelect.value = String(planned.laps);
            this.seriesTargetInput.value = String(planned.requiredMedals);
            this.seriesLapsSelect.disabled = fixed;
            this.seriesTargetInput.disabled = fixed || stageIndex === 0;
            const ground = getTrackGround(TRACKS[this.selectedTrackKey]).key;
            if (ground !== series.ground) {
                notes.push(`This track is ${groundLabel(ground)}, but ${series.name} is a ${groundLabel(series.ground)} series.`);
            }
            if (getMedalRowError(medalTimesFileData[this.selectedTrackKey])) {
                notes.push('A Campaign stage needs all four medal times. Set them in the Mapmaker first.');
            }
        }
        this.seriesStageHint.hidden = notes.length === 0;
        this.seriesStageHint.textContent = notes.join(' ');
    }

    updateStageSettings() {
        this.stageSettings = {
            laps: Number(this.seriesLapsSelect.value),
            requiredMedals: Number(this.seriesTargetInput.value),
        };
        this.syncSeriesStageFields();
    }

    renderOverview() {
        const groups = this.seriesData.series.map((series) => this.renderSeriesGroup(series));
        const inSeries = new Set(this.seriesData.series.flatMap((series) => series.stages.map((stage) => stage.trackKey)));
        const unused = Object.keys(TRACK_CATALOG).filter((key) => !this.scheduleKeys.includes(key) && !inSeries.has(key));
        groups.push(
            this.renderTrackGroup('Not used', unused, 'New tracks start here.'),
            this.renderTrackGroup('Daily Challenge', this.scheduleKeys, 'In schedule order.'),
        );
        this.overview.replaceChildren(...groups);
    }

    createGroup(title, detail) {
        const section = document.createElement('section');
        section.className = 'planner-group';
        const head = document.createElement('div');
        head.className = 'panel-head';
        const heading = document.createElement('h2');
        heading.textContent = title;
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = detail;
        head.append(heading, pill);
        section.appendChild(head);
        return section;
    }

    createTrackButton(trackKey) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost-btn planner-track-btn';
        button.dataset.trackKey = trackKey;
        button.dataset.current = String(trackKey === this.selectedTrackKey);
        button.textContent = getTrackName(trackKey);
        return button;
    }

    renderSeriesGroup(series) {
        const section = this.createGroup(series.name, `${groundLabel(series.ground)} · ${seriesStateText(series)}`);
        if (!series.stages.length) {
            const note = document.createElement('p');
            note.className = 'field-hint';
            note.textContent = 'No stages yet.';
            section.appendChild(note);
            return section;
        }
        const live = isCampaignSeriesLive(series);
        const list = document.createElement('ol');
        list.className = 'series-stage-list';
        series.stages.forEach((stage, index) => {
            const item = document.createElement('li');
            const number = document.createElement('span');
            number.textContent = stageNumber(index);
            const settings = document.createElement('span');
            settings.textContent = `${stage.laps} lap${stage.laps === 1 ? '' : 's'} · target ${stage.requiredMedals}`;
            item.append(number, this.createTrackButton(stage.trackKey), settings);
            for (const [direction, label] of [[-1, 'Up'], [1, 'Down']]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ghost-btn';
                button.textContent = label;
                button.dataset.seriesId = series.id;
                button.dataset.trackKey = stage.trackKey;
                button.dataset.direction = String(direction);
                const target = index + direction;
                button.disabled = live || target < 0 || target >= series.stages.length;
                item.appendChild(button);
            }
            list.appendChild(item);
        });
        section.appendChild(list);
        return section;
    }

    renderTrackGroup(title, trackKeys, hint) {
        const section = this.createGroup(title, `${trackKeys.length} tracks`);
        const note = document.createElement('p');
        note.className = 'field-hint';
        note.textContent = trackKeys.length ? hint : 'None.';
        const chips = document.createElement('div');
        chips.className = 'planner-chips';
        chips.append(...trackKeys.map((trackKey) => this.createTrackButton(trackKey)));
        section.append(note, chips);
        return section;
    }

    async saveUse() {
        const trackKey = this.selectedTrackKey;
        const destination = this.destination;
        const planned = this.getPlannedStage();
        if (
            this.getSavedDestination(trackKey) === DAILY_DESTINATION
            && destination !== DAILY_DESTINATION
            && !window.confirm(
                `Move ${getTrackName(trackKey)} off the Daily Challenge schedule? It will stay in the track catalog, but will not appear in future Daily GP days.`,
            )
        ) {
            return;
        }
        if (
            planned?.isNew
            && isCampaignSeriesLive(planned.series)
            && !window.confirm(
                `${planned.series.name} is live. After this save, ${getTrackName(trackKey)} is fixed as Stage ${stageNumber(planned.stageIndex)}: you cannot move it, remove it, or change its laps, medal target or medal times. Continue?`,
            )
        ) {
            return;
        }

        this.saveBtn.disabled = true;
        const assignment = {
            trackKey,
            destination,
            laps: planned && !planned.fixed ? planned.laps : null,
            requiredMedals: planned && !planned.fixed ? planned.requiredMedals : null,
        };
        try {
            const result = await postJson('/__mapmaker/assign-track', assignment);
            this.seriesData = applyTrackSeriesUpdate(this.seriesData, assignment).data;
            applyScheduleDestination(this.scheduleKeys, trackKey, parseTrackDestination(destination));
            const series = this.getDestinationSeries(destination);
            this.announce(series
                ? `Saved ${getTrackName(trackKey)} as ${series.name} Stage ${stageNumber(result.stageIndex)}.`
                : destination === DAILY_DESTINATION
                    ? `Saved ${getTrackName(trackKey)} for Daily Challenge at schedule position ${result.scheduleIndex + 1}.`
                    : `Saved ${getTrackName(trackKey)} as not used.`);
            this.populateTrackSelect();
            this.loadTrack(trackKey);
        } catch (error) {
            console.error(error);
            this.setStatus(`${error.message} Run the Campaign Planner through the local Vite server (npm run mapmaker).`, true);
            this.syncSeriesStageFields();
        }
    }

    async moveStage(seriesId, trackKey, direction) {
        try {
            await postJson('/__mapmaker/move-stage', { seriesId, trackKey, direction });
            this.seriesData = moveSeriesStage(this.seriesData, seriesId, trackKey, direction);
            this.announce(`Moved ${getTrackName(trackKey)} ${direction < 0 ? 'up' : 'down'}.`);
            this.syncSeriesStageFields();
            this.renderOverview();
        } catch (error) {
            console.error(error);
            this.setStatus(`${error.message} Run the Campaign Planner through the local Vite server (npm run mapmaker).`, true);
        }
    }
}

new CampaignPlannerApp();
