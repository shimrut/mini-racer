import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';

function fixDevvitHtmlEntrypoints() {
    const clientDir = resolve('dist/client');

    async function rewriteFile(filename, replacements) {
        const filePath = resolve(clientDir, filename);
        let content = await readFile(filePath, 'utf8');

        for (const [from, to] of replacements) {
            content = content.replace(from, to);
        }

        await writeFile(filePath, content);
    }

    return {
        name: 'fix-devvit-html-entrypoints',
        apply: 'build',
        async closeBundle() {
            await rewriteFile('preview.html', [
                ['href="preview.css"', 'href="default.css"'],
                ['src="preview.js"', 'src="default.js"']
            ]);

            await rewriteFile('game.html', [
                ['href="styles.css?v=1.90"', 'href="styles.css"'],
                ['src="game/index.js?v=1.90"', 'src="game.js"']
            ]);
        }
    };
}

export default defineConfig({
    root: '.',
    plugins: [
        fixDevvitHtmlEntrypoints(),
        devvit({
            client: {
                build: {
                    chunkSizeWarningLimit: 2000
                }
            }
        })
    ]
});
