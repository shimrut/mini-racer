import { Point } from '../geometry.js';

export default {
    cornerRadius: 2,
    outer: [
        Point(12, 10),
        Point(58, 10),
        Point(64, 14),
        Point(60, 18),
        Point(56, 24),
        Point(52, 34),
        Point(49.189, 37.898),
        Point(40.325, 36.103),
        Point(28, 46),
        Point(14, 42),
        Point(14.177, 32.812),
        Point(5.309, 26.784),
        Point(8, 14)
    ],
    inner: [
        Point(16, 14),
        Point(52, 14),
        Point(57.323, 16.602),
        Point(57.48, 17.12),
        Point(55, 20),
        Point(51, 26),
        Point(47, 34),
        Point(40.129, 32.361),
        Point(28, 42),
        Point(18, 38),
        Point(19.558, 30.164),
        Point(10.478, 24.991),
        Point(12, 18)
    ],
    startLine: { p1: Point(27.998, 9.493), p2: Point(28.001, 14.648) },
    startPos: Point(25.606, 12.226),
    startAngle: 0,
    checkpoints: [
        { p1: Point(54.666, 16.182), p2: Point(54.849, 9.245) },
        { p1: Point(44.902, 33.147), p2: Point(44.305, 37.413) },
        { p1: Point(19.101, 37.252), p2: Point(13.234, 42.055) },
        { p1: Point(5.304, 23.649), p2: Point(11.456, 23.49) }
    ]
};
