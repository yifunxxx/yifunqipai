/**
 * 死牌区：底 112→14 / 144→20；
 * 奇数次需补牌的杠 → 底+1；偶数次 → 回到底。
 */
export function deadWallSize(tileCount: 112 | 144, gangCountNeedingDraw: number): number {
  const base = tileCount === 112 ? 14 : 20;
  return gangCountNeedingDraw % 2 === 1 ? base + 1 : base;
}

/** 可摸张数 = 墙剩余 - 死牌区 */
export function drawableCount(
  wallRemaining: number,
  tileCount: 112 | 144,
  gangCountNeedingDraw: number,
): number {
  return Math.max(0, wallRemaining - deadWallSize(tileCount, gangCountNeedingDraw));
}
