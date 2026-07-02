import { NETWORKS, COIN_NETWORKS, apiKey, POLL_MS } from './config.js';
import { pool, addUsd } from './db.js';

// ── price: stablecoins = 1:1, ETH fetched live (credited balance is in USD) ──
let ethUsd = 0, ethTs = 0;
async function getEthUsd() {
  if (Date.now() - ethTs < 60000 && ethUsd) return ethUsd;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const j = await r.json();
    ethUsd = j?.ethereum?.usd || ethUsd;
    ethTs = Date.now();
  } catch { /* keep last */ }
  return ethUsd;
}
async function usdValue(coin, amount) {
  if (coin === 'USDT' || coin === 'USDC') return amount;
  if (coin === 'ETH') { const p = await getEthUsd(); return p ? amount * p : 0; }
  return 0;
}

// ── fetch recent INCOMING transfers for a given network+coin ──
// returns [{ hash, amount(Number, in token units) }]
async function fetchIncoming(net, coin) {
  const cfg = NETWORKS[net];
  const t = cfg.tokens[coin];
  if (!t) return [];
  const addr = cfg.address;

  try {
    if (t.type === 'tron-trc20') {
      const url = `${cfg.scanner}/v1/accounts/${addr}/transactions/trc20?only_to=true&limit=50&contract_address=${t.contract}`;
      const headers = apiKey(net) ? { 'TRON-PRO-API-KEY': apiKey(net) } : {};
      const r = await fetch(url, { headers });
      const j = await r.json();
      return (j.data || [])
        .filter(x => x.to === addr && x.token_info?.address === t.contract)
        .map(x => ({ hash: x.transaction_id, amount: Number(x.value) / 10 ** (x.token_info?.decimals ?? t.decimals) }));
    }

    if (t.type === 'evm-native') {
      const url = `${cfg.scanner}?chainid=${cfg.chainId}&module=account&action=txlist&address=${addr}&page=1&offset=50&sort=desc&apikey=${apiKey(net)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (!Array.isArray(j.result)) return [];
      return j.result
        .filter(x => x.to?.toLowerCase() === addr.toLowerCase() && x.value !== '0' && x.isError === '0')
        .map(x => ({ hash: x.hash, amount: Number(x.value) / 10 ** t.decimals }));
    }

    // evm-token (BEP20 / ERC20)
    const url = `${cfg.scanner}?chainid=${cfg.chainId}&module=account&action=tokentx&contractaddress=${t.contract}&address=${addr}&page=1&offset=50&sort=desc&apikey=${apiKey(net)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!Array.isArray(j.result)) return [];
    return j.result
      .filter(x => x.to?.toLowerCase() === addr.toLowerCase())
      .map(x => ({ hash: x.hash, amount: Number(x.value) / 10 ** Number(x.tokenDecimal || t.decimals) }));
  } catch (e) {
    console.error(`[chain] ${net}/${coin} fetch failed:`, e.message);
    return [];
  }
}

// ── try to credit one incoming tx against a pending deposit ──
async function tryCredit(net, coin, tx) {
  // already processed?
  const seen = await pool.query('SELECT 1 FROM deposits WHERE tx_hash=$1', [tx.hash]);
  if (seen.rowCount) return;

  // match by exact tagged amount (tag lives in the 3rd decimal -> tolerance 0.0005)
  const { rows } = await pool.query(
    `SELECT * FROM deposits
       WHERE network=$1 AND coin=$2 AND status='pending' AND expires_at > now()
         AND abs(expected_amount - $3) < 0.0005
       ORDER BY created_at ASC LIMIT 1`,
    [net, coin, tx.amount]
  );
  const dep = rows[0];
  if (!dep) return;

  const credited = await usdValue(coin, Number(dep.expected_amount));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE deposits SET status='credited', tx_hash=$2, credited_at=now()
         WHERE id=$1 AND status='pending'`, [dep.id, tx.hash]);
    if (upd.rowCount) {
      await client.query('UPDATE users SET usd_balance = usd_balance + $2 WHERE telegram_id=$1',
        [dep.telegram_id, credited]);
      await client.query('COMMIT');
      console.log(`[chain] credited ${credited} USD to ${dep.telegram_id} (${coin}/${net}, tx ${tx.hash})`);
    } else {
      await client.query('ROLLBACK');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[chain] credit tx failed:', e.message);
  } finally {
    client.release();
  }
}

async function scanOnce() {
  // expire stale deposits
  await pool.query(`UPDATE deposits SET status='expired' WHERE status='pending' AND expires_at < now()`);

  for (const [coin, nets] of Object.entries(COIN_NETWORKS)) {
    for (const net of nets) {
      const incoming = await fetchIncoming(net, coin);
      for (const tx of incoming) await tryCredit(net, coin, tx);
    }
  }
}

// the "it does everything itself" part: a background loop inside the same server.
export function startChainWatcher() {
  console.log(`[chain] watcher started, every ${POLL_MS}ms`);
  const tick = async () => {
    try { await scanOnce(); } catch (e) { console.error('[chain] scan error:', e.message); }
  };
  tick();
  setInterval(tick, POLL_MS);
}
