import { Point } from '../geometry.js';

export default {
    cornerRadius: 1.8,
    drawWidth: 4,
    outer: [
        Point(10, 12),
        Point(50, 12),
        Point(54, 16),
        Point(54, 28),
        Point(50, 32),
        Point(50, 40),
        Point(46, 44),
        Point(30, 44),
        Point(14, 44),
        Point(10, 40),
        Point(10, 28),
        Point(6, 24)
    ],
    inner: [
        Point(14, 16),
        Point(46, 16),
        Point(49, 19),
        Point(49, 27),
        Point(46, 30),
        Point(46, 37),
        Point(42, 40),
        Point(30, 40),
        Point(18, 40),
        Point(14, 37),
        Point(14, 28),
        Point(11, 26)
    ],
    startLine: { p1: Point(24, 12), p2: Point(24, 16) },
    startPos: Point(20, 14),
    startAngle: 0,
    checkpoints: [
        { p1: Point(54.9, 21.156), p2: Point(48.414, 21.643) },
        { p1: Point(44.129, 45.238), p2: Point(44.027, 37.963) },
        { p1: Point(11.283, 42.113), p2: Point(16, 38) }
    ]
};
