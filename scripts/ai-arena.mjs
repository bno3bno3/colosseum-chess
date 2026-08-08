import { chooseVersionedAIAction } from "../server/ai-versions.mjs";
import { createSeededRng, publicStateForAI } from "../server/ai-engine.mjs";
import { createGame, flipPiece, movePiece } from "../server/game-engine.mjs";

const games = Math.max(2, Number.parseInt(process.env.ARENA_GAMES ?? "12", 10) || 12);
const timeLimitMs = Math.max(5, Number.parseInt(process.env.ARENA_TIME_MS ?? "80", 10) || 80);
const initialHealth = Math.max(1, Math.min(16, Number.parseInt(process.env.ARENA_HEALTH ?? "8", 10) || 8));
const maxPlies = Math.max(40, Number.parseInt(process.env.ARENA_MAX_PLIES ?? "220", 10) || 220);
const score = { v1: 0, v2: 0, draws: 0 };
const records = [];

for (let gameIndex = 0; gameIndex < games; gameIndex += 1) {
  // Every adjacent pair uses the exact same board and starting turn, then swaps
  // V1/V2 colors. This removes lucky board/color assignments from the score.
  const pairIndex = Math.floor(gameIndex / 2);
  const gameRng = createSeededRng(0x51f15e + pairIndex * 7919);
  const game = createGame({
    playerIds: ["blue-engine", "red-engine"],
    initialHealth,
    rng: gameRng,
    now: gameIndex * 1_000_000,
  });
  const v2Color = gameIndex % 2 === 0 ? "blue" : "red";
  const versionFor = (color) => color === v2Color ? "v2" : "v1";
  let plies = 0;

  while (game.status === "playing" && plies < maxPlies) {
    const color = game.turn;
    const aiVersion = versionFor(color);
    const result = chooseVersionedAIAction(publicStateForAI(game), color, {
      aiVersion,
      timeLimitMs,
      seed: (gameIndex + 1) * 100_003 + plies * 997 + (aiVersion === "v2" ? 17 : 0),
    });
    const action = result.action;
    if (!action) break;
    const options = { version: game.version, now: gameIndex * 1_000_000 + plies + 1 };
    if (action.type === "flip") flipPiece(game, color, action.index, options);
    else movePiece(game, color, action.from, action.to, options);
    plies += 1;
  }

  let winnerVersion = null;
  if (game.status === "finished") winnerVersion = versionFor(game.winner);
  else if (game.health.blue !== game.health.red) winnerVersion = versionFor(game.health.blue > game.health.red ? "blue" : "red");
  if (winnerVersion) score[winnerVersion] += 1;
  else score.draws += 1;
  records.push({
    game: gameIndex + 1,
    v2Color,
    winner: winnerVersion ?? "draw",
    plies,
    health: game.health,
  });
  console.log(`第 ${gameIndex + 1}/${games} 局：${winnerVersion?.toUpperCase() ?? "和棋"}，${plies} 手，血量 ${game.health.blue}:${game.health.red}`);
}

console.log(JSON.stringify({ games, timeLimitMs, initialHealth, maxPlies, score, records }, null, 2));
