import { fileURLToPath } from 'node:url';

export const DEBUG_MODULE_STUBS = [
    {
        suffix: 'ghost/pb-ghost-size-debug.js',
        module: './game/ghost/pb-ghost-size-debug.js',
        stub: './game/ghost/pb-ghost-size-debug.stub.js',
    },
    {
        suffix: 'debug/test-hooks.js',
        module: './game/debug/test-hooks.js',
        stub: './game/debug/test-hooks.stub.js',
    },
    {
        suffix: 'debug/launcher-hooks.js',
        module: './game/debug/launcher-hooks.js',
        stub: './game/debug/launcher-hooks.stub.js',
    },
].map((entry) => ({
    ...entry,
    modulePath: fileURLToPath(new URL(entry.module, new URL('../', import.meta.url))),
    stubPath: fileURLToPath(new URL(entry.stub, new URL('../', import.meta.url))),
}));
