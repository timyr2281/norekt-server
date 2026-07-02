import express from 'express';
import { verifyInitData } from './initdata.js';
import {
  upsertUser, getUser, setProfile, chargeUsd,
  useFreeOverview, useFreeReview, referralStats,
  saveAnalysis, listAnalyses, adminStats,
  adminUsers, setBlocked, isBlocked, allUserIds
} from './db.js';
import { pool } from './db.js';
import {
  NETWORKS, COIN_NETWORKS, DEPOSIT_TTL_MIN,
  REVIEW_USD, OVERVIEW_USD, ADMIN_ID, ADMIN_PASSWORD
} from './config.js';
import { createStarsInvoice, broadcast } from './bot.js';
import { aiOverview, aiReview, aiEnabled } from './ai.js';

export const api = express.Router();
api.use(express.json());

let BOT_USERNAME = null; // filled once at boot from bot.js
export function setBotUsername(u) { BOT_USERNAME = u; }

// auth middleware: every call must send Telegram initData; we verify it and trust the user.
async function auth(req, res, next) {
  const initData = req.headers['x-init-data'] || req.body?.initData;
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: 'bad_init_data' });
  req.tgUser = user;
  // referral id may arrive from the WebApp start_param
  const refId = req.body?.ref || null;
  req.dbUser = await upsertUser(user, refId);
  // blocked users can't use the bot (admin is exempt)
  if (Number(user.id) !== ADMIN_ID && req.dbUser && req.dbUser.blocked)
    return res.status(403).json({ error: 'blocked' });
  next();
}
function isAdmin(req) {
  return Number(req.tgUser.id) === ADMIN_ID && ADMIN_PASSWORD && req.body?.password === ADMIN_PASSWORD;
}

// current profile + balances + free counters + referral link
api.post('/me', auth, async (req, res) => {
  res.json(await pubFull(req.dbUser));
});

// try to use a FREE overview (referral / welcome). returns {free:true} if consumed.
api.post('/overview/free', auth, async (req, res) => {
  const free = await useFreeOverview(req.tgUser.id);
  const u = await getUser(req.tgUser.id);
  res.json({ free, balances: await pubFull(u) });
});

// try to use a FREE review (earned when an invited user paid)
api.post('/review/free', auth, async (req, res) => {
  const free = await useFreeReview(req.tgUser.id);
  const u = await getUser(req.tgUser.id);
  res.json({ free, balances: await pubFull(u) });
});

// edit name / avatar
api.post('/profile', auth, async (req, res) => {
  const { name, avatar_url } = req.body || {};
  const u = await setProfile(req.tgUser.id, { name, avatar_url });
  res.json(pub(u));
});

// list coins & networks the app should show (kept server-side so it can't drift)
api.post('/methods', auth, (req, res) => {
  const out = {};
  for (const [coin, nets] of Object.entries(COIN_NETWORKS)) {
    out[coin] = nets.map(n => ({ key: n, label: NETWORKS[n].label, address: NETWORKS[n].address }));
  }
  res.json({ coins: out });
});

// create a deposit request -> returns the EXACT amount (with unique tag) to send
api.post('/deposit/create', auth, async (req, res) => {
  const { coin, network, amount } = req.body || {};
  const base = Math.floor(Number(amount) * 1000) / 1000;
  if (!COIN_NETWORKS[coin] || !COIN_NETWORKS[coin].includes(network) || !(base > 0))
    return res.status(400).json({ error: 'bad_params' });

  const address = NETWORKS[network].address;
  const expiresExpr = `now() + interval '${DEPOSIT_TTL_MIN} minutes'`;

  // pick a free unique amount: base + n/1000, n in 1..99 (surcharge <= 0.099), not pending on same net/coin
  let expected = null;
  const SLOTS = 99;
  const start = 1 + Math.floor(Math.random() * SLOTS);
  for (let i = 0; i < SLOTS; i++) {
    const n = ((start + i - 1) % SLOTS) + 1;
    const candidate = +(base + n / 1000).toFixed(3);
    const taken = await pool.query(
      `SELECT 1 FROM deposits WHERE network=$1 AND coin=$2 AND status='pending'
         AND expires_at > now() AND expected_amount=$3 LIMIT 1`,
      [network, coin, candidate]
    );
    if (!taken.rowCount) { expected = candidate; break; }
  }
  if (expected === null) return res.status(503).json({ error: 'no_free_tag_try_later' });

  const { rows } = await pool.query(
    `INSERT INTO deposits (telegram_id, coin, network, address, base_amount, expected_amount, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, ${expiresExpr}) RETURNING id, expires_at`,
    [req.tgUser.id, coin, network, address, base, expected]
  );

  res.json({
    id: rows[0].id,
    coin, network, address,
    expected_amount: expected,
    expires_at: rows[0].expires_at
  });
});

// poll a deposit's status (mini app can check "credited yet?")
api.post('/deposit/status', auth, async (req, res) => {
  const { id } = req.body || {};
  const { rows } = await pool.query(
    'SELECT id,status,expected_amount,coin,network FROM deposits WHERE id=$1 AND telegram_id=$2',
    [id, req.tgUser.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  const u = await getUser(req.tgUser.id);
  res.json({ ...rows[0], balances: await pubFull(u) });
});

// charge for a review/overview from the USD balance
api.post('/charge/usd', auth, async (req, res) => {
  const { kind } = req.body || {};
  const cost = kind === 'overview' ? OVERVIEW_USD : REVIEW_USD;
  const ok = await chargeUsd(req.tgUser.id, cost, kind === 'overview' ? 'overview' : 'review');
  const u = await getUser(req.tgUser.id);
  res.json({ ok, balances: await pubFull(u) });
});

// save a generated analysis (review/overview) so history is real & re-openable
api.post('/history/add', auth, async (req, res) => {
  const { kind, coin, level, payload } = req.body || {};
  const row = await saveAnalysis(req.tgUser.id, kind === 'overview' ? 'overview' : 'review', coin, level, payload);
  res.json({ id: row.id, created_at: row.created_at });
});
api.post('/history/list', auth, async (req, res) => {
  const rows = await listAnalyses(req.tgUser.id, 30);
  res.json({ items: rows });
});

// ── AI analysis (Gemini) ──
api.post('/ai/overview', auth, async (req, res) => {
  try {
    const { coin, lang } = req.body || {};
    const text = await aiOverview({ coin: coin || 'BTC', lang: lang === 'ru' ? 'ru' : 'en' });
    res.json({ ok: true, text });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
api.post('/ai/review', auth, async (req, res) => {
  try {
    const p = req.body || {};
    const text = await aiReview({
      coin: p.coin || 'BTC', side: p.side, lev: p.lev, entry: p.entry,
      margin: p.margin, balance: p.balance, stopPct: p.stopPct, tpPct: p.tpPct,
      lang: p.lang === 'ru' ? 'ru' : 'en'
    });
    res.json({ ok: true, text });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
api.post('/ai/status', auth, (req, res) => res.json({ enabled: aiEnabled() }));

// create a Telegram Stars invoice link (mini app opens it via Telegram.WebApp.openInvoice)
api.post('/stars/invoice', auth, async (req, res) => {
  const { kind } = req.body || {};
  try {
    const { link, stars } = await createStarsInvoice(kind === 'overview' ? 'overview' : 'review', req.tgUser.id);
    res.json({ link, stars });
  } catch (e) {
    res.status(500).json({ error: 'invoice_failed', detail: e.message });
  }
});

// ── ADMIN (read-only). Requires BOTH the verified Telegram ID AND the password. ──
api.post('/admin/check', auth, (req, res) => {
  res.json({ ok: isAdmin(req) });
});
api.post('/admin/stats', auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(await adminStats());
});
// full user list with metrics (client does search + sort)
api.post('/admin/users', auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ users: await adminUsers() });
});
// block / unblock a user
api.post('/admin/block', auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  const { target, blocked } = req.body || {};
  if (Number(target) === ADMIN_ID) return res.status(400).json({ error: 'cant_block_admin' });
  await setBlocked(Number(target), !!blocked);
  res.json({ ok: true });
});
// broadcast a message to every (non-blocked) user, throttled
api.post('/admin/broadcast', auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  const ids = await allUserIds();
  res.json({ ok: true, queued: ids.length });   // respond immediately
  broadcast(ids, text);                          // run in background (throttled)
});
// tell the client whether this user is the admin (to show/hide the button)
api.post('/admin/is', auth, (req, res) => {
  res.json({ admin: Number(req.tgUser.id) === ADMIN_ID });
});

function pub(u) {
  return {
    telegram_id: u.telegram_id,
    name: u.name,
    username: u.username,
    avatar_url: u.avatar_url,
    stars: u.stars,
    usd_balance: Number(u.usd_balance),
    free_overviews: u.free_overviews ?? 0,
    free_reviews: u.free_reviews ?? 0
  };
}
async function pubFull(u) {
  const base = pub(u);
  const stats = await referralStats(u.telegram_id);
  base.invited = stats.invited;
  base.invited_paid = stats.paid;
  base.ref_link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${u.telegram_id}` : null;
  return base;
}
