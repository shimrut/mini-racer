// The Creator screens next to the track editor: the Daily list, the Campaign
// Planner and the copy of unplayed tracks. The server checks every change.

import { TRACK_GROUNDS, TRACK_GROUND_KEYS } from '../../game/track/grounds.js';
import { isLiveGround } from '../../game/track/live-grounds.js';
import {
    CAMPAIGN_STAGE_MAX_LAPS,
    getRequiredMedalsError,
} from '../../game/campaign/series-rules.js';
import { creatorApi } from './creator-api.js';

const SERIES_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function element(tag, { className, text, attrs } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attrs ?? {})) {
        if (value === false || value === null || value === undefined) continue;
        node.setAttribute(name, value === true ? '' : String(value));
    }
    node.append(...children.filter(Boolean));
    return node;
}

function button(text, onClick, { className, disabled, title } = {}) {
    const node = element('button', { className, text, attrs: { type: 'button', title } });
    node.disabled = Boolean(disabled);
    node.addEventListener('click', onClick);
    return node;
}

function badge(text, kind = '') {
    return element('span', { className: `pill${kind ? ` pill-${kind}` : ''}`, text });
}

function groundLabel(ground) {
    return TRACK_GROUNDS[ground]?.label ?? ground;
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
        ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '';
}

function moveItem(list, from, to) {
    if (to < 0 || to >= list.length) return list;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

// A new series takes its key from its name until the key is typed.
function seriesIdFromName(name) {
    const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base ? `${/^[a-z]/.test(base) ? base : `s-${base}`}-v1`.slice(0, 40) : '';
}

// The medals-needed field shows the typed text, else the saved number.
function seriesMedalsText(stage) {
    if (typeof stage.requiredMedalsText === 'string') return stage.requiredMedalsText;
    return Number.isFinite(stage.requiredMedals) ? String(stage.requiredMedals) : '';
}

// The series as the server stores it. The typed text is only for the field.
function seriesContent(draft) {
    return {
        name: draft.name,
        ground: draft.ground,
        stages: draft.stages.map(({ trackKey, laps, requiredMedals }) => ({ trackKey, laps, requiredMedals })),
    };
}

// The series as the moderator typed it. A newer edit that gives the same
// number ("05" after "5") is still a newer edit.
function seriesTypedContent(draft) {
    return JSON.stringify({ ...seriesContent(draft), id: draft.id,
        typed: draft.stages.map((stage) => stage.requiredMedalsText ?? null) });
}

export class CreatorPanels {
    // `confirm` opens the page's own dialog. Reddit ignores window.confirm.
    constructor({ onOpenTrack, onTracksChanged, setStatus, confirm }) {
        this.onOpenTrack = onOpenTrack;
        this.onTracksChanged = onTracksChanged;
        this.setStatus = setStatus;
        this.confirm = confirm;
        this.dailyRoot = document.getElementById('creator-daily-view');
        this.seriesRoot = document.getElementById('creator-series-view');
        this.copyRoot = document.getElementById('creator-copy-view');
        this.daily = null;
        this.dailyKeys = [];
        this.dailyDirty = false;
        this.seriesView = null;
        this.selectedSeriesId = null;
        this.seriesDraft = null;
        this.seriesDirty = false;
        this.busy = false;
        this.seriesDestructive = false;
        this.seriesSavingDraft = null;
        this.dailyLoading = false;
        this.seriesLoading = false;
        this.writeGeneration = 0;
        this.dailySaveError = null;
        this.seriesSaveError = null;
        this.copyError = null;
        this.copyView = null;
        this.copyLoading = false;
        // Showing a tab never asks the server. The Creator loads every tab
        // when it opens, and a change reloads the tabs it affects at once,
        // in the background. A reload that must wait for a write waits here.
        this.pendingRefresh = new Set();
    }

    // The editor reads every tab when it opens the Creator. Those answers
    // fill the tabs, unless a tab has changed since the read started.
    receiveViews({ daily, seriesView, copyView, generation }) {
        if (generation !== this.writeGeneration || this.busy) return;
        if (daily && !this.dailyLoading && !this.dailyDirty) {
            this.daily = daily;
            this.dailyKeys = [...daily.schedule.keys];
            this.renderDaily();
        }
        if (seriesView && !this.seriesLoading) {
            this.seriesView = seriesView;
            if (this.seriesDirty) this.renderSeries();
            else void this.selectSeries(this.selectedSeriesId, { force: true });
        }
        if (copyView && !this.copyLoading) {
            this.copyView = copyView;
            this.renderCopy();
        }
    }

    // Reloads these tabs now, or after the write that is running.
    refresh(...tabs) {
        tabs.forEach((tab) => this.pendingRefresh.add(tab));
        this.flushRefresh();
    }

    // A track was saved or deleted: its readiness and places can change.
    refreshAll() {
        this.refresh('daily', 'campaign', 'copy');
    }

    flushRefresh() {
        if (this.busy) return;
        const loaders = {
            daily: [this.dailyLoading, () => this.loadDaily()],
            campaign: [this.seriesLoading, () => this.loadSeries()],
            copy: [this.copyLoading, () => this.loadCopy()],
        };
        for (const tab of [...this.pendingRefresh]) {
            const [loading, load] = loaders[tab];
            // A running load flushes again when it ends.
            if (loading) continue;
            this.pendingRefresh.delete(tab);
            void load();
        }
    }

    confirmDiscardSeries() {
        return this.confirm({
            title: 'Discard changes?',
            message: 'Discard the unsaved changes to this series?',
            confirmLabel: 'Discard',
            danger: true,
        });
    }

    hasUnsavedChanges() {
        return this.busy || this.dailyDirty || this.seriesDirty;
    }

    // ---- Daily list ----

    async loadDaily() {
        if (this.dailyLoading) {
            this.pendingRefresh.add('daily');
            return;
        }
        this.dailyLoading = true;
        const generation = this.writeGeneration;
        // A reload keeps the earlier list on screen until the answer comes.
        if (!this.daily) this.dailyRoot.replaceChildren(element('p', { className: 'field-hint', text: 'Loading the Daily list…' }));
        try {
            const daily = await creatorApi.readDaily();
            if (generation !== this.writeGeneration || this.dailyDirty) {
                if (this.daily) this.renderDaily();
                return;
            }
            this.daily = daily;
            this.dailyKeys = [...this.daily.schedule.keys];
            this.dailyDirty = false;
            this.renderDaily();
        } catch (error) {
            // A failed reload keeps the list that is on screen.
            if (!this.daily) {
                this.dailyRoot.replaceChildren(
                    element('p', { className: 'creator-error', text: `Could not load the Daily list: ${error.message}` }),
                    button('Try again', () => this.loadDaily()),
                );
            }
        } finally {
            this.dailyLoading = false;
            this.flushRefresh();
        }
    }

    renderDaily() {
        const view = this.daily;
        const trackByKey = new Map(view.tracks.map((track) => [track.key, track]));
        const latest = view.latestTrackKey;
        const inList = new Set(this.dailyKeys);
        const head = element('div', { className: 'creator-panel-head' }, [
            element('h2', { text: 'Daily list' }),
            badge(view.schedule.source === 'stored' ? 'In Redis' : 'App list', view.schedule.source === 'stored' ? 'ok' : 'warn'),
            button('Save', () => this.saveDaily(), { className: 'primary-btn', disabled: !this.dailyDirty || this.busy }),
            button('Undo changes', () => {
                this.dailyKeys = [...view.schedule.keys];
                this.dailyDirty = false;
                this.renderDaily();
            }, { disabled: !this.dailyDirty || this.busy }),
        ]);
        const latestTrack = latest ? trackByKey.get(latest) : null;
        const intro = element('p', {
            className: 'field-hint',
            text: latestTrack
                ? `Latest Daily: ${latestTrack.name}. The next Daily is the next track after it.`
                : 'The Daily goes down this list, then starts again at the top.',
        });

        const rows = this.dailyKeys.map((key, index) => {
            const track = trackByKey.get(key) ?? { key, name: key, played: false, ready: false, liveGround: true };
            const badges = [
                key === latest ? badge('Latest', 'ok') : null,
                track.played && key !== latest ? badge('Played') : null,
                !track.liveGround ? badge('Held back', 'warn') : null,
                !track.ready ? badge('Not ready', 'danger') : null,
                track.source !== 'app' ? badge('Redis') : null,
            ];
            const name = track.source !== 'app'
                ? button(track.name, () => this.onOpenTrack(key), { className: 'creator-link' })
                : element('span', { className: 'creator-row-name', text: track.name });
            return element('li', { className: 'creator-row' }, [
                element('span', { className: 'creator-row-index', text: String(index + 1) }),
                name,
                element('span', { className: 'creator-row-badges' }, badges),
                element('span', { className: 'creator-row-actions' }, [
                    button('↑', () => this.moveDaily(index, index - 1), { disabled: index === 0, title: 'Move up' }),
                    button('↓', () => this.moveDaily(index, index + 1), {
                        disabled: index === this.dailyKeys.length - 1,
                        title: 'Move down',
                    }),
                    button('✕', () => this.removeDaily(index), {
                        disabled: key === latest,
                        title: key === latest ? 'The latest Daily stays in the list.' : 'Take out of the list',
                    }),
                ]),
            ]);
        });

        const candidates = view.tracks
            .filter((track) => !inList.has(track.key) && track.ready && track.liveGround && !track.series)
            .sort((a, b) => a.name.localeCompare(b.name));
        const select = element('select', { attrs: { 'aria-label': 'Track to add' } }, [
            element('option', { text: candidates.length ? 'Choose a track' : 'No track is ready', attrs: { value: '' } }),
            ...candidates.map((track) => element('option', { text: track.name, attrs: { value: track.key } })),
        ]);
        const add = (asNext) => {
            const key = select.value;
            if (!key) return;
            const latestIndex = this.dailyKeys.indexOf(latest);
            const at = asNext && latestIndex >= 0 ? latestIndex + 1 : this.dailyKeys.length;
            this.dailyKeys = [...this.dailyKeys.slice(0, at), key, ...this.dailyKeys.slice(at)];
            this.dailyDirty = true;
            this.renderDaily();
        };
        const adder = element('div', { className: 'creator-adder' }, [
            select,
            button('Add as next Daily', () => add(true), { disabled: !candidates.length }),
            button('Add at the end', () => add(false), { disabled: !candidates.length }),
        ]);
        this.dailyRoot.replaceChildren(head, intro,
            ...(this.dailySaveError ? [element('p', { className: 'creator-error', text: this.dailySaveError })] : []),
            adder, element('ol', { className: 'creator-list' }, rows));
    }

    moveDaily(from, to) {
        this.dailyKeys = moveItem(this.dailyKeys, from, to);
        this.dailyDirty = true;
        this.renderDaily();
    }

    removeDaily(index) {
        this.dailyKeys = this.dailyKeys.filter((_, entry) => entry !== index);
        this.dailyDirty = true;
        this.renderDaily();
    }

    async saveDaily() {
        if (this.busy) return;
        const keys = [...this.dailyKeys];
        const baseRevision = this.daily.schedule.revision;
        this.dailySaveError = null;
        this.busy = true;
        this.writeGeneration += 1;
        this.renderDaily();
        try {
            this.daily = await creatorApi.saveDaily(keys, baseRevision);
            if (JSON.stringify(this.dailyKeys) === JSON.stringify(keys)) {
                this.dailyKeys = [...this.daily.schedule.keys];
            }
            this.dailyDirty = JSON.stringify(this.dailyKeys) !== JSON.stringify(this.daily.schedule.keys);
            // The Campaign shows which tracks are in the Daily list, and the
            // copy shows whether the list is in Redis.
            this.refresh('campaign', 'copy');
            this.setStatus(this.dailyDirty
                ? 'Saved the earlier Daily list. Newer changes are still unsaved.' : 'Saved the Daily list.');
        } catch (error) {
            this.dailySaveError = `Could not save the Daily list: ${error.message}`;
            this.setStatus(this.dailySaveError, true);
        } finally {
            this.busy = false;
            this.writeGeneration += 1;
            this.renderDaily();
            this.flushRefresh();
        }
    }

    // ---- Campaign Planner ----

    async loadSeries(selectId = this.selectedSeriesId) {
        if (this.seriesLoading) {
            this.pendingRefresh.add('campaign');
            return;
        }
        this.seriesLoading = true;
        const generation = this.writeGeneration;
        const selectedId = this.selectedSeriesId;
        const draft = this.seriesDraft;
        if (!this.seriesView) this.seriesRoot.replaceChildren(element('p', { className: 'field-hint', text: 'Loading the Campaign…' }));
        try {
            const seriesView = await creatorApi.readSeries();
            if (generation !== this.writeGeneration) {
                if (this.seriesView) this.renderSeries();
                return;
            }
            this.seriesView = seriesView;
            if (this.seriesDirty || this.seriesDraft !== draft || this.selectedSeriesId !== selectedId) {
                this.renderSeries();
                return;
            }
            await this.selectSeries(selectId, { force: true });
        } catch (error) {
            if (!this.seriesView) {
                this.seriesRoot.replaceChildren(
                    element('p', { className: 'creator-error', text: `Could not load the Campaign: ${error.message}` }),
                    button('Try again', () => this.loadSeries()),
                );
            }
        } finally {
            this.seriesLoading = false;
            this.flushRefresh();
        }
    }

    async selectSeries(seriesId, { force = false } = {}) {
        if (this.seriesDestructive) return;
        if (!force && this.seriesDirty && !await this.confirmDiscardSeries()) return;
        if (this.seriesDestructive) return;
        const stored = this.seriesView.series.find((series) => series.id === seriesId) ?? null;
        this.selectedSeriesId = stored ? stored.id : null;
        this.seriesDraft = stored ? structuredClone(stored) : null;
        this.seriesDirty = false;
        this.renderSeries();
    }

    async startNewSeries() {
        if (this.seriesDestructive) return;
        if (this.seriesDirty && !await this.confirmDiscardSeries()) return;
        if (this.seriesDestructive) return;
        this.selectedSeriesId = null;
        this.seriesDraft = {
            id: '',
            name: '',
            ground: 'tarmac',
            stages: [],
            status: 'draft',
            publishedStageCount: 0,
            revision: 0,
            isNew: true,
        };
        this.seriesDirty = true;
        this.renderSeries();
    }

    renderSeries() {
        const view = this.seriesView;
        const list = element('ul', { className: 'creator-series-list' }, [
            ...view.series.map((series) => element('li', {}, [
                button(series.name, () => this.selectSeries(series.id), {
                    className: `creator-series-pick${series.id === this.selectedSeriesId ? ' is-current' : ''}`,
                }),
                badge(series.status === 'published' ? 'Live' : 'Draft', series.status === 'published' ? 'ok' : ''),
                badge(`${series.stages.length} stages`),
            ])),
            ...view.appSeries.map((series) => element('li', { className: 'creator-series-app' }, [
                element('span', { text: series.name }),
                badge(series.live ? 'Live in the app' : 'In the app'),
                badge(groundLabel(series.ground)),
            ])),
        ]);
        const side = element('div', { className: 'creator-series-side' }, [
            element('div', { className: 'creator-panel-head' }, [
                element('h2', { text: 'Campaign' }),
                button('New series', () => this.startNewSeries()),
            ]),
            list,
            element('p', {
                className: 'field-hint',
                text: 'A series in the app changes only with an app release. Copy a hidden one to Redis on the Copy screen.',
            }),
        ]);
        const draft = this.seriesDraft;
        const structure = this.seriesEditorStructure();
        const refs = this.seriesEditorRefs;
        if (draft && refs?.draft === draft && refs.structure === structure && refs.root.isConnected
            && refs.stages.length === draft.stages.length
            && refs.stages.every((entry, index) => entry.stage === draft.stages[index])) {
            // The editor's layout is the same: update it in place, so the field
            // being typed in keeps its text and focus, and a button under the
            // pointer stays.
            refs.side.replaceWith(side);
            refs.side = side;
            this.syncSeriesEditor();
        } else {
            const focus = this.captureSeriesFocus();
            const editor = this.renderSeriesEditor();
            this.seriesRoot.replaceChildren(side, editor);
            if (this.seriesEditorRefs) Object.assign(this.seriesEditorRefs, { root: editor, side, structure });
            this.restoreSeriesFocus(focus);
        }
        if (this.seriesDestructive) {
            this.seriesRoot.querySelectorAll('button, input, select').forEach((control) => {
                control.disabled = true;
            });
        }
    }

    // What the editor shows apart from the typed values. When it changes, the
    // editor is built again.
    seriesEditorStructure() {
        const draft = this.seriesDraft;
        if (!draft || !this.seriesView) return 'none';
        const trackByKey = new Map(this.seriesView.tracks.map((track) => [track.key, track]));
        return JSON.stringify({
            isNew: Boolean(draft.isNew),
            status: draft.status,
            fixed: draft.publishedStageCount ?? 0,
            ground: draft.ground,
            stages: draft.stages.map((stage) => {
                const track = trackByKey.get(stage.trackKey);
                return [stage.trackKey, stage.laps, track?.name, track?.ready, track?.ground, track?.source];
            }),
            candidates: this.seriesCandidates(draft).map((track) => track.key),
            error: this.seriesSaveError?.draft === draft ? this.seriesSaveError.message : null,
            destructive: this.seriesDestructive,
        });
    }

    seriesCandidates(draft) {
        const inSeries = new Set(draft.stages.map((stage) => stage.trackKey));
        return this.seriesView.tracks
            .filter((track) => track.ready && !inSeries.has(track.key) && track.ground === draft.ground
                && (!track.usedBy || track.usedBy === draft.id))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // A rebuild gives focus back to the same field of the same draft.
    captureSeriesFocus() {
        const active = document.activeElement;
        if (!active || !this.seriesRoot.contains(active) || !active.dataset?.field) return null;
        let start = null;
        let end = null;
        try {
            start = active.selectionStart;
            end = active.selectionEnd;
        } catch {
            // A number field has no text selection.
        }
        return { draft: this.seriesDraft, field: active.dataset.field, start, end };
    }

    restoreSeriesFocus(focus) {
        if (!focus || focus.draft !== this.seriesDraft) return;
        const target = this.seriesRoot.querySelector(`[data-field="${focus.field}"]`);
        if (!target || target.disabled) return;
        target.focus();
        if (focus.start === null || focus.start === undefined) return;
        try {
            target.setSelectionRange(focus.start, focus.end);
        } catch {
            // A number field has no text selection.
        }
    }

    // A typed value is in the draft at once. Only the parts that depend on it
    // change; the fields stay, so the text and the focus stay.
    markSeriesEdited() {
        this.seriesDirty = true;
        this.syncSeriesEditor();
    }

    syncSeriesEditor() {
        const refs = this.seriesEditorRefs;
        const draft = this.seriesDraft;
        if (!refs || !draft || refs.draft !== draft) return;
        const fixed = draft.publishedStageCount ?? 0;
        const unpublished = draft.stages.length - fixed;
        refs.heading.textContent = draft.name || 'New series';
        if (document.activeElement !== refs.nameInput && refs.nameInput.value !== draft.name) {
            refs.nameInput.value = draft.name;
        }
        if (document.activeElement !== refs.idInput && refs.idInput.value !== draft.id) {
            refs.idInput.value = draft.id;
        }
        refs.idInput.disabled = !draft.isNew || this.seriesSavingDraft === draft;
        refs.saveButton.disabled = !this.seriesDirty || this.busy;
        refs.liveButton.disabled = this.seriesDirty || this.busy || draft.isNew || unpublished <= 0;
        refs.deleteButton.disabled = this.busy || draft.isNew || fixed > 0;
        refs.stages.forEach(({ stage, medals, error }, index) => {
            const text = seriesMedalsText(stage);
            if (document.activeElement !== medals && medals.value !== text) medals.value = text;
            const message = index < fixed ? null : getRequiredMedalsError(
                stage.requiredMedals,
                index,
                index > 0 ? draft.stages[index - 1].requiredMedals : 0,
            );
            error.textContent = message ?? '';
            error.hidden = !message;
        });
    }

    renderSeriesEditor() {
        const draft = this.seriesDraft;
        if (!draft) {
            this.seriesEditorRefs = null;
            return element('div', { className: 'creator-series-editor' }, [
                element('p', { className: 'field-hint', text: 'Choose a series, or start a new one.' }),
            ]);
        }
        const tracks = this.seriesView.tracks;
        const trackByKey = new Map(tracks.map((track) => [track.key, track]));
        const fixed = draft.publishedStageCount ?? 0;
        const changed = () => {
            this.seriesDirty = true;
            this.renderSeries();
        };

        const nameInput = element('input', { attrs: {
            type: 'text', maxlength: 40, value: draft.name, 'data-field': 'series-name',
        } });
        nameInput.addEventListener('input', () => {
            draft.name = nameInput.value;
            if (draft.isNew && !draft.idTouched && this.seriesSavingDraft !== draft) {
                draft.id = seriesIdFromName(nameInput.value);
            }
            this.markSeriesEdited();
        });
        const idInput = element('input', { attrs: { type: 'text', maxlength: 40, value: draft.id,
            'data-field': 'series-id', disabled: !draft.isNew || this.seriesSavingDraft === draft } });
        idInput.addEventListener('input', () => {
            draft.id = idInput.value.trim();
            draft.idTouched = true;
            this.markSeriesEdited();
        });
        const groundSelect = element('select', { attrs: { disabled: fixed > 0 } }, TRACK_GROUND_KEYS.map((key) => (
            element('option', {
                text: `${groundLabel(key)}${isLiveGround(key) ? '' : ' (held back)'}`,
                attrs: { value: key, selected: key === draft.ground },
            })
        )));
        groundSelect.addEventListener('change', () => {
            draft.ground = groundSelect.value;
            changed();
        });

        const stageRefs = [];
        const stageRows = draft.stages.map((stage, index) => {
            const track = trackByKey.get(stage.trackKey) ?? { name: stage.trackKey, ready: false };
            const locked = index < fixed;
            const laps = element('select', { attrs: { disabled: locked, 'aria-label': 'Laps' } },
                Array.from({ length: CAMPAIGN_STAGE_MAX_LAPS }, (_, lap) => element('option', {
                    text: `${lap + 1} ${lap === 0 ? 'lap' : 'laps'}`,
                    attrs: { value: lap + 1, selected: stage.laps === lap + 1 },
                })));
            laps.addEventListener('change', () => {
                stage.laps = Number(laps.value);
                changed();
            });
            const medals = element('input', {
                attrs: {
                    type: 'number', min: 0, step: 1, value: seriesMedalsText(stage),
                    disabled: locked || index === 0, 'aria-label': 'Medals needed',
                    'data-field': `stage-medals:${stage.trackKey}`,
                },
            });
            // The typed text stays as it is, so a blank field stays blank.
            medals.addEventListener('input', () => {
                stage.requiredMedalsText = medals.value;
                stage.requiredMedals = medals.value.trim() === '' ? null : Number(medals.value);
                this.markSeriesEdited();
            });
            const message = locked ? null : getRequiredMedalsError(
                stage.requiredMedals,
                index,
                index > 0 ? draft.stages[index - 1].requiredMedals : 0,
            );
            const error = element('p', { className: 'creator-row-error', text: message ?? '' });
            error.hidden = !message;
            stageRefs.push({ stage, medals, error });
            return element('li', { className: 'creator-row' }, [
                element('span', { className: 'creator-row-index', text: String(index + 1) }),
                track.source && track.source !== 'app'
                    ? button(track.name, () => this.onOpenTrack(stage.trackKey), { className: 'creator-link' })
                    : element('span', { className: 'creator-row-name', text: track.name }),
                element('span', { className: 'creator-row-badges' }, [
                    locked ? badge('Live', 'ok') : null,
                    !track.ready ? badge('Not ready', 'danger') : null,
                    track.ground && track.ground !== draft.ground ? badge('Other ground', 'danger') : null,
                ]),
                element('label', { className: 'creator-inline-field' }, [laps]),
                element('label', { className: 'creator-inline-field' }, [
                    element('span', { text: 'Medals' }),
                    medals,
                ]),
                element('span', { className: 'creator-row-actions' }, [
                    button('↑', () => {
                        draft.stages = moveItem(draft.stages, index, index - 1);
                        changed();
                    }, { disabled: locked || index - 1 < fixed, title: 'Move up' }),
                    button('↓', () => {
                        draft.stages = moveItem(draft.stages, index, index + 1);
                        changed();
                    }, { disabled: locked || index === draft.stages.length - 1, title: 'Move down' }),
                    button('✕', () => {
                        draft.stages = draft.stages.filter((_, entry) => entry !== index);
                        changed();
                    }, { disabled: locked, title: 'Take out of the series' }),
                ]),
                error,
            ]);
        });

        const candidates = this.seriesCandidates(draft);
        const addSelect = element('select', { attrs: { 'aria-label': 'Track to add' } }, [
            element('option', { text: candidates.length ? 'Choose a track' : 'No free track on this ground', attrs: { value: '' } }),
            ...candidates.map((track) => element('option', {
                text: `${track.name}${track.ready ? '' : ' (not ready)'}`,
                attrs: { value: track.key },
            })),
        ]);
        const addStage = () => {
            if (!addSelect.value) return;
            const previous = Number(draft.stages.at(-1)?.requiredMedals);
            draft.stages = [...draft.stages, {
                trackKey: addSelect.value,
                laps: 1,
                requiredMedals: draft.stages.length ? (Number.isFinite(previous) ? previous : 0) + 2 : 0,
            }];
            changed();
        };

        const unpublished = draft.stages.length - fixed;
        const heading = element('h2', { text: draft.name || 'New series' });
        const saveButton = button('Save', () => this.saveSeries(), {
            className: 'primary-btn',
            disabled: !this.seriesDirty || this.busy,
        });
        const liveButton = button(fixed ? 'Make new stages live' : 'Make live', () => this.publishSeries(), {
            disabled: this.seriesDirty || this.busy || draft.isNew || unpublished <= 0,
            title: 'Players see the series. The stages cannot change after this.',
        });
        const deleteButton = button('Delete', () => this.deleteSeries(), {
            className: 'danger-btn',
            disabled: this.busy || draft.isNew || fixed > 0,
        });
        this.seriesEditorRefs = {
            draft, heading, nameInput, idInput, saveButton, liveButton, deleteButton, stages: stageRefs,
        };
        return element('div', { className: 'creator-series-editor' }, [
            element('div', { className: 'creator-panel-head' }, [
                heading,
                badge(draft.status === 'published' ? 'Live' : 'Draft', draft.status === 'published' ? 'ok' : ''),
                saveButton,
                liveButton,
                deleteButton,
            ]),
            this.seriesSaveError?.draft === draft
                ? element('p', { className: 'creator-error', text: this.seriesSaveError.message }) : null,
            element('div', { className: 'creator-series-fields' }, [
                element('label', { className: 'field' }, [element('span', { text: 'Name' }), nameInput]),
                element('label', { className: 'field' }, [element('span', { text: 'Key' }), idInput]),
                element('label', { className: 'field' }, [element('span', { text: 'Ground' }), groundSelect]),
            ]),
            fixed ? element('p', {
                className: 'field-hint',
                text: `The first ${fixed} stages are live, so they cannot change. New stages go after them.`,
            }) : null,
            !isLiveGround(draft.ground) ? element('p', {
                className: 'field-hint',
                text: 'This ground is held back. The series can go live only after an app release.',
            }) : null,
            element('ol', { className: 'creator-list' }, stageRows),
            element('div', { className: 'creator-adder' }, [
                addSelect,
                button('Add stage', addStage, { disabled: !candidates.length }),
            ]),
        ]);
    }

    async saveSeries() {
        if (this.busy) return;
        const draft = this.seriesDraft;
        if (!SERIES_ID_RE.test(draft.id)) {
            this.setStatus('Give the series a key of small letters, digits and dashes.', true);
            return;
        }
        const seriesId = draft.id;
        const snapshot = structuredClone(seriesContent(draft));
        const typedAtStart = seriesTypedContent(draft);
        const baseRevision = draft.isNew ? 0 : draft.revision;
        this.seriesSavingDraft = draft;
        this.seriesSaveError = null;
        this.busy = true;
        this.writeGeneration += 1;
        this.renderSeries();
        try {
            const { series } = await creatorApi.saveSeries(seriesId, { ...snapshot, baseRevision });
            this.seriesView.series = [
                ...this.seriesView.series.filter((entry) => entry.id !== series.id), series,
            ];
            const assigned = new Set(series.stages.map((stage) => stage.trackKey));
            this.seriesView.tracks = this.seriesView.tracks.map((track) => ({ ...track,
                usedBy: assigned.has(track.key) ? series.id : track.usedBy === series.id ? null : track.usedBy,
            }));
            // The Daily list shows which tracks are Campaign stages.
            this.refresh('daily', 'copy');
            if (this.seriesDraft === draft) {
                const unchanged = seriesTypedContent(draft) === typedAtStart;
                this.selectedSeriesId = series.id;
                // The draft keeps its identity, so the field being typed in
                // keeps its focus. Newer edits stay in it.
                if (unchanged) {
                    const { stages, ...fields } = structuredClone(series);
                    Object.assign(draft, fields);
                    delete draft.isNew;
                    delete draft.idTouched;
                    const sameStages = stages.length === draft.stages.length
                        && stages.every((stage, index) => stage.trackKey === draft.stages[index].trackKey);
                    if (sameStages) {
                        // The stage fields keep their stage objects.
                        stages.forEach((stage, index) => {
                            Object.assign(draft.stages[index], stage);
                            delete draft.stages[index].requiredMedalsText;
                        });
                    } else {
                        draft.stages = stages;
                    }
                } else {
                    Object.assign(draft, { id: series.id, isNew: false, revision: series.revision,
                        status: series.status, publishedStageCount: series.publishedStageCount });
                }
                this.seriesDirty = !unchanged;
                this.setStatus(unchanged ? `Saved ${series.name}.`
                    : `Saved the earlier changes to ${series.name}. Newer changes are still unsaved.`);
            } else this.setStatus(`Saved ${series.name}.`);
        } catch (error) {
            this.seriesSaveError = { draft, message: `Could not save the series: ${error.message}` };
            this.setStatus(this.seriesSaveError.message, true);
        } finally {
            this.busy = false;
            this.seriesSavingDraft = null;
            this.writeGeneration += 1;
            if (this.seriesView) this.renderSeries();
            this.flushRefresh();
        }
    }

    async publishSeries() {
        if (this.busy) return;
        const draft = this.seriesDraft;
        if (!await this.confirm({
            title: 'Make the series live?',
            message: `Make ${draft.name} live? Players see it at once, and its stages cannot change after this.`,
            confirmLabel: 'Make live',
        })) return;
        if (this.busy || this.seriesDraft !== draft) return;
        this.busy = true;
        this.seriesDestructive = true;
        this.seriesSaveError = null;
        this.writeGeneration += 1;
        this.renderSeries();
        try {
            const { series } = await creatorApi.publishSeries(draft.id, draft.revision);
            this.setStatus(`${series.name} is live.`);
            this.refresh('daily', 'copy');
            this.seriesDestructive = false;
            await this.loadSeries(series.id);
            this.onTracksChanged();
        } catch (error) {
            this.seriesSaveError = { draft, message: `Could not make the series live: ${error.message}` };
            this.setStatus(this.seriesSaveError.message, true);
        } finally {
            this.busy = false;
            this.seriesDestructive = false;
            this.writeGeneration += 1;
            if (this.seriesView) this.renderSeries();
            this.flushRefresh();
        }
    }

    async deleteSeries() {
        if (this.busy) return;
        const draft = this.seriesDraft;
        if (!await this.confirm({
            title: 'Delete the draft?',
            message: `Delete the draft ${draft.name}? You cannot undo this.`,
            confirmLabel: 'Delete',
            danger: true,
        })) return;
        if (this.busy || this.seriesDraft !== draft) return;
        this.busy = true;
        this.seriesDestructive = true;
        this.seriesSaveError = null;
        this.writeGeneration += 1;
        this.renderSeries();
        try {
            await creatorApi.deleteSeries(draft.id, draft.revision);
            this.setStatus(`Deleted ${draft.name}.`);
            this.refresh('daily', 'copy');
            this.seriesDirty = false;
            this.seriesDestructive = false;
            await this.loadSeries(null);
        } catch (error) {
            this.seriesSaveError = { draft, message: `Could not delete the series: ${error.message}` };
            this.setStatus(this.seriesSaveError.message, true);
        } finally {
            this.busy = false;
            this.seriesDestructive = false;
            this.writeGeneration += 1;
            if (this.seriesView) this.renderSeries();
            this.flushRefresh();
        }
    }

    // ---- Copies into Redis ----
    // Unplayed tracks, played Dailies and the live Campaign each have their
    // own copy. The two copies of played tracks write locked tracks.

    async loadCopy() {
        if (this.copyLoading) {
            this.pendingRefresh.add('copy');
            return;
        }
        this.copyLoading = true;
        if (!this.copyView) this.copyRoot.replaceChildren(element('p', { className: 'field-hint', text: 'Checking what can be copied…' }));
        try {
            this.copyView = await creatorApi.readMigration();
            this.renderCopy();
        } catch (error) {
            if (this.copyView) {
                this.renderCopy();
            } else {
                this.copyRoot.replaceChildren(
                    element('p', { className: 'creator-error', text: `Could not check the copy: ${error.message}` }),
                    button('Try again', () => this.loadCopy()),
                );
            }
        } finally {
            this.copyLoading = false;
            this.flushRefresh();
        }
    }

    copySection(kind, { title, lines, note, label, empty, report, copiedText }) {
        const error = this.copyError?.kind === kind ? this.copyError.message : null;
        const failed = report?.failed ?? [];
        return element('section', { className: 'creator-copy-section' }, [
            element('h3', { text: title }),
            element('ul', { className: 'creator-copy-lines' }, lines.filter(Boolean).map((line) => element('li', { text: line }))),
            note ? element('p', { className: 'field-hint', text: note }) : null,
            button(label, () => this.runCopy(kind), { className: 'primary-btn', disabled: this.busy || empty }),
            error ? element('p', { className: 'creator-error', text: error }) : null,
            report ? element('p', {
                className: 'field-hint',
                text: `Last copy: ${formatDate(report.ranAt)} by u/${report.ranBy}. ${copiedText(report)}${failed.length ? `, ${failed.length} failed` : ''}.`,
            }) : null,
            failed.length ? element('ul', { className: 'creator-copy-lines' }, failed.map((failure) => (
                element('li', { className: 'creator-error', text: `${failure.key}: ${failure.error}` })
            ))) : null,
        ]);
    }

    renderCopy() {
        const { report, preview, playedDailies = {}, liveCampaign = {} } = this.copyView ?? {};
        const seriesPreview = preview?.extra?.series;
        const played = playedDailies.preview;
        const campaign = liveCampaign.preview;
        const lockedNote = 'The copies are locked: nobody can change a raced track.';
        this.copyRoot.replaceChildren(
            element('div', { className: 'creator-panel-head' }, [element('h2', { text: 'Copy to Redis' })]),
            element('p', {
                className: 'field-hint',
                text: 'Each copy moves app tracks into Redis. The app keeps its own tracks until a later release removes them.',
            }),
            this.copySection('unplayed', {
                title: 'Unplayed tracks',
                lines: [
                    `${preview?.copied?.length ?? 0} unplayed tracks to copy.`,
                    preview?.dailyList === 'would-copy' ? 'The Daily list is copied too.' : 'The Daily list is in Redis already.',
                    seriesPreview ? `${seriesPreview.copied?.length ?? 0} hidden series to copy as drafts.` : null,
                ],
                note: 'You can change these copies here.',
                label: 'Copy unplayed',
                empty: !preview?.copied?.length && preview?.dailyList !== 'would-copy' && !seriesPreview?.copied?.length,
                report,
                copiedText: (last) => `${last.copied.length} tracks copied`,
            }),
            this.copySection('played-dailies', {
                title: 'Played Dailies',
                lines: [
                    `${played?.copied?.length ?? 0} past Daily tracks to copy.`,
                    played?.waiting?.length ? `${played.waiting.length} wait until players can no longer race their Daily.` : null,
                    played?.alreadyStored?.length ? `${played.alreadyStored.length} are in Redis already.` : null,
                ],
                note: lockedNote,
                label: 'Copy played Dailies',
                empty: !played?.copied?.length,
                report: playedDailies.report,
                copiedText: (last) => `${last.copied.length} tracks copied`,
            }),
            this.copySection('live-campaign', {
                title: 'Live Campaign',
                lines: [
                    `${campaign?.copied?.length ?? 0} live series to copy, with ${campaign?.tracks?.length ?? 0} stage tracks.`,
                    campaign?.alreadyStored?.length ? `${campaign.alreadyStored.length} live series are in Redis already.` : null,
                ],
                note: lockedNote,
                label: 'Copy live Campaign',
                empty: !campaign?.copied?.length,
                report: liveCampaign.report,
                copiedText: (last) => `${last.copied.length} series and ${last.tracks?.length ?? 0} tracks copied`,
            }),
        );
    }

    async runCopy(kind = 'unplayed') {
        if (this.busy) return;
        const copy = {
            unplayed: {
                question: { title: 'Copy to Redis?', message: 'Copy the unplayed tracks to Redis now?' },
                running: 'Copying the unplayed tracks…',
                run: () => creatorApi.runMigration(),
            },
            'played-dailies': {
                question: { title: 'Copy played Dailies?', message: 'Copy the tracks of past Dailies to Redis now? The copies are locked.' },
                running: 'Copying the played Dailies…',
                run: () => creatorApi.runPlayedDailyCopy(),
            },
            'live-campaign': {
                question: { title: 'Copy the live Campaign?', message: 'Copy the live Campaign series and their tracks to Redis now? The copies are locked.' },
                running: 'Copying the live Campaign…',
                run: () => creatorApi.runLiveCampaignCopy(),
            },
        }[kind];
        if (!await this.confirm({ ...copy.question, confirmLabel: 'Copy' })) return;
        if (this.busy) return;
        this.busy = true;
        this.copyError = null;
        this.writeGeneration += 1;
        // The result appears on this screen: the status line is on the Tracks screen.
        this.copyRoot.replaceChildren(element('p', { className: 'field-hint', text: copy.running }));
        try {
            const { report } = await copy.run();
            this.setStatus(`Copied ${report.copied.length} ${kind === 'live-campaign' ? 'series' : 'tracks'}.`);
            this.refresh('daily', 'campaign');
            this.onTracksChanged();
        } catch (error) {
            this.copyError = { kind, message: `Could not copy: ${error.message}` };
            this.setStatus(this.copyError.message, true);
        } finally {
            this.busy = false;
            this.writeGeneration += 1;
            await this.loadCopy();
        }
    }
}
