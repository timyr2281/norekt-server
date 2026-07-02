import pg from 'pg';
import { ADMIN_ID } from './config.js';

const { Pool } = pg;

// Railway provides DATABASE_URL for its PostgreSQL plugin.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id  BIGINT PRIMARY KEY,
      name         TEXT,
      username     TEXT,
      avatar_url   TEXT,
      stars        INTEGER     NOT NULL DEFAULT 0,
      usd_balance  NUMERIC(18,6) NOT NULL DEFAULT 0,
      free_overviews INTEGER   NOT NULL DEFAULT 1,   -- new user: 1 free coin overview
      free_reviews   INTEGER   NOT NULL DEFAULT 1,   -- new user: 1 free trade review
      referred_by    BIGINT,                          -- who invited this user (set once)
      has_paid       BOOLEAN   NOT NULL DEFAULT FALSE, -- did this user ever pay (for referral reward)
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- one row per successful referral link (inviter -> invitee), invitee unique
    CREATE TABLE IF NOT EXISTS referrals (
      invitee_id   BIGINT PRIMARY KEY REFERENCES users(telegram_id),
      inviter_id   BIGINT NOT NULL REFERENCES users(telegram_id),
      paid_rewarded BOOLEAN NOT NULL DEFAULT FALSE,   -- inviter already got the "paid" bonus
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id             BIGSERIAL PRIMARY KEY,
      telegram_id    BIGINT NOT NULL REFERENCES users(telegram_id),
      coin           TEXT   NOT NULL,
      network        TEXT   NOT NULL,
      address        TEXT   NOT NULL,
      base_amount    NUMERIC(18,3) NOT NULL,
      expected_amount NUMERIC(18,3) NOT NULL,   -- amount WITH the unique tag
      status         TEXT   NOT NULL DEFAULT 'pending', -- pending | credited | expired
      tx_hash        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ NOT NULL,
      credited_at    TIMESTAMPTZ
    );

    -- one tx can only ever be used once
    CREATE UNIQUE INDEX IF NOT EXISTS deposits_txhash_uniq ON deposits(tx_hash) WHERE tx_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS deposits_match_idx ON deposits(network, coin, address, expected_amount, status);

    CREATE TABLE IF NOT EXISTS charges (
      id          BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      kind        TEXT   NOT NULL,  -- review | overview
      method      TEXT   NOT NULL,  -- stars | usd | free
      amount      NUMERIC(18,6) NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- saved analyses so history is real and re-openable
    CREATE TABLE IF NOT EXISTS analyses (
      id          BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      kind        TEXT   NOT NULL,  -- review | overview
      coin        TEXT,
      level       TEXT,             -- High/Mid/Low for reviews
      payload     JSONB NOT NULL,   -- everything needed to re-render
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS analyses_user_idx ON analyses(telegram_id, created_at DESC);

    -- migrations for a DB created before these columns existed
    ALTER TABLE users ADD COLUMN IF NOT EXISTS free_overviews INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS free_reviews   INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by    BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS has_paid       BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked        BOOLEAN NOT NULL DEFAULT FALSE;
  `);
  console.log('[db] schema ready');
}

export async function upsertUser(u, refId = null) {
  const { id, first_name, last_name, username, photo_url } = u;
  const name = [first_name, last_name].filter(Boolean).join(' ') || username || ('user' + id);
  const existed = await getUser(id);
  await pool.query(
    `INSERT INTO users (telegram_id, name, username, avatar_url, free_overviews, free_reviews)
     VALUES ($1,$2,$3,$4,1,1)
     ON CONFLICT (telegram_id) DO UPDATE SET
       name = COALESCE(users.name, EXCLUDED.name),
       username = EXCLUDED.username`,
    [id, name, username || null, photo_url || null]
  );
  // handle referral only for brand-new users with a valid, different inviter
  if (!existed && refId) {
    const rid = Number(refId);
    if (rid && rid !== Number(id)) {
      const inviter = await getUser(rid);
      if (inviter) await linkReferral(rid, id);
    }
  }
  // owner account: keep unlimited free usage (top up whenever it runs low)
  if (Number(id) === ADMIN_ID) {
    await pool.query(
      `UPDATE users SET free_overviews=10000, free_reviews=10000
         WHERE telegram_id=$1 AND (free_overviews < 100 OR free_reviews < 100)`, [id]);
  }
  return getUser(id);
}

// link invitee to inviter (once); reward inviter with +1 free overview
async function linkReferral(inviterId, inviteeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO referrals (invitee_id, inviter_id) VALUES ($1,$2)
       ON CONFLICT (invitee_id) DO NOTHING`, [inviteeId, inviterId]);
    if (ins.rowCount) {
      await client.query('UPDATE users SET referred_by=$2 WHERE telegram_id=$1 AND referred_by IS NULL', [inviteeId, inviterId]);
      await client.query('UPDATE users SET free_overviews = free_overviews + 1 WHERE telegram_id=$1', [inviterId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[db] linkReferral failed:', e.message);
  } finally { client.release(); }
}

// consume a free overview if available; returns true if used a free one
export async function useFreeOverview(id) {
  const { rowCount } = await pool.query(
    `UPDATE users SET free_overviews = free_overviews - 1
       WHERE telegram_id=$1 AND free_overviews > 0`, [id]);
  if (rowCount) await pool.query('INSERT INTO charges(telegram_id,kind,method,amount) VALUES($1,$2,$3,$4)', [id, 'overview', 'free', 0]);
  return rowCount > 0;
}
// consume a free review if available
export async function useFreeReview(id) {
  const { rowCount } = await pool.query(
    `UPDATE users SET free_reviews = free_reviews - 1
       WHERE telegram_id=$1 AND free_reviews > 0`, [id]);
  if (rowCount) await pool.query('INSERT INTO charges(telegram_id,kind,method,amount) VALUES($1,$2,$3,$4)', [id, 'review', 'free', 0]);
  return rowCount > 0;
}

// mark that a user has paid; reward their inviter once with +1 free review
export async function rewardOnFirstPayment(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET has_paid=TRUE WHERE telegram_id=$1', [id]);
    const { rows } = await client.query(
      `SELECT inviter_id FROM referrals WHERE invitee_id=$1 AND paid_rewarded=FALSE`, [id]);
    if (rows[0]) {
      await client.query('UPDATE users SET free_reviews = free_reviews + 1 WHERE telegram_id=$1', [rows[0].inviter_id]);
      await client.query('UPDATE referrals SET paid_rewarded=TRUE WHERE invitee_id=$1', [id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[db] rewardOnFirstPayment failed:', e.message);
  } finally { client.release(); }
}

export async function referralStats(id) {
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS invited,
       count(*) FILTER (WHERE r.paid_rewarded)::int AS paid
     FROM referrals r WHERE r.inviter_id=$1`, [id]);
  return { invited: rows[0]?.invited || 0, paid: rows[0]?.paid || 0 };
}

export async function saveAnalysis(id, kind, coin, level, payload) {
  const { rows } = await pool.query(
    `INSERT INTO analyses (telegram_id, kind, coin, level, payload)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [id, kind, coin || null, level || null, JSON.stringify(payload || {})]
  );
  return rows[0];
}
export async function listAnalyses(id, limit = 30) {
  const { rows } = await pool.query(
    `SELECT id, kind, coin, level, payload, created_at FROM analyses
       WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT $2`, [id, limit]);
  return rows;
}

// full user list with per-user metrics (for admin ratings + search)
export async function adminUsers() {
  const { rows } = await pool.query(`
    SELECT u.telegram_id, u.name, u.username, u.has_paid, u.blocked,
           u.free_overviews, u.free_reviews, u.created_at,
           COALESCE(p.purchases,0)::int AS purchases,
           COALESCE(p.usd,0) AS usd,
           COALESCE(r.invited,0)::int AS invited,
           COALESCE(r.invited_paid,0)::int AS invited_paid,
           COALESCE(a.analyses,0)::int AS analyses
    FROM users u
    LEFT JOIN (
      SELECT telegram_id, count(*) AS purchases,
             SUM(amount) FILTER (WHERE method='usd') AS usd
      FROM charges WHERE method IN ('usd','stars') GROUP BY telegram_id
    ) p ON p.telegram_id=u.telegram_id
    LEFT JOIN (
      SELECT inviter_id, count(*) AS invited,
             count(*) FILTER (WHERE paid_rewarded) AS invited_paid
      FROM referrals GROUP BY inviter_id
    ) r ON r.inviter_id=u.telegram_id
    LEFT JOIN (
      SELECT telegram_id, count(*) AS analyses FROM analyses GROUP BY telegram_id
    ) a ON a.telegram_id=u.telegram_id
    ORDER BY u.created_at DESC
  `);
  return rows;
}
export async function setBlocked(id, blocked) {
  await pool.query('UPDATE users SET blocked=$2 WHERE telegram_id=$1', [id, !!blocked]);
}
export async function isBlocked(id) {
  const { rows } = await pool.query('SELECT blocked FROM users WHERE telegram_id=$1', [id]);
  return !!(rows[0] && rows[0].blocked);
}
export async function allUserIds() {
  const { rows } = await pool.query('SELECT telegram_id FROM users WHERE NOT blocked');
  return rows.map(r => r.telegram_id);
}

// ── admin analytics (read-only) ──
export async function adminStats() {
  const totals = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM users WHERE has_paid) AS buyers,
      (SELECT count(*)::int FROM referrals) AS referrals,
      (SELECT count(*)::int FROM charges WHERE method IN ('usd','stars')) AS purchases,
      (SELECT COALESCE(sum(amount),0) FROM charges WHERE method='usd') AS usd_spent,
      (SELECT COALESCE(sum(amount),0) FROM charges WHERE method='stars') AS stars_spent,
      (SELECT count(*)::int FROM analyses) AS analyses
  `);
  const topBuyers = await pool.query(`
    SELECT u.telegram_id, u.name, u.username,
           count(*)::int AS purchases,
           COALESCE(sum(c.amount) FILTER (WHERE c.method='usd'),0) AS usd
    FROM charges c JOIN users u ON u.telegram_id=c.telegram_id
    WHERE c.method IN ('usd','stars')
    GROUP BY u.telegram_id, u.name, u.username
    ORDER BY purchases DESC LIMIT 20`);
  const topRef = await pool.query(`
    SELECT u.telegram_id, u.name, u.username,
           count(r.*)::int AS invited,
           count(r.*) FILTER (WHERE r.paid_rewarded)::int AS invited_paid
    FROM referrals r JOIN users u ON u.telegram_id=r.inviter_id
    GROUP BY u.telegram_id, u.name, u.username
    ORDER BY invited DESC LIMIT 20`);
  const recent = await pool.query(`
    SELECT telegram_id, name, username, has_paid, free_overviews, free_reviews, created_at
    FROM users ORDER BY created_at DESC LIMIT 50`);
  return {
    totals: totals.rows[0],
    topBuyers: topBuyers.rows,
    topReferrers: topRef.rows,
    recentUsers: recent.rows
  };
}

export async function getUser(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [id]);
  return rows[0] || null;
}

export async function setProfile(id, { name, avatar_url }) {
  await pool.query(
    `UPDATE users SET name=COALESCE($2,name), avatar_url=COALESCE($3,avatar_url) WHERE telegram_id=$1`,
    [id, name ?? null, avatar_url ?? null]
  );
  return getUser(id);
}

export async function addStars(id, n) {
  await pool.query('UPDATE users SET stars = stars + $2 WHERE telegram_id=$1', [id, n]);
}
export async function addUsd(id, n) {
  await pool.query('UPDATE users SET usd_balance = usd_balance + $2 WHERE telegram_id=$1', [id, n]);
}

// Atomically charge stars or usd; returns true if it succeeded.
export async function chargeStars(id, n, kind) {
  const { rowCount } = await pool.query(
    'UPDATE users SET stars = stars - $2 WHERE telegram_id=$1 AND stars >= $2', [id, n]);
  if (rowCount) await pool.query('INSERT INTO charges(telegram_id,kind,method,amount) VALUES($1,$2,$3,$4)', [id, kind, 'stars', n]);
  return rowCount > 0;
}
export async function chargeUsd(id, n, kind) {
  const { rowCount } = await pool.query(
    'UPDATE users SET usd_balance = usd_balance - $2 WHERE telegram_id=$1 AND usd_balance >= $2', [id, n]);
  if (rowCount) {
    await pool.query('INSERT INTO charges(telegram_id,kind,method,amount) VALUES($1,$2,$3,$4)', [id, kind, 'usd', n]);
    await rewardOnFirstPayment(id);   // first real payment rewards the inviter with a free review
  }
  return rowCount > 0;
}
