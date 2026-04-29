import type { PieceType, Color } from "@shared/games/xiangqi";

// Traditional Chinese (Red) and Simplified Chinese (Black) glyphs as
// they appear on a real Xiangqi set. Red plays the "帥/仕/相/傌/俥/炮/兵"
// side; black plays "將/士/象/馬/車/砲/卒".
export const PIECE_GLYPHS: Record<Color, Record<PieceType, string>> = {
  red: {
    G: "帥",
    A: "仕",
    E: "相",
    H: "傌",
    R: "俥",
    C: "炮",
    S: "兵",
  },
  black: {
    G: "將",
    A: "士",
    E: "象",
    H: "馬",
    R: "車",
    C: "砲",
    S: "卒",
  },
};

export function pieceGlyph(color: Color, type: PieceType): string {
  return PIECE_GLYPHS[color][type];
}
