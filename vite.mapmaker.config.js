import { defineConfig } from 'vite';
import { mapmakerTrackAuthoringPlugin } from './tools/mapmaker/vite-track-authoring-plugin.js';

export default defineConfig({
    root: '.',
    optimizeDeps: {
        entries: [
            'tools/mapmaker.html',
            'tools/campaign-planner.html',
        ],
    },
    plugins: [
        mapmakerTrackAuthoringPlugin(),
    ],
});
