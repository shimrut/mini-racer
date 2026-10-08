// The picture of a Campaign stage that is not made yet, for the stage carousel and the Tracks list.

const SVG_NS = 'http://www.w3.org/2000/svg';
const PLAN_BLUE = '#8fb4ff';
const START_WHITE = '#f8fafc';

let artCount = 0;

function createSvgElement(tagName, attributes = {}, children = []) {
    const element = document.createElementNS(SVG_NS, tagName);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    element.append(...children);
    return element;
}

// Grid paper with only the start line and the first road; it shows no track shape.
export function createPlaceholderTrackSvg(className) {
    artCount += 1;
    const fadeId = `placeholder-track-fade-${artCount}`;
    const gridMaskId = `placeholder-track-grid-${artCount}`;
    const roadFadeId = `placeholder-track-road-fade-${artCount}`;
    const roadMaskId = `placeholder-track-road-${artCount}`;
    const gridLines = Array.from({ length: 16 }, (_, index) => createSvgElement('path', {
        d: `M${index * 20} 0V300M0 ${index * 20}H300`,
    }));
    const startLabel = createSvgElement('text', {
        x: 132,
        y: 180,
        'text-anchor': 'middle',
        fill: START_WHITE,
        style: 'font-family: var(--mono-font); font-size: 10px; font-weight: 700; letter-spacing: 0.08em;',
    });
    startLabel.textContent = 'S/F';
    return createSvgElement('svg', {
        class: className,
        viewBox: '20 12 268 274',
        preserveAspectRatio: 'xMidYMid meet',
        'aria-hidden': 'true',
        focusable: 'false',
    }, [
        createSvgElement('defs', {}, [
            createSvgElement('radialGradient', { id: fadeId }, [
                createSvgElement('stop', { offset: '0.55', 'stop-color': '#fff' }),
                createSvgElement('stop', { offset: '1', 'stop-color': '#000' }),
            ]),
            createSvgElement('mask', { id: gridMaskId }, [
                createSvgElement('rect', { width: 300, height: 300, fill: `url(#${fadeId})` }),
            ]),
            // A preview car is about 0.6 of the road width long: the road is solid for two car lengths, then fades.
            createSvgElement('linearGradient', {
                id: roadFadeId, gradientUnits: 'userSpaceOnUse', x1: 132, y1: 0, x2: 178, y2: 0,
            }, [
                createSvgElement('stop', { offset: '0.7', 'stop-color': '#fff' }),
                createSvgElement('stop', { offset: '1', 'stop-color': '#000' }),
            ]),
            createSvgElement('mask', { id: roadMaskId }, [
                createSvgElement('rect', { width: 300, height: 300, fill: `url(#${roadFadeId})` }),
            ]),
        ]),
        createSvgElement('g', {
            mask: `url(#${gridMaskId})`, stroke: '#6f83a5', 'stroke-opacity': 0.24, 'stroke-width': 0.8,
        }, gridLines),
        createSvgElement('g', { mask: `url(#${roadMaskId})` }, [
            createSvgElement('rect', { x: 132, y: 138, width: 46, height: 24, fill: PLAN_BLUE, 'fill-opacity': 0.12 }),
            createSvgElement('path', { d: 'M132 138H178M132 162H178', fill: 'none', stroke: PLAN_BLUE, 'stroke-width': 1.5 }),
            createSvgElement('path', {
                d: 'M132 150H178', fill: 'none', stroke: PLAN_BLUE, 'stroke-opacity': 0.45, 'stroke-width': 1.2, 'stroke-dasharray': '6 5',
            }),
        ]),
        createSvgElement('path', { d: 'M132 136V164', stroke: START_WHITE, 'stroke-width': 2.5 }),
        startLabel,
    ]);
}
