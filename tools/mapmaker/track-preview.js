import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from '../../game/track/presentation.js';
import { renderTrackPreviewCanvas } from '../../game/track/preview-renderer.js';

// Small track previews, drawn only when they scroll into view.
export class TrackPreviews {
    constructor(getTrack) {
        this.getTrack = getTrack;
        this.observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                this.observer.unobserve(entry.target);
                this.draw(entry.target);
            }
        }, { rootMargin: '200px' });
    }

    create(trackKey, className) {
        const canvas = document.createElement('canvas');
        canvas.className = className;
        canvas.dataset.previewTrack = trackKey;
        this.observer.observe(canvas);
        return canvas;
    }

    createCard(tag, trackKey, name, meta) {
        const card = document.createElement(tag);
        card.className = 'track-card';
        card.dataset.trackKey = trackKey;
        const title = document.createElement('strong');
        title.textContent = name;
        const details = document.createElement('span');
        details.className = 'track-card-meta';
        details.textContent = meta;
        card.append(this.create(trackKey, 'track-card-preview'), title, details);
        return card;
    }

    reset() {
        this.observer.disconnect();
    }

    draw(canvas) {
        const trackKey = canvas.dataset.previewTrack;
        const track = this.getTrack(trackKey);
        if (!track) return;
        const scale = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
        canvas.width = Math.round(canvas.clientWidth * scale);
        canvas.height = Math.round(canvas.clientHeight * scale);
        renderTrackPreviewCanvas(canvas, {
            trackGeometry: { outer: track.outer, inner: track.inner },
            cornerRadius: track.cornerRadius,
            presentation: resolveTrackPresentation(trackKey, {
                surface: TRACK_PRESENTATION_SURFACES.TRACK_PICKER,
                ground: track.ground,
            }),
            startLine: track.startLine,
            startPos: track.startPos,
            startAngle: track.startAngle,
            transparentBackground: true,
            previewRenderMode: 'schematic',
        });
    }
}
