import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deadWallSize, drawableCount } from "./dead-wall.js";
import {
  canWinStandard,
  evaluateHu,
  isQiDui,
  isShiSanYao,
  type Meld,
} from "./mahjong-rules.js";
import { makeTile, resetTileSeq, type Tile } from "./tiles.js";
import { compareHands, isTenHalf, isWuLong, type PokerCard } from "./poker.js";

function t(suit: Tile["suit"], rank: number): Tile {
  return makeTile(suit, rank);
}

describe("dead wall", () => {
  it("112 base 14, odd gang +1, even back", () => {
    assert.equal(deadWallSize(112, 0), 14);
    assert.equal(deadWallSize(112, 1), 15);
    assert.equal(deadWallSize(112, 2), 14);
    assert.equal(deadWallSize(144, 0), 20);
    assert.equal(deadWallSize(144, 1), 21);
  });

  it("drawable respects dead wall", () => {
    assert.equal(drawableCount(40, 112, 0), 26);
    assert.equal(drawableCount(40, 112, 1), 25);
  });
});

describe("mahjong hu", () => {
  it("standard ping hu", () => {
    resetTileSeq();
    // 123万 456万 789万 111筒 22条
    const hand = [
      t("wan", 1),
      t("wan", 2),
      t("wan", 3),
      t("wan", 4),
      t("wan", 5),
      t("wan", 6),
      t("wan", 7),
      t("wan", 8),
      t("wan", 9),
      t("tong", 1),
      t("tong", 1),
      t("tong", 1),
      t("tiao", 2),
      t("tiao", 2),
    ];
    assert.equal(canWinStandard(hand), true);
    const r = evaluateHu(hand, [], 112);
    assert.equal(r.ok, true);
    assert.equal(r.multiplier, 1);
  });

  it("qi dui multiplier 2", () => {
    resetTileSeq();
    const hand = [
      t("wan", 1),
      t("wan", 1),
      t("wan", 3),
      t("wan", 3),
      t("tong", 2),
      t("tong", 2),
      t("tong", 5),
      t("tong", 5),
      t("tiao", 7),
      t("tiao", 7),
      t("tiao", 9),
      t("tiao", 9),
      t("zi", 5),
      t("zi", 5),
    ];
    assert.equal(isQiDui(hand), true);
    const r = evaluateHu(hand, [], 112);
    assert.equal(r.ok, true);
    assert.equal(r.multiplier, 2);
  });

  it("shi san yao only 144", () => {
    resetTileSeq();
    const hand = [
      t("wan", 1),
      t("wan", 9),
      t("tong", 1),
      t("tong", 9),
      t("tiao", 1),
      t("tiao", 9),
      t("zi", 1),
      t("zi", 2),
      t("zi", 3),
      t("zi", 4),
      t("zi", 5),
      t("zi", 6),
      t("zi", 7),
      t("zi", 7),
    ];
    assert.equal(isShiSanYao(hand), true);
    assert.equal(evaluateHu(hand, [], 112).ok, false);
    assert.equal(evaluateHu(hand, [], 144).ok, true);
    assert.equal(evaluateHu(hand, [], 144).multiplier, 2);
  });

  it("qing yi se with melds", () => {
    resetTileSeq();
    const melds: Meld[] = [
      {
        type: "peng",
        tiles: [t("wan", 1), t("wan", 1), t("wan", 1)],
      },
    ];
    const hand = [
      t("wan", 2),
      t("wan", 3),
      t("wan", 4),
      t("wan", 5),
      t("wan", 6),
      t("wan", 7),
      t("wan", 8),
      t("wan", 8),
      t("wan", 9),
      t("wan", 9),
      t("wan", 9),
    ];
    const r = evaluateHu(hand, melds, 112);
    assert.equal(r.ok, true);
    assert.ok(r.patterns.includes("qingYiSe"));
    assert.equal(r.multiplier, 2);
  });
});

describe("tenhalf strength", () => {
  function c(rank: number): PokerCard {
    return { id: `x${rank}`, suit: "S", rank };
  }

  it("wulong beats tenhalf", () => {
    const wulong = [c(1), c(2), c(3), c(4), c(11)]; // 1+2+3+4+0.5=10.5, 5 cards
    const tenhalf = [c(10), c(11)]; // 10.5
    assert.equal(isWuLong(wulong), true);
    assert.equal(isTenHalf(tenhalf), true);
    assert.ok(compareHands(wulong, tenhalf) > 0);
  });
});
