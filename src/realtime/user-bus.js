/**
 * Per-user event bus for cross-device sync (web tab, phone app, …). In-memory ring buffer
 * with a monotonically increasing sequence so a reconnecting client resumes with
 * `?since=<seq>`; if its cursor fell out of the buffer (or the process restarted) the
 * client gets `reset: true` and simply refetches state from the DB, which stays the
 * source of truth. Events only ever go to the owning user's devices.
 */
const BUFFER = 200;
const users = new Map(); // userId -> { seq, events: [], waiters: Set<fn> }
const BOOT = Date.now().toString(36);

function bucket(userId) {
  const k = String(userId);
  let b = users.get(k);
  if (!b) {
    b = { seq: 0, events: [], waiters: new Set() };
    users.set(k, b);
  }
  return b;
}

/** Publish `type` with a small JSON payload to every device of `userId`. */
function publish(userId, type, data = {}, { fromDevice = '' } = {}) {
  if (!userId) return null;
  const b = bucket(userId);
  const ev = { seq: ++b.seq, type, data, at: new Date().toISOString(), fromDevice: String(fromDevice || '').slice(0, 64) };
  b.events.push(ev);
  if (b.events.length > BUFFER) b.events.splice(0, b.events.length - BUFFER);
  for (const w of b.waiters) w();
  return ev;
}

/** Cursor format "<boot>.<seq>" so a restart is detected as a reset. */
function cursorOf(userId) {
  return `${BOOT}.${bucket(userId).seq}`;
}

function since(userId, cursor) {
  const b = bucket(userId);
  const [boot, n] = String(cursor || '').split('.');
  const seq = Number(n);
  if (!cursor || boot !== BOOT || !Number.isFinite(seq) || seq > b.seq) return { reset: true, events: [], cursor: cursorOf(userId) };
  const first = b.events[0]?.seq ?? b.seq + 1;
  if (seq < first - 1) return { reset: true, events: [], cursor: cursorOf(userId) };
  return { reset: false, events: b.events.filter((e) => e.seq > seq), cursor: cursorOf(userId) };
}

/** Long-poll: resolve as soon as there are events after `cursor`, or after `waitMs`. */
function wait(userId, cursor, waitMs, signal) {
  const now = since(userId, cursor);
  if (now.reset || now.events.length || waitMs <= 0) return Promise.resolve(now);
  const b = bucket(userId);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      b.waiters.delete(finish);
      resolve(since(userId, cursor));
    };
    const timer = setTimeout(finish, waitMs);
    b.waiters.add(finish);
    signal?.addEventListener?.('abort', finish);
  });
}

function _reset() {
  users.clear();
}

module.exports = { publish, since, wait, cursorOf, _reset };
