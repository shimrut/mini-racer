// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
    QUICK_RESTART_SETTING_VISIBLE,
    QUICK_RESTART_STORAGE_KEY,
    getQuickRestartEnabled,
    isQuickRestartActive,
} from '../game/settings/quick-restart-preference.js';
import { SettingsUi } from '../game/settings/ui.js';
import { filterVisibleMenuItems } from '../game/ui/menu-keyboard-nav.js';

// Quick Restart is held back: row hidden, treated as off, saved choice kept.

function mountRow() {
    document.body.innerHTML = `
        <div class="modal-sheet-settings-identity-head">
            <span id="settings-quick-restart-heading">Quick Restart</span>
            <label class="modal-sheet-settings-switch">
                <input type="checkbox" id="settings-quick-restart-switch" />
            </label>
        </div>
        <p id="settings-quick-restart-desc">Double tap pause button</p>
        <div class="modal-sheet-settings-row-divider"></div>
        <p id="next-row">Next</p>`;
}

describe('held-back Quick Restart', () => {
    afterEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
    });

    it('is held back', () => {
        expect(QUICK_RESTART_SETTING_VISIBLE).toBe(false);
    });

    it('keeps the saved choice but is off in the game', () => {
        localStorage.setItem(QUICK_RESTART_STORAGE_KEY, '1');

        expect(getQuickRestartEnabled()).toBe(true);
        expect(isQuickRestartActive()).toBe(false);
    });

    it('hides the Settings row and keeps the keyboard off its switch', () => {
        mountRow();
        const context = {
            get quickRestartSwitch() { return document.getElementById('settings-quick-restart-switch'); },
            get quickRestartHeading() { return document.getElementById('settings-quick-restart-heading'); },
            _syncBooleanSettingRow: SettingsUi.prototype._syncBooleanSettingRow,
            syncQuickRestartRowVisibility: SettingsUi.prototype.syncQuickRestartRowVisibility,
        };

        SettingsUi.prototype.refreshQuickRestartPanel.call(context);

        const switchEl = document.getElementById('settings-quick-restart-switch');
        expect(document.querySelector('.modal-sheet-settings-identity-head').style.display).toBe('none');
        expect(document.getElementById('settings-quick-restart-desc').style.display).toBe('none');
        expect(document.querySelector('.modal-sheet-settings-row-divider').style.display).toBe('none');
        expect(document.getElementById('next-row').style.display).toBe('');
        expect(filterVisibleMenuItems([switchEl], { requireLaidOut: false })).toEqual([]);
    });
});
