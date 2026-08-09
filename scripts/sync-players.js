#!/usr/bin/env node
// Generates the browser-consumable player database from the single source of
// truth (data/players.json) into public/js/player-database.js.
//
// Run it after editing data/players.json:  npm run build
//
// The browser cannot require() JSON, hence this step.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'data', 'players.json');
const TARGET = path.join(ROOT, 'public', 'js', 'player-database.js');

const POSITIONS = ['GK', 'DEF', 'MID', 'ATT', 'MGR'];

function fail(msg) {
  console.error(`sync-players: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(SOURCE)) fail(`missing source file ${SOURCE}`);

let players;
try {
  players = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
} catch (err) {
  fail(`data/players.json is not valid JSON: ${err.message}`);
}

// Validate before writing - a broken generated file breaks the whole web app.
const seenIds = new Set();
let total = 0;
for (const pos of POSITIONS) {
  const list = players[pos];
  if (!Array.isArray(list) || list.length < 4) {
    fail(`position "${pos}" must be an array of at least 4 players (briefcases need 4)`);
  }
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || !p.id) fail(`${pos}: player with missing id`);
    if (typeof p.name !== 'string' || !p.name) fail(`${pos}/${p.id}: missing name`);
    if (typeof p.rating !== 'number' || !Number.isFinite(p.rating)) fail(`${pos}/${p.id}: rating must be a number`);
    if (seenIds.has(p.id)) fail(`duplicate player id "${p.id}" (ids must be unique across all positions)`);
    seenIds.add(p.id);
    total++;
  }
  if (pos === 'MGR') {
    for (const p of list) {
      if (!p.tactic) fail(`MGR/${p.id}: managers must have a "tactic"`);
    }
  }
}

const banner = [
  '// AUTO-GENERATED FILE - DO NOT EDIT BY HAND.',
  '// Source: data/players.json   Generator: scripts/sync-players.js  (npm run build)',
  '// Loaded by public/index.html before firebase-engine.js, which reads window.PLAYER_DATABASE.',
  ''
].join('\n');

const body = `window.PLAYER_DATABASE = ${JSON.stringify(players, null, 2)};\n`;

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, banner + body, 'utf8');

const counts = POSITIONS.map(pos => `${pos}:${players[pos].length}`).join(' ');
console.log(`sync-players: wrote ${path.relative(ROOT, TARGET)} (${total} players | ${counts})`);
