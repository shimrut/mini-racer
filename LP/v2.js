import { createMedalIconSvg } from './showcase/ui/medal-icon.js';

export function resolveDestination(destination, fallback, links = {}) {
  const configured = links[destination];
  return typeof configured === 'string' && configured.trim() ? configured.trim() : fallback;
}

export function replayPose(frames, time) {
  let low = 0;
  let high = frames.length - 1;
  if (time <= frames[0].t) return frames[0];
  if (time >= frames[high].t) return frames[high];
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (frames[middle].t <= time) low = middle;
    else high = middle;
  }
  const a = frames[low];
  const b = frames[high];
  const fraction = (time - a.t) / (b.t - a.t);
  const turn = Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle));
  return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction, angle: a.angle + turn * fraction };
}

async function initReplay() {
  const canvas = document.getElementById('replay-canvas');
  const context = canvas.getContext('2d');
  const toggle = document.getElementById('replay-toggle');
  const timer = document.getElementById('replay-time');
  const scene = canvas.closest('figure');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const loadImage = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
  try {
    const response = await fetch('showcase/replay.json');
    if (!response.ok) throw new Error('Replay unavailable');
    const [replay, car] = await Promise.all([response.json(), loadImage('showcase/street-replay.png')]);
    canvas.width = replay.width;
    canvas.height = replay.height;
    let elapsed = 0;
    let previous = null;
    let manualPause = false;
    let motionOptIn = false;
    let visible = true;
    let frameId = null;
    const total = Math.max(replay.durationMs, replay.ghostDurationMs || 0) + 1600;
    const isPaused = () => manualPause || (reducedMotion.matches && !motionOptIn);
    const drawCar = (frames, opacity) => {
      const pose = replayPose(frames, elapsed);
      context.save();
      context.globalAlpha = opacity;
      context.translate(pose.x, pose.y);
      context.rotate(pose.angle);
      context.drawImage(car, -replay.carWidth / 2, -replay.carHeight / 2, replay.carWidth, replay.carHeight);
      context.restore();
    };
    const draw = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (replay.ghostFrames) drawCar(replay.ghostFrames, .3);
      drawCar(replay.frames, 1);
      const time = Math.min(elapsed, replay.durationMs) / 1000;
      timer.replaceChildren(document.createTextNode(time.toFixed(3)), Object.assign(document.createElement('span'), { textContent: 's' }));
      scene.dataset.replayTime = time.toFixed(3);
      scene.dataset.replayPaused = String(isPaused());
    };
    const animate = (now) => {
      frameId = null;
      if (!isPaused() && visible && !document.hidden) {
        if (previous !== null) elapsed = (elapsed + Math.min(now - previous, 100)) % total;
        previous = now;
        draw();
        frameId = requestAnimationFrame(animate);
      } else previous = null;
    };
    const sync = () => {
      previous = null;
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      const paused = isPaused();
      toggle.textContent = paused ? '▶' : 'Ⅱ';
      toggle.setAttribute('aria-label', paused ? 'Play lap replay' : 'Pause lap replay');
      toggle.setAttribute('aria-pressed', String(paused));
      draw();
      if (!paused && visible && !document.hidden) frameId = requestAnimationFrame(animate);
    };
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      // Reduced motion keeps a useful still; explicitly pressing Play opts in.
      if (reducedMotion.matches && !motionOptIn) motionOptIn = true;
      else manualPause = !manualPause;
      sync();
    });
    reducedMotion.addEventListener('change', () => { manualPause = false; motionOptIn = false; sync(); });
    document.addEventListener('visibilitychange', sync);
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: .05 }).observe(scene);
    if (reducedMotion.matches) elapsed = 3000;
    sync();
  } catch {
    // The generated track remains useful if replay assets cannot be loaded.
    canvas.hidden = true;
    timer.hidden = true;
    scene.querySelector('.replay-label').textContent = 'Track preview';
    scene.setAttribute('aria-label', 'Classic Circuit track preview');
  }
}

if (typeof document !== 'undefined') {
  const tabs = [...document.querySelectorAll('[data-mode]')];
  const selectMode = (selected) => {
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.classList.toggle('main-menu__item--primary', active);
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectMode(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectMode(tabs[next]);
      tabs[next].focus();
    });
  });
  document.querySelectorAll('[data-medal-tier]').forEach((slot) => {
    slot.append(createMedalIconSvg(slot.dataset.medalTier, { className: 'medal-svg--hero' }));
  });
  document.querySelectorAll('[data-destination]').forEach((link) => {
    link.href = resolveDestination(link.dataset.destination, link.getAttribute('href'), window.LP_LINKS);
  });
  document.querySelectorAll('[data-paint]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-paint]').forEach((other) => {
        other.setAttribute('aria-pressed', String(other === button));
        other.classList.toggle('is-selected', other === button);
      });
      const image = document.getElementById('garage-car');
      const color = button.dataset.paint;
      image.src = `showcase/street-${color}.png`;
      image.alt = `${color.charAt(0).toUpperCase() + color.slice(1)} Street car`;
    });
  });
  initReplay();
}
