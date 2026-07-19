import { Point } from '../geometry.js';

export default {
    cornerRadius: 3,
    drawWidth: 4,
    lineSmoothing: 0.35,
    outer: [
        Point(6.275, 22.527),
        Point(26.118, 1.29),
        Point(32.327, 1.142),
        Point(33.772, 25.067),
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
        Point(28.573, 5.187),
        Point(30.482, 27.773),
        Point(36.718, 27.812),
        Point(34.058, 32.628),
        Point(28.543, 32.738),
        Point(28.28, 55.589),
        Point(26.587, 56.2),
        Point(23.923, 32.385),
        Point(9.39, 33.419),
        Point(8.302, 32.295)
    ],
    startLine: { p1: Point(11.721, 15.2), p2: Point(16.024, 19.721) },
    startPos: Point(13.136, 18.065),
    startAngle: -0.86,
    checkpoints: [
        { p1: Point(28.783, 18.548), p2: Point(34.182, 18.135) },
        { p1: Point(27.842, 43.95), p2: Point(32.941, 44.004) },
        { p1: Point(25.608, 43.247), p2: Point(21.122, 43.605) }
    ]
};
