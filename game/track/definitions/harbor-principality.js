import { Point } from '../geometry.js';

export default {
    cornerRadius: 1.2,
    drawWidth: 3,
    outer: [
        Point(6, 32),
        Point(8.25, 33.81),
        Point(11.325, 33.587),
        Point(15.9, 33.438),
        Point(22, 34),
        Point(28, 30),
        Point(30, 24),
        Point(28, 16),
        Point(22, 10),
        Point(14, 6),
        Point(8, 8),
        Point(4, 14),
        Point(4, 22),
        Point(6, 28)
    ],
    inner: [
        Point(10.521, 29.536),
        Point(20, 31),
        Point(24, 28),
        Point(26, 24),
        Point(24, 18),
        Point(20, 13),
        Point(14, 10),
        Point(10, 11),
        Point(8, 16),
        Point(8, 22),
        Point(10, 26)
    ],
    startLine: { p1: Point(14.644, 29.596), p2: Point(14.68, 34.103) },
    startPos: Point(12.134, 31.731),
    startAngle: 0.1,
    checkpoints: [
        { p1: Point(29.966, 26.564), p2: Point(25, 24) },
        { p1: Point(19.677, 8.093), p2: Point(18.261, 12.938) },
        { p1: Point(3.302, 16.332), p2: Point(9.65, 17.598) }
    ]
};
