// PIN lock for the admin view. Entering the PIN gives the browser a session
// cookie; every admin API call checks it. Sessions live in memory, so
// restarting the app asks for the PIN again.

import crypto from 'node:crypto';

const COOKIE = 'admin_session';

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export function createPinLock(pin, { maxAttempts = 5, lockMs = 60_000, sessionMs = 12 * 60 * 60 * 1000 } = {}) {
  const expected = digest(pin);
  const sessions = new Map(); // token -> expiry time
  let failures = 0;
  let lockedUntil = 0;

  function unlocked(req) {
    const token = readCookie(req);
    const expiry = token && sessions.get(token);
    if (!expiry) return false;
    if (expiry < Date.now()) {
      sessions.delete(token);
      return false;
    }
    sessions.set(token, Date.now() + sessionMs); // stays open while in use
    return true;
  }

  return {
    unlocked,

    // Express middleware for everything behind the lock.
    require(req, res, next) {
      if (unlocked(req)) next();
      else res.status(401).json({ error: 'Enter the PIN to continue.', locked: true });
    },

    unlock(req, res) {
      const wait = lockedUntil - Date.now();
      if (wait > 0) {
        res.status(429).json({ error: `Too many wrong attempts. Try again in ${Math.ceil(wait / 1000)} seconds.` });
        return;
      }
      const given = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
      if (!crypto.timingSafeEqual(digest(given), expected)) {
        failures += 1;
        if (failures >= maxAttempts) {
          failures = 0;
          lockedUntil = Date.now() + lockMs;
          res.status(429).json({ error: `Too many wrong attempts. Try again in ${Math.ceil(lockMs / 1000)} seconds.` });
        } else {
          res.status(401).json({ error: `Wrong PIN. ${maxAttempts - failures} attempt${maxAttempts - failures === 1 ? '' : 's'} left.` });
        }
        return;
      }
      failures = 0;
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + sessionMs);
      res.set('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(sessionMs / 1000)}`);
      res.json({ ok: true });
    },

    lock(req, res) {
      const token = readCookie(req);
      if (token) sessions.delete(token);
      res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      res.json({ ok: true });
    },
  };
}
