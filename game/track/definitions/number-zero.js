import { Point } from '../geometry.js';

export default {
    cornerRadius: 3,
    drawWidth: 4,
    lineSmoothing: 0.35,
    outer: [
        Point(4.291, 14.179),
        Point(11.88, 6.092),
        Point(22.484, 10.306),
        Point(28.076, 18.267),
        Point(29.006, 42.017),
        Point(23.198, 46.496),
        Point(11.04, 44.17),
        Point(5.368, 36.598)
    ],
    inner: [
        Point(9.035, 15.459),
        Point(13.767, 10.066),
        Point(20.374, 13.306),
        Point(23.221, 18.686),
        Point(24.191, 40.498),
        Point(21.801, 42.566),
        Point(13.481, 40.592),
        Point(9.952, 35.191)
    ],
    startLine: { p1: Point(3.82, 20.008), p2: Point(9.984, 19.721) },
    startPos: Point(6.96, 21.113),
    startAngle: -1.617,
    checkpoints: [
        { p1: Point(25.216, 12.9), p2: Point(20.603, 15.341) },
        { p1: Point(29.552, 36.805), p2: Point(23.287, 37.05) },
        { p1: Point(7.415, 40.582), p2: Point(12.084, 37.085) }
    ]
};
