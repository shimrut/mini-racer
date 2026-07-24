export async function fetchLandingDestinations(root = globalThis) {
    const response = await root.fetch('/api/landing/destinations');
    if (!response?.ok) {
        let message = 'Could not load Daily or Campaign links.';
        try {
            const payload = await response.json();
            if (typeof payload?.error === 'string' && payload.error.trim()) {
                message = payload.error.trim();
            }
        } catch {
            // Keep the default message when the body is not JSON.
        }
        throw new Error(message);
    }
    const payload = await response.json();
    return {
        dailyPostUrl: cleanUrl(payload?.dailyPostUrl),
        campaignPostUrl: cleanUrl(payload?.campaignPostUrl),
    };
}

export function cleanUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        const url = new URL(trimmed);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
        return null;
    }
}

export async function openLandingDestination(url, {
    navigate = null,
    showToast = null,
} = {}) {
    if (!url) {
        showToast?.({ text: 'That race post is not ready yet.', appearance: 'neutral' });
        return false;
    }
    try {
        const client = navigate
            ? { navigateTo: navigate }
            : await import('@devvit/web/client');
        client.navigateTo(url);
        return true;
    } catch (error) {
        console.error('Failed to open Mini Racer destination post:', error);
        showToast?.({ text: 'Could not open that race post.', appearance: 'neutral' });
        return false;
    }
}

function setStatus(statusEl, message) {
    if (statusEl) statusEl.textContent = message || '';
}

export async function bootLanding(documentRef = document, root = globalThis) {
    const dailyBtn = documentRef.getElementById('landing-daily-btn');
    const campaignBtn = documentRef.getElementById('landing-campaign-btn');
    const statusEl = documentRef.getElementById('landing-status');
    if (!dailyBtn || !campaignBtn) return null;

    setStatus(statusEl, 'Loading race posts…');

    let destinations = { dailyPostUrl: null, campaignPostUrl: null };
    try {
        destinations = await fetchLandingDestinations(root);
        setStatus(statusEl, '');
    } catch (error) {
        console.error('Failed to load Mini Racer landing destinations:', error);
        setStatus(
            statusEl,
            error instanceof Error ? error.message : 'Could not load Daily or Campaign links.',
        );
    }

    const bind = (button, url) => {
        button.disabled = !url;
        button.addEventListener('click', () => {
            void openLandingDestination(url, {
                showToast: async (toast) => {
                    try {
                        const { showToast } = await import('@devvit/web/client');
                        showToast(toast);
                    } catch {
                        setStatus(statusEl, toast.text);
                    }
                },
            });
        });
    };

    bind(dailyBtn, destinations.dailyPostUrl);
    bind(campaignBtn, destinations.campaignPostUrl);

    if (!destinations.dailyPostUrl && !destinations.campaignPostUrl) {
        setStatus(statusEl, 'Race posts are not ready yet. Ask a moderator to create the landing post.');
    } else if (!destinations.dailyPostUrl) {
        setStatus(statusEl, 'Daily post is not ready yet.');
    } else if (!destinations.campaignPostUrl) {
        setStatus(statusEl, 'Campaign post is not ready yet.');
    }

    return destinations;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            void bootLanding();
        }, { once: true });
    } else {
        void bootLanding();
    }
}
