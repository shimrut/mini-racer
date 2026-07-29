const SVG_NS = 'http://www.w3.org/2000/svg';
const LOCK_ICON_PATH = 'M128 96l0 64 128 0 0-64c0-35.3-28.7-64-64-64s-64 28.7-64 64zM64 160l0-64C64 25.3 121.3-32 192-32S320 25.3 320 96l0 64c35.3 0 64 28.7 64 64l0 224c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 224c0-35.3 28.7-64 64-64z';

// Font Awesome Free v7.3.1 — https://fontawesome.com/license/free
export function createLockIconSvg(className = '') {
    const lock = document.createElementNS(SVG_NS, 'svg');
    if (className) lock.setAttribute('class', className);
    lock.setAttribute('viewBox', '0 0 384 512');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', LOCK_ICON_PATH);
    lock.appendChild(path);
    return lock;
}
