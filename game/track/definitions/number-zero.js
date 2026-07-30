import { Point } from '../geometry.js';

export default {
    cornerRadius: 3,
    drawWidth: 4,
    lineSmoothing: 0.35,
    outer: [
        Point(4.291, 14.179),
        Point(11.88, 6.092),
        Point(21.869, 10.227),
        Point(27.415, 17.889),
        Point(28.303, 41.612),
        Point(23.084, 45.868),
        Point(11.188, 43.319),
        Point(5.368, 36.598)
    ],
    inner: [
        Point(9.035, 15.459),
        Point(13.436, 9.459),
        Point(20.374, 13.306),
        Point(23.221, 18.686),
        Point(24.191, 40.498),
        Point(21.801, 42.566),
        Point(13.481, 40.592),
        Point(9.952, 35.191)
    ],
    startLine: { p1: Point(3.767, 18.891), p2: Point(9.932, 18.595) },
    startPos: Point(6.909, 19.992),
    startAngle: -1.619,
    checkpoints: [
        { p1: Point(24.856, 13.086), p2: Point(20.601, 15.338) },
        { p1: Point(28.876, 36.878), p2: Point(23.29, 37.127) },
        { p1: Point(7.803, 40.546), p2: Point(12.389, 37.549) }
    ]
};
