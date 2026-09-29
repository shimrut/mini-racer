export const UNLOCK_PATH = '/mapmaker/unlock';

// The page shown before the Mapmaker is unlocked. message is fixed text.
export function unlockPage(message, status) {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Mapmaker</title>
<style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem;
        background: #0a0d14; color: #e6e9ef; font: 16px/1.4 system-ui, sans-serif; }
    form { width: min(20rem, 100%); display: grid; gap: 0.9rem; }
    h1 { margin: 0; font-size: 1.4rem; }
    p { margin: 0; color: #8b93a3; font-size: 0.9rem; }
    p.error { color: #fda4af; }
    input, button { font: inherit; padding: 0.75rem 0.9rem; border-radius: 10px; }
    input { border: 1px solid rgba(148, 163, 184, 0.28); background: #0c1018; color: inherit; letter-spacing: 0.2em; }
    input:focus { outline: none; border-color: #38bdf8; }
    button { border: 0; background: #f43f5e; color: #fff; font-weight: 700; cursor: pointer; }
</style>
</head>
<body>
<form method="post" action="${UNLOCK_PATH}">
    <h1>Mapmaker</h1>
    <p>Enter the passcode to make maps.</p>
    <input name="passcode" type="password" autocomplete="current-password" aria-label="Passcode" required autofocus>
    ${message ? `<p class="error" role="alert">${message}</p>` : ''}
    <button type="submit">Unlock</button>
</form>
</body>
</html>`;
    return new Response(html, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
        },
    });
}
