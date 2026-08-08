const COLS = 4;

function point(index) {
  return { row: Math.floor(index / COLS), col: index % COLS };
}

export const snakeRule = Object.freeze({
  id: "snake",
  name: "蛇",
  shortName: "蛇",
  description: "每方一只猫替换为蛇；吓退时蛇保持原位，退路被挡或越界时才进入目标格吃掉（大象免疫）。",

  modifyPieceCounts(counts) {
    counts.cat -= 1;
    counts.snake = 1;
  },

  normalizeAnimalType(type) {
    return type === "snake" ? "cat" : type;
  },

  attackOutcome({ board, from, to, attacker, defender }) {
    if (attacker.type !== "snake") return null;
    if (defender.type === "elephant") return { legal: false, kind: "immune" };
    const source = point(from);
    const target = point(to);
    const rowStep = target.row - source.row;
    const colStep = target.col - source.col;
    const retreatRow = target.row + rowStep;
    const retreatCol = target.col + colStep;
    if (retreatRow < 0 || retreatRow >= 8 || retreatCol < 0 || retreatCol >= COLS) {
      return { legal: true, kind: "capture", retreatTo: null };
    }
    const retreatTo = retreatRow * COLS + retreatCol;
    return board[retreatTo]
      ? { legal: true, kind: "capture", retreatTo }
      : { legal: true, kind: "push", retreatTo };
  },
});
