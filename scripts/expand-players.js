// Second iteration of the one-time data expansion (replaces the earlier
// version, which is why this always runs from the CLEAN base data - never
// re-run on top of its own output). First attempt subtracted rating for
// every variant, which produced two real bugs once real card names got
// involved: (1) a retired legend's "lesser" card had nowhere real to
// anchor to (fixed by not touching Legend Icon players at all here), and
// (2) real current pros - already realistically rated in the base file -
// ended up with unrealistically weak duplicate cards (a Tottenham/Man
// City/Atletico starting goalkeeper does not have a 60-68 rated version).
// This version instead gives well-known players EXTRA STRONG cards
// (same-or-higher rating, "special edition" flavor), matching how real
// card games actually treat popular players - more good cards, not a
// bronze downgrade nobody asked for.
//
// Usage: node scripts/expand-players.js
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'players.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

function editionForRating(rating) {
  if (rating >= 93) return 'Icon Gold 🟡';
  if (rating >= 88) return 'TOTW 🌟';
  if (rating >= 83) return 'Gold 🟡';
  return 'Silver 🔴';
}

function clampRating(r) {
  return Math.max(70, Math.min(99, r));
}

let addedCount = 0;

Object.keys(data).forEach((posKey) => {
  const arr = data[posKey];
  const allIds = new Set(arr.map(p => p.id));
  const additions = [];

  arr.forEach((base) => {
    const baseRating = parseInt(base.rating) || 75;
    // Retired/legend cards (no real current club) stay a single definitive
    // card - there's no realistic "extra edition" to anchor to.
    if (base.club === 'Legend Icon') return;
    // Only players already good enough to be a name people recognize get
    // an extra card - a random 71-rated squad player doesn't need one.
    if (baseRating < 80) return;

    let id = `${base.id}_sp`;
    let n = 2;
    while (allIds.has(id)) { id = `${base.id}_sp${n}`; n++; }
    allIds.add(id);

    // +1..+6, so the extra card is always the SAME tier or better, never a
    // downgrade - a "special edition" in the literal sense.
    const rating = clampRating(baseRating + 1 + Math.floor(Math.random() * 6));
    additions.push({
      id,
      name: base.name,
      rating,
      club: base.club,
      nation: base.nation,
      flag: base.flag,
      edition: editionForRating(rating),
      ...(base.tactic ? { tactic: base.tactic } : {})
    });
  });

  data[posKey] = arr.concat(additions);
  addedCount += additions.length;
});

fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
const finalTotal = Object.values(data).reduce((sum, arr) => sum + arr.length, 0);
console.log(`expand-players: added ${addedCount} special-edition cards - new total ${finalTotal}`);
