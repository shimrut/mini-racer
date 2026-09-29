import { defineConfig, loadEnv } from 'vite';
import { mapmakerTrackAuthoringPlugin } from './tools/mapmaker/vite-track-authoring-plugin.js';

export default defineConfig(({ mode }) => {
    // .env.local: MAPMAKER_PASSCODE, and MAPMAKER_CLOUD_URL to use another site.
    const env = loadEnv(mode, process.cwd(), 'MAPMAKER_');
    return {
        root: '.',
        optimizeDeps: {
            entries: [
                'tools/mapmaker.html',
                'tools/campaign-planner.html',
            ],
        },
        plugins: [
            mapmakerTrackAuthoringPlugin({
                url: env.MAPMAKER_CLOUD_URL || 'https://miniracer.club',
                passcode: env.MAPMAKER_PASSCODE || '',
            }),
        ],
    };
});
