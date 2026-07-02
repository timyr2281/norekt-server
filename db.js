import pg from 'pg';

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
      method      TEXT   NOT NULL,  -- stars | usd
      amount      NUMERIC(18,6) NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('[db] schema ready');
}

export async function upsertUser(u) {
  const { id, first_name, last_name, username, photo_url } = u;
  const name = [first_name, last_name].filter(Boolean).join(' ') || username || ('user' + id);
  await pool.query(
    `INSERT INTO users (telegram_id, name, username, avatar_url)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (telegram_id) DO UPDATE SET
       name = COALESCE(users.name, EXCLUDED.name),
       username = EXCLUDED.username`,
    [id, name, username || null, photo_url || null]
  );
  return getUser(id);
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
  if (rowCount) await pool.query('INSERT INTO charges(telegram_id,kind,method,amount) VALUES($1,$2,$3,$4)', [id, kind, 'usd', n]);
  return rowCount > 0;
}
