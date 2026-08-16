import { fileURLToPath } from 'node:url';

// Developer-tooling modules that must not reach a player's bundle, each paired
// with the no-op stub the client build resolves in its place.
//
// A runtime gate cannot enforce this. The client is in the player's hands, so a
// hostname or storage check can be spoofed by serving or patching the bundle,
// and a minifier will not drop an unreferenced class method. Keeping the code
// out of the build is the only version of this that holds.
//
// `suffix` is matched against the end of an import specifier, so it covers both
// `./ghost/...` and `../ghost/...` forms.
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
