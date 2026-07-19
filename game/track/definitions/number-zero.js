import { Point } from '../geometry.js';

export default {
    cornerRadius: 3,
    drawWidth: 5,
    lineSmoothing: 0.35,
    outer: [
        Point(5.171, 14.468),
        Point(11.562, 5.958),
        Point(21.869, 10.227),
        Point(26.211, 18.077),
        Point(27.276, 41.362),
        Point(23.084, 45.868),
        Point(11.188, 43.319),
        Point(6.851, 36.577)
    ],
    inner: [
        Point(9.035, 15.459),
        Point(13.438, 9.363),
        Point(20.405, 12.924),
        Point(23.221, 18.686),
        Point(24.191, 40.498),
        Point(21.714, 42.962),
        Point(13.481, 40.592),
        Point(9.952, 35.191)
    ],
    startLine: { p1: Point(3.127, 18.274), p2: Point(10.243, 18.27) },
    startPos: Point(7.469, 19.881),
    startAngle: -1.59,
    checkpoints: [
        { p1: Point(21.587, 14.905), p2: Point(26.472, 10.295) },
        { p1: Point(23.159, 39.264), p2: Point(27.57, 39.151) },
        { p1: Point(13.331, 37.759), p2: Point(8.323, 41.442) }
    ]
};
