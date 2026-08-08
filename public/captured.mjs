export const CAPTURE_ORDER = Object.freeze([
  "mouse",
  "cat",
  "snake",
  "dog",
  "wolf",
  "tiger",
  "elephant",
  "football",
]);

const ORDER_INDEX = new Map(CAPTURE_ORDER.map((type, index) => [type, index]));

export function groupCapturedPieces(pieces = []) {
  const groups = new Map();
  for (const piece of pieces) {
    if (!piece?.type) continue;
    const current = groups.get(piece.type) ?? { type: piece.type, color: piece.color, count: 0 };
    current.count += 1;
    groups.set(piece.type, current);
  }
  return [...groups.values()].sort((left, right) => (
    (ORDER_INDEX.get(left.type) ?? Number.MAX_SAFE_INTEGER) -
    (ORDER_INDEX.get(right.type) ?? Number.MAX_SAFE_INTEGER)
  ));
}
