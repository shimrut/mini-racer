import { Point } from '../geometry.js';

export default {
    cornerRadius: 3,
    drawWidth: 4,
    lineSmoothing: 0.35,
    outer: [
        Point(6.275, 22.527),
        Point(25.383, 0.556),
        Point(32.327, 1.142),
        Point(33.151, 25.002),
        Point(40.209, 25.664),
        Point(36.988, 35.843),
        Point(31.915, 36.348),
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
        Point(36.718, 27.812),
        Point(34.058, 32.628),
        Point(28.543, 32.738),
        Point(28.28, 55.589),
        Point(26.587, 56.2),
        Point(23.833, 32.872),
        Point(9.39, 33.419),
        Point(8.302, 32.295)
    ],
    startLine: { p1: Point(11.298, 15.609), p2: Point(15.609, 19.659) },
    startPos: Point(12.598, 18.545),
    startAngle: -0.817,
    checkpoints: [
        { p1: Point(33.653, 17.795), p2: Point(28.691, 17.925) },
        { p1: Point(32.79, 43.856), p2: Point(27.664, 43.941) },
        { p1: Point(21.063, 43.597), p2: Point(25.872, 43.059) }
    ]
};
