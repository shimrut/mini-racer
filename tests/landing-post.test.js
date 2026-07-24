import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bootLanding,
    cleanUrl,
    fetchLandingDestinations,
    openLandingDestination,
} from '../landing.js';
import {
    bindCampaignRaceButton,
    openCampaignGame,
} from '../campaign.js';

describe('landing destinations', () => {
    it('accepts only http(s) destination URLs', () => {
        expect(cleanUrl('https://reddit.com/r/x/comments/a')).toBe('https://reddit.com/r/x/comments/a');
        expect(cleanUrl('http://reddit.com/r/x')).toBe('http://reddit.com/r/x');
        expect(cleanUrl('javascript:alert(1)')).toBeNull();
        expect(cleanUrl('')).toBeNull();
        expect(cleanUrl(null)).toBeNull();
    });

    it('loads Daily and Campaign URLs from the landing API', async () => {
        const root = {
            fetch: vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    dailyPostUrl: 'https://reddit.com/daily',
                    campaignPostUrl: 'https://reddit.com/campaign',
                }),
            })),
        };
        await expect(fetchLandingDestinations(root)).resolves.toEqual({
            dailyPostUrl: 'https://reddit.com/daily',
            campaignPostUrl: 'https://reddit.com/campaign',
        });
        expect(root.fetch).toHaveBeenCalledWith('/api/landing/destinations');
    });

    it('navigates to a destination URL through Devvit', async () => {
        const navigate = vi.fn();
        await expect(openLandingDestination('https://reddit.com/daily', { navigate }))
            .resolves.toBe(true);
        expect(navigate).toHaveBeenCalledWith('https://reddit.com/daily');
    });

    it('wires Daily and Campaign buttons after destinations load', async () => {
        const daily = { disabled: true, addEventListener: vi.fn() };
        const campaign = { disabled: true, addEventListener: vi.fn() };
        const status = { textContent: '' };
        const documentRef = {
            getElementById: (id) => {
                if (id === 'landing-daily-btn') return daily;
                if (id === 'landing-campaign-btn') return campaign;
                if (id === 'landing-status') return status;
                return null;
            },
        };
        const root = {
            fetch: vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    dailyPostUrl: 'https://reddit.com/daily',
                    campaignPostUrl: 'https://reddit.com/campaign',
                }),
            })),
        };

        await bootLanding(documentRef, root);

        expect(daily.disabled).toBe(false);
        expect(campaign.disabled).toBe(false);
        expect(daily.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
        expect(campaign.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
        expect(status.textContent).toBe('');
    });
});

describe('campaign hub splash', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('launches the game in Campaign mode', async () => {
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

    it('binds the Race Campaign button once', () => {
        const button = {
            dataset: {},
            addEventListener: vi.fn(),
        };
        const documentRef = {
            getElementById: (id) => (id === 'campaign-race-btn' ? button : null),
        };
        const openGame = vi.fn();

        expect(bindCampaignRaceButton(documentRef, openGame)).toBe(button);
        expect(bindCampaignRaceButton(documentRef, openGame)).toBe(button);
        expect(button.addEventListener).toHaveBeenCalledTimes(1);
    });
});
