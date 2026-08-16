import { Point } from '../geometry.js';

export default {
    cornerRadius: 3,
    drawWidth: 4,
    lineSmoothing: 0.35,
    outer: [
        Point(6.275, 22.527),
        Point(25.383, 0.556),
        Point(32.327, 1.142),
        Point(34.117, 4.233),
        Point(33.151, 25.002),
        Point(42.056, 25.378),
        Point(40.931, 31.007),
        Point(36.988, 35.843),
        Point(32.297, 37.633),
        Point(32.281, 58.397),
        Point(25.49, 59.664),
        Point(23.126, 57.551),
        Point(21.126, 36.244),
        Point(4, 36.584)
    ],
    inner: [
        Point(10.003, 24.532),
        Point(29.082, 4.222),
        Point(29.701, 27.827),
        Point(36.768, 28.77),
        Point(34.058, 32.628),
        Point(28.477, 34.879),
        Point(28.28, 55.589),
        Point(26.587, 56.2),
        Point(23.833, 32.872),
        Point(9.39, 33.419),
        Point(8.302, 32.295)
    ],
    startLine: { p1: Point(11.305, 15.601), p2: Point(15.772, 19.486) },
    startPos: Point(12.718, 18.486),
    startAngle: -0.855,
    checkpoints: [
        { p1: Point(34.225, 18.002), p2: Point(28.697, 18.147) },
        { p1: Point(33.042, 44.444), p2: Point(27.636, 44.392) },
        { p1: Point(21.026, 43.203), p2: Point(25.742, 42.647) }
    ]
};
