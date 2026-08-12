// Auction ("المزاد") game engine - Firebase Realtime Database Engine.
//
// Loaded on public/mazad/index.html AFTER public/js/firebase-engine.js, which
// already did the Firebase init (idempotent guard) and defines everything
// this file reuses without redeclaring: firebaseConfig, db, sanitizeName,
// myPlayerId, PLAYER_DATABASE, getPositionsForMode, basePositionKey,
// normPlayerName, buildEmptySquad. Rooms live under 'mazad_rooms/' - a
// completely separate Firebase path from dond's 'dond_rooms/', so the same
// room code can exist in both games with zero collision.

function mazadBudgetFor(squadMode) {
  return squadMode === 'full' ? 1000000000 : 250000000;
}

// The absolute minimum amount the NEXT bid must reach - a fixed floor to
// open a round (still a placeholder default; the user mentioned a
// reference video for the exact real mechanic but hasn't described it),
// then a percentage of the current bid once bidding is underway, so
// raises scale with how expensive the player has already gotten instead
// of the same flat step whether the bid is at the floor or 100x it.
function mazadMinNextBid(squadMode, currentBid) {
  const floor = squadMode === 'full' ? 4000000 : 1000000;
  const bid = parseInt(currentBid) || 0;
  if (bid <= 0) return floor;
  const pctIncrement = Math.round(bid * 0.05);
  return bid + Math.max(floor, pctIncrement);
}

function mazadOpposite(side) {
  return side === 'host' ? 'guest' : 'host';
}

// Firebase drops any object key whose value is null the moment it's
// written - buildEmptySquad's {GK:null,DEF:null,...} round-trips through
// the real database as {} (or the squad field missing entirely), not as an
// object with null-valued keys. So Object.keys(squad) can only ever surface
// OCCUPIED slots; "which slots are still empty" has to be computed against
// the mode's known position keys, not against whatever keys happen to
// currently exist in the stored (already-pruned) squad object. Getting
// this wrong makes every squad look instantly "full" the moment it's
// written, which is exactly the bug this was rewritten to fix (a fresh
// all-empty room read back as needing nothing, jumping straight to match
// simulation with zero players on either side).
function mazadEmptySlotsForBase(squad, base, squadMode) {
  return getPositionsForMode(squadMode).filter(k => basePositionKey(k) === base && !(squad && squad[k]));
}

// Walks base positions in a fixed order (GK, DEF, MID, ATT, MGR) and returns
// the first one either side still has room in. Deterministic progression:
// every GK round happens before any DEF round, etc.
function mazadNextNeededBase(room) {
  const bases = [];
  getPositionsForMode(room.squadMode).forEach(k => {
    const b = basePositionKey(k);
    if (!bases.includes(b)) bases.push(b);
  });
  for (const base of bases) {
    const hostOpen = mazadEmptySlotsForBase(room.host.squad, base, room.squadMode).length > 0;
    const guestOpen = room.guest ? mazadEmptySlotsForBase(room.guest.squad, base, room.squadMode).length > 0 : false;
    if (hostOpen || guestOpen) return { base, hostOpen, guestOpen };
  }
  return null;
}

// Returns an empty slot in the same base position, or null.
// Bonus/consolation is silently dropped when the base is already full —
// never spill into a different position (e.g. DEF after a GK round).
function mazadFindSlotFor(squad, base, squadMode) {
  const sameBase = mazadEmptySlotsForBase(squad, base, squadMode);
  return sameBase.length ? sameBase[0] : null;
}

// Draws one unused player from a base position pool, at or above startRating,
// stepping the floor down (87 -> 84 -> 80 -> 75 -> 70 -> 60 -> 0) if that
// tier has nobody left - keeps the draft moving instead of stalling once the
// elite tier of a position runs dry.
function mazadDrawFromBase(base, usedNames, startRating) {
  const pool = (PLAYER_DATABASE[base] || []).filter(p => !usedNames.includes(normPlayerName(p.name)));
  const steps = [startRating, ...[87, 84, 80, 75, 70, 60, 0].filter(s => s <= startRating)];
  for (const s of steps) {
    const candidates = pool.filter(p => (parseInt(p.rating) || 0) >= s);
    if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return null;
}

const AuctionEngine = {
  get myPlayerId() {
    return myPlayerId;
  },

  createRoom(roomId, playerName, squadMode) {
    const finalRoomId = roomId && roomId.trim().length > 0
      ? roomId.trim()
      : Math.floor(1000 + Math.random() * 9000).toString();
    const mode = squadMode === 'full' ? 'full' : 'classic';
    const roomRef = db.ref('mazad_rooms/' + finalRoomId);
    const sanitizedName = sanitizeName(playerName);
    const budget = mazadBudgetFor(mode);

    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      const STALE_ROOM_MS = 6 * 60 * 60 * 1000;
      const isStale = room && (
        room.status === 'finished' ||
        !room.createdAt ||
        (Date.now() - room.createdAt) > STALE_ROOM_MS
      );
      if (room && room.host && room.host.id !== myPlayerId && !isStale) {
        throw new Error('ROOM_TAKEN');
      }

      const initialRoom = {
        roomId: finalRoomId,
        status: 'waiting_guest',
        createdAt: Date.now(),
        squadMode: mode,
        budgetStart: budget,
        usedPlayerIds: [],
        host: { id: myPlayerId, name: sanitizedName, squad: buildEmptySquad(mode), budget, budgetSpent: 0 },
        guest: null,
        spectatorsCount: 0,
        roundNumber: 0,
        currentRoundOpener: 'host',
        roundState: null,
        lastRoundResult: null,
        matchSimulation: null,
        winner: null
      };
      return roomRef.set(initialRoom).then(() => finalRoomId);
    });
  },

  joinRoom(roomId, playerName) {
    const finalRoomId = (roomId || '').trim();
    if (!finalRoomId) return Promise.reject(new Error('EMPTY_CODE'));
    const roomRef = db.ref('mazad_rooms/' + finalRoomId);
    const sanitizedName = sanitizeName(playerName);

    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room || !room.host) throw new Error('ROOM_NOT_FOUND');
      if (room.host.id === myPlayerId) return finalRoomId;
      if (room.guest && room.guest.id === myPlayerId) return finalRoomId;
      if (room.guest && room.guest.id !== myPlayerId) return finalRoomId; // spectator

      const guestData = {
        id: myPlayerId,
        name: sanitizedName,
        squad: buildEmptySquad(room.squadMode),
        budget: room.budgetStart,
        budgetSpent: 0
      };
      return roomRef.child('guest').set(guestData)
        .then(() => roomRef.child('status').set('auction'))
        .then(() => mazadAdvanceAuction(finalRoomId))
        .then(() => finalRoomId);
    });
  },

  enterRoom(roomId, playerName) {
    const finalRoomId = (roomId || '').trim();
    if (!finalRoomId) return Promise.reject(new Error('EMPTY_CODE'));
    const roomRef = db.ref('mazad_rooms/' + finalRoomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (room && room.host && room.host.id === myPlayerId) return finalRoomId;
      if (room && room.guest && room.guest.id === myPlayerId) return finalRoomId;
      return this.joinRoom(finalRoomId, playerName);
    });
  },

  leaveRoom() {
    if (window._mazadActiveRoomRef) {
      window._mazadActiveRoomRef.off();
      window._mazadActiveRoomRef = null;
    }
  },

  listenToRoom(roomId, onUpdate) {
    this.leaveRoom();
    const roomRef = db.ref('mazad_rooms/' + roomId);
    window._mazadActiveRoomRef = roomRef;
    roomRef.on('value', snapshot => {
      const room = snapshot.val();
      if (!room) return;
      if (room.isAiMode && room.status === 'auction' && room.roundState && room.roundState.turn === 'guest') {
        mazadRunAiTurn(roomId, room);
      }
      onUpdate(room);
    });
  },

  // side is derived from myPlayerId, never trusted from a caller argument -
  // a spectator or the wrong tab simply can't produce a valid side.
  _mySide(room) {
    if (room.host && room.host.id === myPlayerId) return 'host';
    if (room.guest && room.guest.id === myPlayerId) return 'guest';
    return null;
  },

  // trustedSide is only ever passed by the AI-turn code below - the AI has
  // no real myPlayerId to derive 'guest' from via _mySide, so it's the one
  // caller allowed to assert its own side directly. Never wired to any
  // human-facing button.
  placeBid(roomId, amount, trustedSide) {
    const roomRef = db.ref('mazad_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      const side = trustedSide || this._mySide(room);
      if (!side) throw new Error('NOT_A_PLAYER');
      const rs = room.roundState;
      if (!rs || rs.status !== 'bidding') throw new Error('NO_ACTIVE_ROUND');
      if (rs.turn !== side) throw new Error('NOT_YOUR_TURN');

      const bid = parseInt(amount) || 0;
      const minNext = mazadMinNextBid(room.squadMode, rs.currentBid);
      if (bid < minNext) throw new Error('BID_TOO_LOW');
      const remaining = (room[side].budget || 0) - (room[side].budgetSpent || 0);
      if (bid > remaining) throw new Error('OVER_BUDGET');

      const history = (rs.history || []).concat([{ side, amount: bid, ts: Date.now() }]).slice(-40);
      return roomRef.child('roundState').update({
        currentBid: bid,
        currentBidder: side,
        turn: mazadOpposite(side),
        history
      });
    });
  },

  passBid(roomId, trustedSide) {
    const roomRef = db.ref('mazad_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      const side = trustedSide || this._mySide(room);
      if (!side) throw new Error('NOT_A_PLAYER');
      const rs = room.roundState;
      if (!rs || rs.status !== 'bidding') throw new Error('NO_ACTIVE_ROUND');
      if (rs.turn !== side) throw new Error('NOT_YOUR_TURN');
      if (!rs.currentBid || !rs.currentBidder) throw new Error('NO_BID_YET');

      return mazadResolveContestedRound(roomId, room);
    });
  },

  // Single-player: guest is a scripted AI bot (isAiMode), auction starts
  // immediately since both seats already exist - no need to wait for a
  // second joinRoom.
  enterAiRoom(playerName, squadMode) {
    const aiRoomId = 'AI_' + Math.floor(1000 + Math.random() * 9000);
    const mode = squadMode === 'full' ? 'full' : 'classic';
    const budget = mazadBudgetFor(mode);
    const roomRef = db.ref('mazad_rooms/' + aiRoomId);
    const sanitizedName = sanitizeName(playerName);

    const initialRoom = {
      roomId: aiRoomId,
      status: 'auction',
      createdAt: Date.now(),
      isAiMode: true,
      squadMode: mode,
      budgetStart: budget,
      usedPlayerIds: [],
      host: { id: myPlayerId, name: sanitizedName, squad: buildEmptySquad(mode), budget, budgetSpent: 0 },
      guest: { id: 'AI_BOT_PLAYER_ID', name: '🤖 البوت الذكي (AI)', isAi: true, squad: buildEmptySquad(mode), budget, budgetSpent: 0 },
      spectatorsCount: 0,
      roundNumber: 0,
      currentRoundOpener: 'host',
      roundState: null,
      lastRoundResult: null,
      matchSimulation: null,
      winner: null
    };
    return roomRef.set(initialRoom).then(() => mazadAdvanceAuction(aiRoomId)).then(() => aiRoomId);
  },

  // Rematch: resets an EXISTING room back to a fresh auction (same room
  // code, same host/guest identities) instead of sending both players back
  // to the lobby to create/join a brand new room - matches dond's
  // restartGame in firebase-engine.js.
  restartAuction(roomId) {
    const roomRef = db.ref('mazad_rooms/' + roomId);
    return roomRef.once('value').then(snapshot => {
      const room = snapshot.val();
      if (!room) return;
      const mode = room.squadMode;
      const budget = room.budgetStart;
      const updates = {
        status: 'auction',
        usedPlayerIds: [],
        roundNumber: 0,
        currentRoundOpener: 'host',
        roundState: null,
        lastRoundResult: null,
        matchSimulation: null,
        winner: null,
        'host/squad': buildEmptySquad(mode),
        'host/budgetSpent': 0,
        'guest/squad': buildEmptySquad(mode),
        'guest/budgetSpent': 0
      };
      return roomRef.update(updates).then(() => mazadAdvanceAuction(roomId));
    });
  }
};

// AI bidding decision. Runs entirely in the human host's own browser tab -
// same reasoning as dond's _runAiTurn in firebase-engine.js: there is no
// second real client for the AI seat, so the host's tab plays both sides,
// gated by isAiMode + whose turn it currently is. turnKey (round + history
// length) rather than just roomId dedupes per-decision, not per-room, so
// the AI can act again on its very next turn in the same round without the
// earlier guard blocking it.
function mazadRunAiTurn(roomId, room) {
  const turnKey = roomId + ':' + (room.roundNumber || 0) + ':' + ((room.roundState && room.roundState.history) || []).length;
  if (!window._mazadAiTurns) window._mazadAiTurns = new Set();
  if (window._mazadAiTurns.has(turnKey)) return;
  window._mazadAiTurns.add(turnKey);

  const delay = 1100 + Math.random() * 1700;
  setTimeout(() => {
    const roomRef = db.ref('mazad_rooms/' + roomId);
    roomRef.once('value').then(snapshot => {
      const freshRoom = snapshot.val();
      if (!freshRoom || !freshRoom.isAiMode) return;
      const rs = freshRoom.roundState;
      if (!rs || rs.status !== 'bidding' || rs.turn !== 'guest') return;

      const remaining = (freshRoom.guest.budget || 0) - (freshRoom.guest.budgetSpent || 0);
      const minNext = mazadMinNextBid(freshRoom.squadMode, rs.currentBid);
      const rating = parseInt(rs.player && rs.player.rating) || 90;

      // Gets keener for a higher-rated player, warier the bigger a bite
      // this bid takes out of what's left of its budget, plus a little
      // randomness so it doesn't play identically every match.
      const spendFraction = minNext / Math.max(1, remaining);
      const ratingPull = (rating - 90) * 0.025;
      const willingness = 0.62 + ratingPull - spendFraction * 0.9 + (Math.random() * 0.3 - 0.15);
      const canAfford = minNext <= remaining;

      let action;
      if (canAfford && (rs.currentBid === 0 || willingness > 0.32)) {
        const bump = Math.random() < 0.3 ? (minNext - (rs.currentBid || 0)) : 0;
        const amount = Math.min(remaining, minNext + bump);
        action = AuctionEngine.placeBid(roomId, amount, 'guest');
      } else if (rs.currentBid > 0) {
        action = AuctionEngine.passBid(roomId, 'guest');
      } else {
        // Opener with no real budget left for even the floor bid - an
        // extreme late-draft edge case. Bid whatever it can; if that's
        // still under the minimum the engine rejects it and this round
        // just stalls on the AI's turn, same as a human being unable to act.
        action = AuctionEngine.placeBid(roomId, Math.max(remaining, 0), 'guest');
      }
      action.catch(err => console.error('AI bid error:', err));
    });
  }, delay);
}

// Winner: debited the winning bid, gets the auctioned player + a free bonus
// player (rating>=84, same base position, cascading fallback slot). Loser:
// gets a free consolation player (rating>=85, same rules). Both amounts/
// tiers per the user's explicit rules. Runs as a direct continuation of the
// pass action that just completed the round - never from a passive listener
// both clients run - so host and guest can never race to resolve it twice.
function mazadResolveContestedRound(roomId, room) {
  const roomRef = db.ref('mazad_rooms/' + roomId);
  const rs = room.roundState;
  const base = rs.basePosition;
  const player = rs.player;
  const winnerSide = rs.currentBidder;
  const loserSide = mazadOpposite(winnerSide);
  const winningBid = rs.currentBid;

  let usedIds = (room.usedPlayerIds || []).slice();
  usedIds.push(normPlayerName(player.name));

  const winnerSquad = Object.assign({}, room[winnerSide].squad);
  const auctionedSlot = mazadFindSlotFor(winnerSquad, base, room.squadMode);
  if (auctionedSlot) winnerSquad[auctionedSlot] = player;

  // Reuse pre-drawn player or draw from the actual slot's base position (e.g. DEF if placing GK in DEF)
  const bonusSlot = mazadFindSlotFor(winnerSquad, base, room.squadMode);
  let bonusPlayer = null;
  let bonusPlaced = false;
  if (bonusSlot) {
    const bonusBase = basePositionKey(bonusSlot);
    bonusPlayer = rs.previewBonus || mazadDrawFromBase(bonusBase, usedIds, 84);
    if (bonusPlayer) {
      usedIds.push(normPlayerName(bonusPlayer.name));
      winnerSquad[bonusSlot] = bonusPlayer;
      bonusPlaced = true;
    }
  }

  const loserSquad = Object.assign({}, room[loserSide].squad);
  const consolationSlot = mazadFindSlotFor(loserSquad, base, room.squadMode);
  let consolationPlayer = null;
  let consolationPlaced = false;
  if (consolationSlot) {
    const consolationBase = basePositionKey(consolationSlot);
    consolationPlayer = rs.previewConsolation || mazadDrawFromBase(consolationBase, usedIds, 85);
    if (consolationPlayer) {
      usedIds.push(normPlayerName(consolationPlayer.name));
      loserSquad[consolationSlot] = consolationPlayer;
      consolationPlaced = true;
    }
  }

  const updates = {};
  updates[winnerSide + '/squad'] = winnerSquad;
  updates[winnerSide + '/budgetSpent'] = (room[winnerSide].budgetSpent || 0) + winningBid;
  updates[loserSide + '/squad'] = loserSquad;
  updates.usedPlayerIds = usedIds;
  updates.roundState = null;
  updates.lastRoundResult = {
    type: 'contested',
    winnerSide, winningBid, player,
    bonusPlayer: bonusPlaced ? bonusPlayer : null,
    consolationPlayer: consolationPlaced ? consolationPlayer : null
  };

  return roomRef.update(updates).then(() => mazadAdvanceAuction(roomId));
}

// Only one side has an empty slot in this base position: they get the next
// elite player for it for free, no bid, no bonus/consolation for anyone.
function mazadResolveUncontestedRound(roomId, room, base, side) {
  const roomRef = db.ref('mazad_rooms/' + roomId);
  const player = mazadDrawFromBase(base, room.usedPlayerIds || [], 90);
  if (!player) return mazadAdvanceAuction(roomId); // pool exhausted for this base, extremely unlikely

  const squad = Object.assign({}, room[side].squad);
  const slot = mazadFindSlotFor(squad, base, room.squadMode);
  if (slot) squad[slot] = player;
  const usedIds = (room.usedPlayerIds || []).concat([normPlayerName(player.name)]);

  const updates = {};
  updates[side + '/squad'] = squad;
  updates.usedPlayerIds = usedIds;
  updates.roundState = null;
  updates.lastRoundResult = { type: 'uncontested', winnerSide: side, player, bonusPlayer: null, consolationPlayer: null };

  return roomRef.update(updates).then(() => mazadAdvanceAuction(roomId));
}

// Sets up whatever the next round needs to be, cascading through any number
// of consecutive uncontested rounds automatically, and starts the shared
// match simulation once both squads are completely full.
function mazadAdvanceAuction(roomId) {
  const roomRef = db.ref('mazad_rooms/' + roomId);
  return roomRef.once('value').then(snapshot => {
    const room = snapshot.val();
    if (!room || !room.guest) return;

    const need = mazadNextNeededBase(room);
    if (!need) {
      return roomRef.update({ status: 'simulating' }).then(() => {
        return roomRef.once('value');
      }).then(freshSnap => {
        FirebaseEngine.startMatchSimulation(roomId, freshSnap.val(), 'mazad_rooms');
      });
    }

    if (need.hostOpen && need.guestOpen) {
      const player = mazadDrawFromBase(need.base, room.usedPlayerIds || [], 90);
      if (!player) return; // this base's whole pool is exhausted; leave as-is rather than crash
      const nextRoundNumber = (room.roundNumber || 0) + 1;
      const opener = nextRoundNumber % 2 === 1 ? 'host' : 'guest';

      // The engine requires an opening bid before any pass is legal (no bid
      // yet means there's nothing to accept by passing) - so a side with
      // less than the opening floor left literally cannot act as opener,
      // and the round would otherwise stall on their turn forever (a real
      // hang, not just an unlucky auction). Route it the same way a
      // genuinely uncontested round already works: the other side gets
      // this player for free, no bonus/consolation, and drafting keeps
      // moving.
      const openerRemaining = (room[opener].budget || 0) - (room[opener].budgetSpent || 0);
      const openingFloor = mazadMinNextBid(room.squadMode, 0);
      if (openerRemaining < openingFloor) {
        // Matches the plain-uncontested path below: roundNumber isn't
        // bumped for a free grant, only for an actual bidding round.
        const fallbackSide = mazadOpposite(opener);
        return mazadResolveUncontestedRound(roomId, room, need.base, fallbackSide);
      }

      // Pre-draw the winner's bonus and loser's consolation player up front
      // (same 84/85 floors and sequential exclusion mazadResolveContestedRound
      // used to draw at resolution time) so the admin eye toggle can preview
      // both before bidding even starts. mazadResolveContestedRound below now
      // reuses these instead of drawing fresh, so the preview always matches
      // the real outcome.
      const usedForBonus = (room.usedPlayerIds || []).concat([normPlayerName(player.name)]);

      const openerSquad = Object.assign({}, room[opener].squad);
      const auctionedSlot = mazadFindSlotFor(openerSquad, need.base, room.squadMode);
      if (auctionedSlot) openerSquad[auctionedSlot] = player;
      const bonusSlot = mazadFindSlotFor(openerSquad, need.base, room.squadMode);
      const bonusBase = bonusSlot ? basePositionKey(bonusSlot) : need.base;
      const previewBonus = mazadDrawFromBase(bonusBase, usedForBonus, 84);

      const loserSide = mazadOpposite(opener);
      const loserSquad = Object.assign({}, room[loserSide].squad);
      const consolationSlot = mazadFindSlotFor(loserSquad, need.base, room.squadMode);
      const consolationBase = consolationSlot ? basePositionKey(consolationSlot) : need.base;
      const usedForConsolation = previewBonus ? usedForBonus.concat([normPlayerName(previewBonus.name)]) : usedForBonus;
      const previewConsolation = mazadDrawFromBase(consolationBase, usedForConsolation, 85);

      return roomRef.update({
        roundNumber: nextRoundNumber,
        currentRoundOpener: opener,
        roundState: {
          status: 'bidding',
          basePosition: need.base,
          player,
          previewBonus: previewBonus || null,
          previewConsolation: previewConsolation || null,
          currentBid: 0,
          currentBidder: null,
          turn: opener,
          history: []
        }
      });
    }

    const side = need.hostOpen ? 'host' : 'guest';
    return mazadResolveUncontestedRound(roomId, room, need.base, side);
  });
}
