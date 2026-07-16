import { Point } from '../geometry.js';

export default {
    outer: [
        Point(2, 2),
        Point(15, 2),
        Point(20.045, 4.973),
        Point(25, 5),
        Point(29.969, 8.009),
        Point(30, 15),
        Point(25.039, 20.015),
        Point(10, 20),
        Point(5.011, 14.987),
        Point(2, 10)
    ],
    inner: [
        Point(6, 6),
        Point(13, 6),
        Point(15.979, 7.992),
        Point(22, 8),
        Point(23.991, 10.02),
        Point(24, 13),
        Point(20.009, 15.977),
        Point(10, 16),
        Point(7.949, 13.063),
        Point(6, 10)
    ],
    startLine: { p1: Point(10.002, 1.177), p2: Point(10.057, 6.583) },
    startPos: Point(8, 4),
    startAngle: 0,
    checkpoints: [
        { p1: Point(22.501, 4.555), p2: Point(22.469, 8.833) },
        { p1: Point(20.782, 20.542), p2: Point(20.737, 14.911) },
        { p1: Point(4.521, 14.617), p2: Point(8.06, 12.616) }
    ]
};
