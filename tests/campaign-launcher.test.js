import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    bindCampaignRaceButton,
    openCampaignGame,
} from '../campaign.js';

describe('campaign launcher custom post', () => {
    it('names the Campaign series The Numbers', () => {
        const markup = readFileSync(new URL('../campaign.html', import.meta.url), 'utf8');

        expect(markup).toContain('<p class="campaign-eyebrow">The Numbers</p>');
        expect(markup).not.toContain('Permanent series');
    });

    it('stores the Campaign target before expanding the shared game', async () => {
        const requestLaunchTarget = vi.fn();
        const requestExpanded = vi.fn(async () => undefined);
        const event = { type: 'click' };

        await expect(openCampaignGame(event, {
            requestLaunchTarget,
            requestExpanded,
        })).resolves.toBe(true);

        expect(requestLaunchTarget).toHaveBeenCalledWith('campaign');
        expect(requestExpanded).toHaveBeenCalledWith(event, 'game');
    });

    it('binds the Campaign action only once', async () => {
        const listeners = [];
        const button = {
            dataset: {},
            addEventListener: vi.fn((type, handler) => listeners.push([type, handler])),
        };
        const documentRef = {
            getElementById: vi.fn(() => button),
        };
        const openGame = vi.fn(async () => undefined);

        bindCampaignRaceButton(documentRef, openGame);
        bindCampaignRaceButton(documentRef, openGame);

        expect(button.addEventListener).toHaveBeenCalledTimes(1);
        expect(listeners[0][0]).toBe('click');
        await listeners[0][1]({ type: 'click' });
        expect(openGame).toHaveBeenCalledOnce();
    });
});
