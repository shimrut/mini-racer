// Things beside the road at each checkpoint, in place of the tyre stacks:
// bushes and trees on dirt; pine trees, snowmen and igloos on snow; palm
// trees, rocks and beach umbrellas on water; asteroids, planets and
// satellites in space. They are flat shapes, drawn like the banks: the light
// comes from the top left, so each shape has a shade to the lower right, a
// light top to the upper left, and a shadow on the ground. The space items
// float, so they have no shadow.
//
// Each item draws at (x, y) in track-canvas pixels. size is its radius.
// random gives the item its own shape. facing is the angle from the item to
// the road, so a snowman and an igloo face the road.

const LIGHT_OFFSET_X = -1.2;
const LIGHT_OFFSET_Y = -1.5;
const SHADE_OFFSET_X = 1.5;
const SHADE_OFFSET_Y = 2;
const GROUND_SHADOW_OFFSET_X = 4;
const GROUND_SHADOW_OFFSET_Y = 5;

const BUSH = Object.freeze({
    shadow: 'rgba(20, 12, 4, 0.32)',
    shade: '#2d5226',
    base: '#4a7f36',
    light: '#6fa64a'
});
const TREE = Object.freeze({
    shadow: 'rgba(20, 12, 4, 0.36)',
    shade: '#22461f',
    base: '#3b6e33',
    light: '#5f9444'
});
const PINE = Object.freeze({
    shadow: 'rgba(40, 70, 110, 0.3)',
    shade: '#1c3a32',
    base: '#2b5747',
    inner: '#3b6f59'
});
const SNOW = Object.freeze({
    shadow: 'rgba(40, 70, 110, 0.26)',
    shade: '#9db2c7',
    base: '#e2ebf3',
    light: '#fbfdff',
    line: '#b4c6d8',
    opening: '#2b3a4d'
});
const PALM = Object.freeze({
    shadow: 'rgba(90, 70, 30, 0.3)',
    shade: '#1f5a2c',
    base: '#2f8a3e',
    light: '#58b45a',
    trunk: '#7a5230',
    nut: '#5a3a1e'
});
const ROCK = Object.freeze({
    shadow: 'rgba(90, 70, 30, 0.3)',
    shade: '#5b6470',
    base: '#8a939e',
    light: '#b5bdc6'
});
const UMBRELLA = Object.freeze({
    shadow: 'rgba(90, 70, 30, 0.3)',
    shade: '#8a2a22',
    colors: Object.freeze(['#e8453c', '#fbf6ea']),
    pole: '#6b4a2e'
});
const ASTEROID = Object.freeze({
    shade: '#4a4038',
    base: '#7a6c5e',
    light: '#a8988a',
    crater: '#5c5046'
});
const PLANET_COLORS = Object.freeze([
    Object.freeze({ shade: '#9a4a1c', base: '#e07a35', light: '#f6b36d', ring: '#f3d9a4' }),
    Object.freeze({ shade: '#2a4f8c', base: '#4f8ae0', light: '#9cc4f5', ring: '#cfe3ff' }),
    Object.freeze({ shade: '#5a2d80', base: '#9152c9', light: '#c89af0', ring: '#f0d4ff' })
]);
const SATELLITE = Object.freeze({
    body: '#d6dbe3',
    bodyShade: '#8d96a3',
    panel: '#2b4fa8',
    panelLine: '#7ea2f0',
    dish: '#f2f4f7'
});
const HAY = Object.freeze({
    shadow: 'rgba(20, 12, 4, 0.34)',
    shade: '#a57a33',
    base: '#d8ac55',
    light: '#f1d07e',
    line: '#b3843a',
    pole: '#5b3f26'
});
const ICE = Object.freeze({
    shade: '#7fa2c2',
    base: '#bcd7ee',
    light: '#eef6fc',
    pole: '#475569'
});
const FLAG_LIGHT = '#f8fafc';
const FLAG_DARK = '#111827';
const FLAG_SHADOW = 'rgba(15, 23, 42, 0.28)';
const FLAG_LENGTH = 13;
const FLAG_HEIGHT = 9;
const CARROT = '#f28c28';
const HAT = '#1f2937';
const HAT_BRIM = '#374151';
const STICK = '#6b4a2e';

// Round lumps around a middle lump, for a bush or a tree top.
function makeLumps(random, count, radius) {
    const lumps = [{ x: 0, y: 0, r: radius * 0.62 }];
    const turn = random() * Math.PI * 2;
    for (let i = 0; i < count; i += 1) {
        const angle = turn + (Math.PI * 2 * (i + (random() - 0.5) * 0.4)) / count;
        const reach = radius * (0.42 + random() * 0.12);
        lumps.push({
            x: Math.cos(angle) * reach,
            y: Math.sin(angle) * reach,
            r: radius * (0.4 + random() * 0.14)
        });
    }
    return lumps;
}

// All the lumps as one fill, so they merge into one shape.
function fillLumps(ctx, lumps, x, y, color, scale = 1, offsetX = 0, offsetY = 0) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const lump of lumps) {
        const cx = x + lump.x + offsetX;
        const cy = y + lump.y + offsetY;
        const r = lump.r * scale;
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    ctx.fill();
}

function drawLumpyPlant(ctx, x, y, size, random, colors, lumpCount) {
    const lumps = makeLumps(random, lumpCount, size);
    fillLumps(ctx, lumps, x, y, colors.shadow, 1, GROUND_SHADOW_OFFSET_X, GROUND_SHADOW_OFFSET_Y);
    fillLumps(ctx, lumps, x, y, colors.shade, 1, SHADE_OFFSET_X, SHADE_OFFSET_Y);
    fillLumps(ctx, lumps, x, y, colors.base);
    fillLumps(ctx, lumps, x, y, colors.light, 0.55, LIGHT_OFFSET_X, LIGHT_OFFSET_Y);
}

function drawBush(ctx, x, y, size, { random }) {
    drawLumpyPlant(ctx, x, y, size, random, BUSH, 4 + Math.floor(random() * 2));
}

function drawTree(ctx, x, y, size, { random }) {
    drawLumpyPlant(ctx, x, y, size, random, TREE, 6 + Math.floor(random() * 2));
}

function fillStar(ctx, x, y, outerRadius, innerRadius, points, turn, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i += 1) {
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = turn + (Math.PI * i) / points;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
}

function fillCircle(ctx, x, y, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
}

// A pine tree seen from above: rings of short branch tips, with lumps of
// snow on the upper left of the branches, where the light falls.
function drawPine(ctx, x, y, size, { random }) {
    const points = 12 + Math.floor(random() * 3);
    const turn = random() * Math.PI;
    const step = Math.PI / points;
    fillStar(ctx, x + GROUND_SHADOW_OFFSET_X, y + GROUND_SHADOW_OFFSET_Y, size, size * 0.78, points, turn, PINE.shadow);
    fillStar(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, size, size * 0.78, points, turn, PINE.shade);
    fillStar(ctx, x, y, size, size * 0.78, points, turn, PINE.base);
    fillStar(ctx, x - 0.6, y - 0.8, size * 0.66, size * 0.5, points, turn + step, PINE.inner);
    const lumps = [{ x: -size * 0.08, y: -size * 0.1, r: size * 0.2 }];
    const count = 4 + Math.floor(random() * 2);
    for (let i = 0; i < count; i += 1) {
        // Around the upper left half, from the top right to the lower left.
        const angle = -Math.PI * 1.25 + (Math.PI * (i + 0.2 + random() * 0.6)) / count;
        const reach = size * (0.42 + random() * 0.25);
        lumps.push({ x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, r: size * (0.13 + random() * 0.08) });
    }
    fillLumps(ctx, lumps, x, y, SNOW.shade, 1, SHADE_OFFSET_X * 0.6, SHADE_OFFSET_Y * 0.6);
    fillLumps(ctx, lumps, x, y, SNOW.base);
    fillLumps(ctx, lumps, x, y, SNOW.light, 0.5, LIGHT_OFFSET_X * 0.6, LIGHT_OFFSET_Y * 0.6);
}

function drawSnowBall(ctx, x, y, radius) {
    fillCircle(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, radius, SNOW.shade);
    fillCircle(ctx, x, y, radius, SNOW.base);
    fillCircle(ctx, x + LIGHT_OFFSET_X * 1.3, y + LIGHT_OFFSET_Y * 1.3, radius * 0.55, SNOW.light);
}

// A snowman seen from a little above the front: a body, a head with a black
// hat, stick arms, and a carrot nose that points at the road.
function drawSnowman(ctx, x, y, size, { facing }) {
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    const headX = x;
    const headY = y - size * 0.55;
    fillCircle(ctx, x + GROUND_SHADOW_OFFSET_X, y + GROUND_SHADOW_OFFSET_Y, size, SNOW.shadow);

    ctx.strokeStyle = STICK;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const side of [-1, 1]) {
        const armX = -sin * side;
        const armY = cos * side;
        ctx.moveTo(x + armX * size * 0.7, y + armY * size * 0.7);
        ctx.lineTo(x + armX * size * 1.45, y + armY * size * 1.45 - size * 0.25);
    }
    ctx.stroke();

    drawSnowBall(ctx, x, y, size);
    drawSnowBall(ctx, headX, headY, size * 0.66);

    const noseStartX = headX + cos * size * 0.4;
    const noseStartY = headY + sin * size * 0.4;
    ctx.fillStyle = CARROT;
    ctx.beginPath();
    ctx.moveTo(noseStartX - sin * size * 0.14, noseStartY + cos * size * 0.14);
    ctx.lineTo(noseStartX + cos * size * 0.55, noseStartY + sin * size * 0.55);
    ctx.lineTo(noseStartX + sin * size * 0.14, noseStartY - cos * size * 0.14);
    ctx.closePath();
    ctx.fill();

    const hatX = headX - cos * size * 0.12;
    const hatY = headY - size * 0.18 - sin * size * 0.12;
    fillCircle(ctx, hatX, hatY, size * 0.4, HAT_BRIM);
    fillCircle(ctx, hatX - 0.5, hatY - 1, size * 0.27, HAT);
}

// An igloo seen from above: a dome of snow blocks with its door to the road.
function drawIgloo(ctx, x, y, size, { facing }) {
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    fillCircle(ctx, x + GROUND_SHADOW_OFFSET_X, y + GROUND_SHADOW_OFFSET_Y, size, SNOW.shadow);

    // The tunnel to the door, toward the road.
    const tunnelEnd = size * 1.3;
    const tunnelHalf = size * 0.32;
    const drawTunnel = (offsetX, offsetY, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = tunnelHalf * 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + offsetX, y + offsetY);
        ctx.lineTo(x + cos * tunnelEnd + offsetX, y + sin * tunnelEnd + offsetY);
        ctx.stroke();
    };
    drawTunnel(SHADE_OFFSET_X, SHADE_OFFSET_Y, SNOW.shade);
    drawTunnel(0, 0, SNOW.base);
    fillCircle(ctx, x + cos * (tunnelEnd + tunnelHalf * 0.2), y + sin * (tunnelEnd + tunnelHalf * 0.2),
        tunnelHalf * 0.62, SNOW.opening);

    fillCircle(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, size, SNOW.shade);
    fillCircle(ctx, x, y, size, SNOW.base);

    // The rows of snow blocks: rings, and short joins between them.
    ctx.strokeStyle = SNOW.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const rings = [size * 0.72, size * 0.42];
    for (const ring of rings) {
        ctx.moveTo(x + ring, y);
        ctx.arc(x, y, ring, 0, Math.PI * 2);
    }
    const bands = [[size * 0.72, size, 10], [size * 0.42, size * 0.72, 7], [0, size * 0.42, 4]];
    bands.forEach(([from, to, count], band) => {
        const turn = band % 2 === 0 ? 0 : Math.PI / count;
        for (let i = 0; i < count; i += 1) {
            const angle = turn + (Math.PI * 2 * i) / count;
            ctx.moveTo(x + Math.cos(angle) * Math.max(from, 1), y + Math.sin(angle) * Math.max(from, 1));
            ctx.lineTo(x + Math.cos(angle) * to, y + Math.sin(angle) * to);
        }
    });
    ctx.stroke();
    fillCircle(ctx, x + LIGHT_OFFSET_X * 2.5, y + LIGHT_OFFSET_Y * 2.5, size * 0.3, SNOW.light);
}

// A closed shape through points around (x, y), at the given distances.
function fillRing(ctx, x, y, points, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    points.forEach(([px, py], index) => {
        if (index === 0) ctx.moveTo(x + px, y + py);
        else ctx.lineTo(x + px, y + py);
    });
    ctx.closePath();
    ctx.fill();
}

// Corners of a rough round stone: its reach changes a little at each corner.
function makeStoneCorners(random, size, count) {
    const turn = random() * Math.PI * 2;
    const corners = [];
    for (let i = 0; i < count; i += 1) {
        const angle = turn + (Math.PI * 2 * (i + (random() - 0.5) * 0.35)) / count;
        const reach = size * (0.78 + random() * 0.22);
        corners.push([Math.cos(angle) * reach, Math.sin(angle) * reach]);
    }
    return corners;
}

function scaleCorners(corners, scale, offsetX = 0, offsetY = 0) {
    return corners.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);
}

// A palm tree seen from above: long pointed fronds from a small crown, with
// a light line along the upper left side of each frond.
function drawPalm(ctx, x, y, size, { random }) {
    const count = 6 + Math.floor(random() * 2);
    const turn = random() * Math.PI * 2;
    const fronds = [];
    for (let i = 0; i < count; i += 1) {
        const angle = turn + (Math.PI * 2 * (i + (random() - 0.5) * 0.3)) / count;
        fronds.push({ angle, length: size * (0.85 + random() * 0.15), width: size * (0.2 + random() * 0.06) });
    }
    // One frond as a leaf: a point at the crown, a wide middle and a point at the tip.
    const traceFrond = ({ angle, length, width }, offsetX, offsetY, scale = 1) => {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const tipX = x + offsetX + cos * length * scale;
        const tipY = y + offsetY + sin * length * scale;
        const midX = x + offsetX + cos * length * 0.5 * scale;
        const midY = y + offsetY + sin * length * 0.5 * scale;
        const half = width * scale;
        ctx.moveTo(x + offsetX, y + offsetY);
        ctx.lineTo(midX - sin * half, midY + cos * half);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(midX + sin * half, midY - cos * half);
        ctx.closePath();
    };
    const fillFronds = (color, offsetX, offsetY, scale) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const frond of fronds) traceFrond(frond, offsetX, offsetY, scale);
        ctx.fill();
    };
    fillFronds(PALM.shadow, GROUND_SHADOW_OFFSET_X, GROUND_SHADOW_OFFSET_Y, 1);
    fillFronds(PALM.shade, SHADE_OFFSET_X, SHADE_OFFSET_Y, 1);
    fillFronds(PALM.base, 0, 0, 1);
    ctx.strokeStyle = PALM.light;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const { angle, length } of fronds) {
        ctx.moveTo(x + Math.cos(angle) * size * 0.2, y + Math.sin(angle) * size * 0.2);
        ctx.lineTo(x + Math.cos(angle) * length * 0.8, y + Math.sin(angle) * length * 0.8);
    }
    ctx.stroke();
    fillCircle(ctx, x, y, size * 0.2, PALM.trunk);
    for (let i = 0; i < 3; i += 1) {
        const angle = turn + (Math.PI * 2 * i) / 3;
        fillCircle(ctx, x + Math.cos(angle) * size * 0.12, y + Math.sin(angle) * size * 0.12, size * 0.09, PALM.nut);
    }
}

// A grey stone with a light face to the upper left.
function drawRock(ctx, x, y, size, { random }) {
    const corners = makeStoneCorners(random, size, 7 + Math.floor(random() * 3));
    fillRing(ctx, x + GROUND_SHADOW_OFFSET_X, y + GROUND_SHADOW_OFFSET_Y, corners, ROCK.shadow);
    fillRing(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, corners, ROCK.shade);
    fillRing(ctx, x, y, corners, ROCK.base);
    fillRing(ctx, x, y, scaleCorners(corners, 0.55, LIGHT_OFFSET_X * 2, LIGHT_OFFSET_Y * 2), ROCK.light);
}

// A beach umbrella seen from above: red and white panels round a pole.
function drawUmbrella(ctx, x, y, size, { random }) {
    const panels = 8;
    const turn = random() * Math.PI;
    fillCircle(ctx, x + GROUND_SHADOW_OFFSET_X, y + GROUND_SHADOW_OFFSET_Y, size, UMBRELLA.shadow);
    fillCircle(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, size, UMBRELLA.shade);
    for (let i = 0; i < panels; i += 1) {
        const from = turn + (Math.PI * 2 * i) / panels;
        const to = from + (Math.PI * 2) / panels;
        ctx.fillStyle = UMBRELLA.colors[i % 2];
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(from) * size, y + Math.sin(from) * size);
        ctx.lineTo(x + Math.cos(to) * size, y + Math.sin(to) * size);
        ctx.closePath();
        ctx.fill();
    }
    fillCircle(ctx, x, y, size * 0.12, UMBRELLA.pole);
}

// A rock in space: a rough stone with round craters. Each crater is a dark
// round with the stone colour pushed to its lower right, as a dip.
function drawAsteroid(ctx, x, y, size, { random }) {
    const corners = makeStoneCorners(random, size, 9 + Math.floor(random() * 3));
    fillRing(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, corners, ASTEROID.shade);
    fillRing(ctx, x, y, corners, ASTEROID.base);
    fillRing(ctx, x, y, scaleCorners(corners, 0.6, LIGHT_OFFSET_X * 2, LIGHT_OFFSET_Y * 2), ASTEROID.light);
    const craters = 2 + Math.floor(random() * 2);
    for (let i = 0; i < craters; i += 1) {
        const angle = random() * Math.PI * 2;
        const reach = size * random() * 0.45;
        const radius = size * (0.14 + random() * 0.1);
        const cx = x + Math.cos(angle) * reach;
        const cy = y + Math.sin(angle) * reach;
        fillCircle(ctx, cx, cy, radius, ASTEROID.crater);
        fillCircle(ctx, cx + radius * 0.3, cy + radius * 0.35, radius * 0.6, ASTEROID.base);
    }
}

// A small planet with a ring. The ring is a flat oval round the planet.
function drawPlanet(ctx, x, y, size, { random }) {
    const colors = PLANET_COLORS[Math.floor(random() * PLANET_COLORS.length)];
    const body = size * 0.62;
    const tilt = random() * Math.PI;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    // The ring: an oval of points, stretched along the tilt.
    const traceRing = (from, to) => {
        ctx.beginPath();
        for (let i = 0; i <= 24; i += 1) {
            const angle = from + ((to - from) * i) / 24;
            const px = Math.cos(angle) * size;
            const py = Math.sin(angle) * size * 0.32;
            const rx = x + px * cos - py * sin;
            const ry = y + px * sin + py * cos;
            if (i === 0) ctx.moveTo(rx, ry);
            else ctx.lineTo(rx, ry);
        }
    };
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = Math.max(1.5, size * 0.12);
    ctx.lineCap = 'round';
    // The back half of the ring goes behind the planet.
    traceRing(Math.PI, Math.PI * 2);
    ctx.stroke();
    fillCircle(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, body, colors.shade);
    fillCircle(ctx, x, y, body, colors.base);
    fillCircle(ctx, x + LIGHT_OFFSET_X * 2, y + LIGHT_OFFSET_Y * 2, body * 0.55, colors.light);
    traceRing(0, Math.PI);
    ctx.stroke();
}

// A satellite seen from above: a body between two solar panels, and a
// small dish.
function drawSatellite(ctx, x, y, size, { random }) {
    const angle = random() * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // A box along the panel line, from `from` to `to`, and `half` wide.
    const box = (from, to, half) => [
        [cos * from - sin * half, sin * from + cos * half],
        [cos * to - sin * half, sin * to + cos * half],
        [cos * to + sin * half, sin * to - cos * half],
        [cos * from + sin * half, sin * from - cos * half]
    ];
    const panelHalf = size * 0.3;
    for (const side of [-1, 1]) {
        const from = side * size * 0.32;
        const to = side * size;
        fillRing(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, box(from, to, panelHalf), SATELLITE.bodyShade);
        fillRing(ctx, x, y, box(from, to, panelHalf), SATELLITE.panel);
        ctx.strokeStyle = SATELLITE.panelLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < 3; i += 1) {
            const along = from + ((to - from) * i) / 3;
            ctx.moveTo(x + cos * along - sin * panelHalf, y + sin * along + cos * panelHalf);
            ctx.lineTo(x + cos * along + sin * panelHalf, y + sin * along - cos * panelHalf);
        }
        ctx.stroke();
    }
    const bodyHalf = size * 0.3;
    fillRing(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, box(-bodyHalf, bodyHalf, bodyHalf), SATELLITE.bodyShade);
    fillRing(ctx, x, y, box(-bodyHalf, bodyHalf, bodyHalf), SATELLITE.body);
    fillCircle(ctx, x + LIGHT_OFFSET_X, y + LIGHT_OFFSET_Y, bodyHalf * 0.55, SATELLITE.dish);
}

// A checkered flag on a pole at (x, y). The flag blows away from the road, so
// it never hangs over it. Its shadow falls on the ground to the lower right.
function drawFlag(ctx, x, y, facing, poleColor) {
    const away = facing + Math.PI;
    const cos = Math.cos(away);
    const sin = Math.sin(away);
    // A corner of the flag: along from the pole, and across it.
    const corner = (along, across, offsetX = 0, offsetY = 0) => {
        // The far edge of the flag waves a little.
        const wave = (along / FLAG_LENGTH) * 1.5;
        return {
            x: x + cos * along - sin * (across + wave) + offsetX,
            y: y + sin * along + cos * (across + wave) + offsetY
        };
    };
    const fillQuad = (points, color) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        points.forEach((point, i) => (i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
        ctx.closePath();
        ctx.fill();
    };
    const half = FLAG_HEIGHT / 2;
    fillQuad([
        corner(0, -half, GROUND_SHADOW_OFFSET_X, GROUND_SHADOW_OFFSET_Y),
        corner(FLAG_LENGTH, -half, GROUND_SHADOW_OFFSET_X, GROUND_SHADOW_OFFSET_Y),
        corner(FLAG_LENGTH, half, GROUND_SHADOW_OFFSET_X, GROUND_SHADOW_OFFSET_Y),
        corner(0, half, GROUND_SHADOW_OFFSET_X, GROUND_SHADOW_OFFSET_Y)
    ], FLAG_SHADOW);
    fillQuad([corner(0, -half), corner(FLAG_LENGTH, -half), corner(FLAG_LENGTH, half), corner(0, half)], FLAG_LIGHT);
    const columns = 3;
    const rows = 2;
    const cellLength = FLAG_LENGTH / columns;
    const cellHeight = FLAG_HEIGHT / rows;
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
            if ((row + col) % 2 === 1) continue;
            const along = col * cellLength;
            const across = -half + row * cellHeight;
            fillQuad([
                corner(along, across),
                corner(along + cellLength, across),
                corner(along + cellLength, across + cellHeight),
                corner(along, across + cellHeight)
            ], FLAG_DARK);
        }
    }
    fillCircle(ctx, x + 1, y + 1.2, 2.2, FLAG_SHADOW);
    fillCircle(ctx, x, y, 2, poleColor);
}

// A round bale of hay seen from above, with a flag on its top.
function drawHayBale(ctx, x, y, size, { facing }) {
    fillCircle(ctx, x + GROUND_SHADOW_OFFSET_X, y + GROUND_SHADOW_OFFSET_Y, size, HAY.shadow);
    fillCircle(ctx, x + SHADE_OFFSET_X, y + SHADE_OFFSET_Y, size, HAY.shade);
    fillCircle(ctx, x, y, size, HAY.base);
    // The rolled hay: a spiral from the middle out.
    ctx.strokeStyle = HAY.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const turns = 2.2;
    const steps = 40;
    for (let i = 0; i <= steps; i += 1) {
        const part = i / steps;
        const angle = part * turns * Math.PI * 2;
        const radius = size * (0.15 + part * 0.7);
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.stroke();
    fillCircle(ctx, x + LIGHT_OFFSET_X * 1.6, y + LIGHT_OFFSET_Y * 1.6, size * 0.4, HAY.light);
    drawFlag(ctx, x, y, facing, HAY.pole);
}

// A block of ice seen from above, with a flag on its top. Ice stands out
// from the white snow bank.
function drawIceBlock(ctx, x, y, size, { facing }) {
    const angle = facing + Math.PI / 2;
    const fillBlock = (offsetX, offsetY, scale, color) => {
        ctx.save();
        ctx.translate(x + offsetX, y + offsetY);
        ctx.rotate(angle);
        ctx.fillStyle = color;
        ctx.beginPath();
        const halfLength = size * 0.95 * scale;
        const halfWidth = size * 0.7 * scale;
        const corner = size * 0.25 * scale;
        ctx.moveTo(-halfLength + corner, -halfWidth);
        ctx.arcTo(halfLength, -halfWidth, halfLength, halfWidth, corner);
        ctx.arcTo(halfLength, halfWidth, -halfLength, halfWidth, corner);
        ctx.arcTo(-halfLength, halfWidth, -halfLength, -halfWidth, corner);
        ctx.arcTo(-halfLength, -halfWidth, halfLength, -halfWidth, corner);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    };
    fillBlock(GROUND_SHADOW_OFFSET_X, GROUND_SHADOW_OFFSET_Y, 1, SNOW.shadow);
    fillBlock(SHADE_OFFSET_X, SHADE_OFFSET_Y, 1, ICE.shade);
    fillBlock(0, 0, 1, ICE.base);
    fillBlock(LIGHT_OFFSET_X * 1.4, LIGHT_OFFSET_Y * 1.4, 0.6, ICE.light);
    drawFlag(ctx, x, y, facing, ICE.pole);
}

// Each item: how to draw it, the radius range it draws at, and how far it
// reaches from its middle as a part of its radius (arms, a door tunnel). An
// item with a flag reaches farther on the side away from the road.
export const TRACKSIDE_ITEMS = Object.freeze({
    bush: Object.freeze({ draw: drawBush, minSize: 11, maxSize: 13, reach: 1 }),
    tree: Object.freeze({ draw: drawTree, minSize: 18, maxSize: 21, reach: 1 }),
    pine: Object.freeze({ draw: drawPine, minSize: 15, maxSize: 21, reach: 1 }),
    snowman: Object.freeze({ draw: drawSnowman, minSize: 12, maxSize: 13, reach: 1.5 }),
    igloo: Object.freeze({ draw: drawIgloo, minSize: 17, maxSize: 20, reach: 1.65 }),
    palm: Object.freeze({ draw: drawPalm, minSize: 18, maxSize: 24, reach: 1 }),
    rock: Object.freeze({ draw: drawRock, minSize: 8, maxSize: 13, reach: 1 }),
    umbrella: Object.freeze({ draw: drawUmbrella, minSize: 11, maxSize: 13, reach: 1 }),
    asteroid: Object.freeze({ draw: drawAsteroid, minSize: 12, maxSize: 22, reach: 1 }),
    planet: Object.freeze({ draw: drawPlanet, minSize: 20, maxSize: 26, reach: 1 }),
    satellite: Object.freeze({ draw: drawSatellite, minSize: 14, maxSize: 18, reach: 1 }),
    hayBale: Object.freeze({ draw: drawHayBale, minSize: 10, maxSize: 11, reach: 1, flag: true }),
    iceBlock: Object.freeze({ draw: drawIceBlock, minSize: 10, maxSize: 11, reach: 1, flag: true })
});

// How far an item reaches from its middle on its far side, with a flag.
function getFarReach(item) {
    const flagReach = item.flag ? Math.hypot(FLAG_LENGTH, FLAG_HEIGHT / 2 + 1.5) : 0;
    return Math.max(item.maxSize * item.reach, flagReach);
}

// How far a group of these items can reach from the point it stands at: an
// item stands its own reach away, reaches as far again, and has a shadow.
export function getTracksideItemsExtent(names) {
    const items = names.map((name) => TRACKSIDE_ITEMS[name]).filter(Boolean);
    if (items.length === 0) return 0;
    return Math.max(...items.map((item) => item.maxSize * item.reach + getFarReach(item)))
        + Math.hypot(GROUND_SHADOW_OFFSET_X, GROUND_SHADOW_OFFSET_Y);
}
