export const footballPoisonRule = Object.freeze({
  id: "football-poison",
  name: "足球中毒",
  shortName: "中毒",
  description: "吃掉足球或中毒单位会中毒；3 个己方回合后死亡，继续吃子可解毒。",

  afterCapture({ attacker, defender }) {
    const wasPoisoned = Boolean(attacker.poisoned);
    delete attacker.poisoned;
    delete attacker.poisonTurns;

    const infected = defender.type === "football" || Boolean(defender.poisoned);
    if (infected) {
      attacker.poisoned = true;
      attacker.poisonTurns = 3;
    }
    return { cured: wasPoisoned, poisoned: infected };
  },

  afterTurn({ game, color, skipPieceIds = [], skipIndexes = [] }) {
    const skipped = new Set(skipPieceIds);
    const skippedCells = new Set(skipIndexes);
    const deaths = [];
    for (let index = 0; index < game.board.length; index += 1) {
      const piece = game.board[index];
      if (!piece?.poisoned || piece.color !== color || skippedCells.has(index) || (piece.id && skipped.has(piece.id))) continue;
      piece.poisonTurns = Math.max(0, Number(piece.poisonTurns ?? 3) - 1);
      if (piece.poisonTurns > 0) continue;
      game.board[index] = null;
      game.health[color] = Math.max(0, game.health[color] - 1);
      const captor = color === "blue" ? "red" : "blue";
      game.capturedBy[captor].push({ type: piece.type, color: piece.color, cause: "poison" });
      deaths.push({ index, type: piece.type, color: piece.color });
    }
    return { poisonDeaths: deaths };
  },
});
