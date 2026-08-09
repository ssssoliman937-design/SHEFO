// Vercel Cron target - deletes stale rooms from both dond_rooms and
// mazad_rooms via Firebase's REST API, same staleness rule createRoom()
// already uses to recycle a room code (finished, or older than 6h). Runs
// server-side on a schedule (see vercel.json "crons") instead of relying on
// the n8n workflow in automation/n8n/, which needs the user to host n8n
// somewhere themselves - this needs nothing but the Vercel project already
// deployed.
//
// Optional hardening: set a CRON_SECRET env var and this only accepts
// requests carrying that same value in the x-cron-secret header. Left open
// if CRON_SECRET isn't set - worst case of an unauthenticated trigger is
// legitimate cleanup running early, not data loss of anything non-stale.

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://cuafa-9f3b6-default-rtdb.firebaseio.com';
const STALE_MS = 6 * 60 * 60 * 1000;

async function cleanupTree(treeName) {
  const listRes = await fetch(`${FIREBASE_DB_URL}/${treeName}.json`);
  if (!listRes.ok) throw new Error(`${treeName} list fetch failed: ${listRes.status}`);
  const rooms = await listRes.json();
  if (!rooms) return { checked: 0, deleted: 0 };

  const now = Date.now();
  const staleIds = Object.keys(rooms).filter((id) => {
    const room = rooms[id] || {};
    return room.status === 'finished' || !room.createdAt || (now - room.createdAt) > STALE_MS;
  });

  await Promise.all(
    staleIds.map((id) => fetch(`${FIREBASE_DB_URL}/${treeName}/${id}.json`, { method: 'DELETE' }))
  );

  return { checked: Object.keys(rooms).length, deleted: staleIds.length };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const [dond, mazad] = await Promise.all([cleanupTree('dond_rooms'), cleanupTree('mazad_rooms')]);
    res.status(200).json({ ok: true, ranAt: new Date().toISOString(), dond_rooms: dond, mazad_rooms: mazad });
  } catch (err) {
    console.error('cleanup-stale-rooms error:', err);
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
