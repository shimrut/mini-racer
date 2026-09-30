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

export class CreatorPanels {
    constructor({ onOpenTrack, onTracksChanged, setStatus }) {
        this.onOpenTrack = onOpenTrack;
        this.onTracksChanged = onTracksChanged;
        this.setStatus = setStatus;
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
    }

    hasUnsavedChanges() {
        return this.busy || this.dailyDirty || this.seriesDirty;
    }

    // ---- Daily list ----

    async loadDaily() {
        if (this.dailyLoading) return;
        this.dailyLoading = true;
        const generation = this.writeGeneration;
        this.dailyRoot.replaceChildren(element('p', { className: 'field-hint', text: 'Loading the Daily list…' }));
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
            this.dailyRoot.replaceChildren(
                element('p', { className: 'creator-error', text: `Could not load the Daily list: ${error.message}` }),
                button('Try again', () => this.loadDaily()),
            );
        } finally {
            this.dailyLoading = false;
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
            this.setStatus(this.dailyDirty
                ? 'Saved the earlier Daily list. Newer changes are still unsaved.' : 'Saved the Daily list.');
        } catch (error) {
            this.dailySaveError = `Could not save the Daily list: ${error.message}`;
            this.setStatus(this.dailySaveError, true);
        } finally {
            this.busy = false;
            this.writeGeneration += 1;
            this.renderDaily();
        }
    }

    // ---- Campaign Planner ----

    async loadSeries(selectId = this.selectedSeriesId) {
        if (this.seriesLoading) return;
        this.seriesLoading = true;
        const generation = this.writeGeneration;
        const selectedId = this.selectedSeriesId;
        const draft = this.seriesDraft;
        this.seriesRoot.replaceChildren(element('p', { className: 'field-hint', text: 'Loading the Campaign…' }));
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
            this.selectSeries(selectId, { force: true });
        } catch (error) {
            this.seriesRoot.replaceChildren(
                element('p', { className: 'creator-error', text: `Could not load the Campaign: ${error.message}` }),
                button('Try again', () => this.loadSeries()),
            );
        } finally {
            this.seriesLoading = false;
        }
    }

    selectSeries(seriesId, { force = false } = {}) {
        if (this.seriesDestructive) return;
        if (!force && this.seriesDirty && !window.confirm('Discard the unsaved changes to this series?')) return;
        const stored = this.seriesView.series.find((series) => series.id === seriesId) ?? null;
        this.selectedSeriesId = stored ? stored.id : null;
        this.seriesDraft = stored ? structuredClone(stored) : null;
        this.seriesDirty = false;
        this.renderSeries();
    }

    startNewSeries() {
        if (this.seriesDestructive) return;
        if (this.seriesDirty && !window.confirm('Discard the unsaved changes to this series?')) return;
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
        this.seriesRoot.replaceChildren(side, this.renderSeriesEditor());
        if (this.seriesDestructive) {
            this.seriesRoot.querySelectorAll('button, input, select').forEach((control) => {
                control.disabled = true;
            });
        }
    }

    renderSeriesEditor() {
        const draft = this.seriesDraft;
        if (!draft) {
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

        const nameInput = element('input', { attrs: { type: 'text', maxlength: 40, value: draft.name } });
        nameInput.addEventListener('change', () => {
            draft.name = nameInput.value;
            if (draft.isNew && !draft.idTouched && this.seriesSavingDraft !== draft) {
                const base = nameInput.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                draft.id = base ? `${/^[a-z]/.test(base) ? base : `s-${base}`}-v1`.slice(0, 40) : '';
            }
            changed();
        });
        const idInput = element('input', { attrs: { type: 'text', maxlength: 40, value: draft.id,
            disabled: !draft.isNew || this.seriesSavingDraft === draft } });
        idInput.addEventListener('change', () => {
            draft.id = idInput.value.trim();
            draft.idTouched = true;
            changed();
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
                    type: 'number', min: 0, step: 1, value: stage.requiredMedals,
                    disabled: locked || index === 0, 'aria-label': 'Medals needed',
                },
            });
            medals.addEventListener('change', () => {
                stage.requiredMedals = Number(medals.value);
                changed();
            });
            const error = locked ? null : getRequiredMedalsError(
                stage.requiredMedals,
                index,
                index > 0 ? draft.stages[index - 1].requiredMedals : 0,
            );
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
                error ? element('p', { className: 'creator-row-error', text: error }) : null,
            ]);
        });

        const inSeries = new Set(draft.stages.map((stage) => stage.trackKey));
        const candidates = tracks
            .filter((track) => track.ready && !inSeries.has(track.key) && track.ground === draft.ground
                && (!track.usedBy || track.usedBy === draft.id))
            .sort((a, b) => a.name.localeCompare(b.name));
        const addSelect = element('select', { attrs: { 'aria-label': 'Track to add' } }, [
            element('option', { text: candidates.length ? 'Choose a track' : 'No free track on this ground', attrs: { value: '' } }),
            ...candidates.map((track) => element('option', {
                text: `${track.name}${track.ready ? '' : ' (not ready)'}`,
                attrs: { value: track.key },
            })),
        ]);
        const addStage = () => {
            if (!addSelect.value) return;
            const previous = draft.stages.at(-1)?.requiredMedals ?? 0;
            draft.stages = [...draft.stages, {
                trackKey: addSelect.value,
                laps: 1,
                requiredMedals: draft.stages.length ? previous + 2 : 0,
            }];
            changed();
        };

        const unpublished = draft.stages.length - fixed;
        return element('div', { className: 'creator-series-editor' }, [
            element('div', { className: 'creator-panel-head' }, [
                element('h2', { text: draft.name || 'New series' }),
                badge(draft.status === 'published' ? 'Live' : 'Draft', draft.status === 'published' ? 'ok' : ''),
                button('Save', () => this.saveSeries(), {
                    className: 'primary-btn',
                    disabled: !this.seriesDirty || this.busy,
                }),
                button(fixed ? 'Make new stages live' : 'Make live', () => this.publishSeries(), {
                    disabled: this.seriesDirty || this.busy || draft.isNew || unpublished <= 0,
                    title: 'Players see the series. The stages cannot change after this.',
                }),
                button('Delete', () => this.deleteSeries(), {
                    className: 'danger-btn',
                    disabled: this.busy || draft.isNew || fixed > 0,
                }),
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
        const snapshot = structuredClone({ name: draft.name, ground: draft.ground, stages: draft.stages });
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
            if (this.seriesDraft === draft) {
                const unchanged = JSON.stringify({ name: draft.name, ground: draft.ground, stages: draft.stages })
                    === JSON.stringify(snapshot);
                this.selectedSeriesId = series.id;
                if (unchanged) this.seriesDraft = structuredClone(series);
                else Object.assign(draft, { id: series.id, isNew: false, revision: series.revision,
                    status: series.status, publishedStageCount: series.publishedStageCount });
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
        }
    }

    async publishSeries() {
        if (this.busy) return;
        const draft = this.seriesDraft;
        if (!window.confirm(`Make ${draft.name} live? Players see it at once, and its stages cannot change after this.`)) return;
        this.busy = true;
        this.seriesDestructive = true;
        this.seriesSaveError = null;
        this.writeGeneration += 1;
        this.renderSeries();
        try {
            const { series } = await creatorApi.publishSeries(draft.id, draft.revision);
            this.setStatus(`${series.name} is live.`);
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
        }
    }

    async deleteSeries() {
        if (this.busy) return;
        const draft = this.seriesDraft;
        if (!window.confirm(`Delete the draft ${draft.name}?`)) return;
        this.busy = true;
        this.seriesDestructive = true;
        this.seriesSaveError = null;
        this.writeGeneration += 1;
        this.renderSeries();
        try {
            await creatorApi.deleteSeries(draft.id, draft.revision);
            this.setStatus(`Deleted ${draft.name}.`);
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
        }
    }

    // ---- Copy of unplayed tracks ----

    async loadCopy() {
        this.copyRoot.replaceChildren(element('p', { className: 'field-hint', text: 'Checking what can be copied…' }));
        try {
            const { report, preview } = await creatorApi.readMigration();
            this.renderCopy(report, preview);
        } catch (error) {
            this.copyRoot.replaceChildren(
                element('p', { className: 'creator-error', text: `Could not check the copy: ${error.message}` }),
                button('Try again', () => this.loadCopy()),
            );
        }
    }

    renderCopy(report, preview) {
        const seriesPreview = preview?.extra?.series;
        const nothingToCopy = !preview?.copied?.length && preview?.dailyList !== 'would-copy'
            && !seriesPreview?.copied?.length;
        const lines = [
            `${preview?.copied?.length ?? 0} unplayed tracks to copy.`,
            `${preview?.played ?? 0} played tracks stay in the app.`,
            preview?.dailyList === 'would-copy' ? 'The Daily list is copied too.' : 'The Daily list is in Redis already.',
            seriesPreview ? `${seriesPreview.copied?.length ?? 0} hidden series to copy as drafts.` : null,
        ].filter(Boolean);
        const children = [
            element('div', { className: 'creator-panel-head' }, [element('h2', { text: 'Copy to Redis' })]),
            element('p', {
                className: 'field-hint',
                text: 'The copy moves every track that nobody has raced into Redis, so you can change it here. Played tracks and the live Campaign stay in the app.',
            }),
            element('ul', { className: 'creator-copy-lines' }, lines.map((line) => element('li', { text: line }))),
            button('Copy now', () => this.runCopy(), { className: 'primary-btn', disabled: this.busy || nothingToCopy }),
        ];
        if (report) {
            children.push(element('p', {
                className: 'field-hint',
                text: `Last copy: ${formatDate(report.ranAt)} by u/${report.ranBy}. ${report.copied.length} tracks copied${report.failed.length ? `, ${report.failed.length} failed` : ''}.`,
            }));
            if (report.failed.length) {
                children.push(element('ul', { className: 'creator-copy-lines' }, report.failed.map((failure) => (
                    element('li', { className: 'creator-error', text: `${failure.key}: ${failure.error}` })
                ))));
            }
        }
        this.copyRoot.replaceChildren(...children);
    }

    async runCopy() {
        if (this.busy) return;
        if (!window.confirm('Copy the unplayed tracks to Redis now?')) return;
        this.busy = true;
        this.writeGeneration += 1;
        try {
            const { report } = await creatorApi.runMigration();
            this.setStatus(`Copied ${report.copied.length} tracks.`);
            this.onTracksChanged();
        } catch (error) {
            this.setStatus(`Could not copy: ${error.message}`, true);
        } finally {
            this.busy = false;
            this.writeGeneration += 1;
            await this.loadCopy();
        }
    }
}
