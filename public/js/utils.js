// Shared render-time escaping helper.
//
// The Firebase Realtime Database has no security rules yet (see
// docs/firebase-rules.json), so anyone can write any value to any path from
// their browser console - player names, card names, commentary text, photo
// URLs, all of it is attacker-controllable. This is the one boundary the
// app actually controls: escape everything right before it reaches
// innerHTML, no matter which script does the rendering.
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Only allow http(s) URLs into an <img src>/href - a value like
// `x" onerror="fetch(...)"` or a `javascript:` URL is otherwise still
// dangerous even after esc() encodes the quotes, because some sinks (like a
// raw attribute assignment) don't go through esc() at all. Callers should
// still prefer esc() wrapped in a template string; this is for the src
// itself.
function safeImageUrl(value, fallback) {
  const v = String(value || '').trim();
  if (/^https?:\/\//i.test(v)) return v;
  return fallback;
}

window.esc = esc;
window.safeImageUrl = safeImageUrl;
