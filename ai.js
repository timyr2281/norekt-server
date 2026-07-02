import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

const GEMINI_KEY = process.env.GEMINI_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_URL = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_KEY}`;

// ── knowledge base: load all text files from /knowledge once, cache in memory ──
let KB = null;
function loadKnowledge() {
  if (KB !== null) return KB;
  KB = '';
  try {
    for (const f of fs.readdirSync(KNOWLEDGE_DIR)) {
      if (/\.(txt|md)$/i.test(f) && f.toLowerCase() !== 'readme.txt') {
        KB += `\n\n===== ${f} =====\n` + fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8');
      }
    }
  } catch (e) { console.error('[ai] knowledge load failed:', e.message); }
  console.log(`[ai] knowledge loaded: ${KB.length} chars`);
  return KB;
}

// ── candles from Binance (numbers the model reasons over) ──
export async function getCandles(coin, interval = '1h', limit = 120) {
  const sym = (coin || 'BTC').toUpperCase().replace(/[^A-Z0-9]/g, '') + 'USDT';
  try {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
    if (!r.ok) return null;
    const raw = await r.json();
    return raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  } catch { return null; }
}

// compact candles to a small text table to save tokens
function candlesToText(candles) {
  if (!candles || !candles.length) return 'no candle data';
  const last = candles[candles.length - 1];
  const head = candles.slice(-60); // last 60 for context
  const rows = head.map(c => `${new Date(c.t).toISOString().slice(5, 16)} O${c.o} H${c.h} L${c.l} C${c.c}`).join('\n');
  return `Current price: ${last.c}\nRecent candles (UTC, ${head.length}):\n${rows}`;
}

// ── system prompt built from your methodology (knowledge base) ──
function systemPrompt(lang) {
  const kb = loadKnowledge();
  const langLine = lang === 'ru'
    ? 'Отвечай на русском.'
    : 'Answer in English.';
  return [
    'You are an experienced crypto trader. Analyze strictly using the METHODOLOGY below.',
    'Be concrete and practical. Give levels and a clear recommendation of what is better to do.',
    'Never invent price data — use only the candles provided.',
    langLine,
    kb ? `\n===== METHODOLOGY (your manuals) =====\n${kb}\n===== END METHODOLOGY =====` :
         '\n(NOTE: knowledge base is empty — answer from general trading knowledge until manuals are added.)'
  ].join('\n');
}

async function callGemini(system, user) {
  if (!GEMINI_KEY) throw new Error('GEMINI_KEY missing');
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 900 }
  };
  const r = await fetch(GEMINI_URL(GEMINI_MODEL), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error('gemini_' + r.status + ': ' + t.slice(0, 200)); }
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
  return text || '';
}

// ── overview of a coin ──
export async function aiOverview({ coin, lang }) {
  const candles = await getCandles(coin, '1h', 120);
  const user = [
    `Coin: ${coin}`,
    candlesToText(candles),
    '',
    'Give a market overview using the methodology, in these sections:',
    '- Trend', '- Volatility', '- Key levels (support/resistance)', '- Recommendation (what is better to do)',
    'Keep it tight. End with the sections only.'
  ].join('\n');
  return callGemini(systemPrompt(lang), user);
}

// ── review of an open/planned position ──
export async function aiReview({ coin, side, lev, entry, margin, balance, stopPct, tpPct, lang }) {
  const candles = await getCandles(coin, '15m', 120);
  const user = [
    'Position to analyze:',
    `Coin: ${coin}`,
    `Direction: ${side || 'n/a'}`,
    `Leverage: ${lev}x`,
    entry ? `Entry: ${entry}` : 'Entry: not set',
    `Margin: ${margin} USD, Account balance: ${balance} USD`,
    stopPct ? `Stop-loss: ${stopPct}%` : 'Stop-loss: none',
    tpPct ? `Take-profit: ${tpPct}%` : 'Take-profit: none',
    '',
    candlesToText(candles),
    '',
    'Using the methodology, give:',
    '- Risk read (how much of the deposit is really at risk, how close to liquidation)',
    '- Key levels around this position',
    '- Recommendation: what is better to do (e.g. from level X aim to Y, better to enter/exit there)',
    'Be concrete.'
  ].join('\n');
  return callGemini(systemPrompt(lang), user);
}

export function aiEnabled() { return !!GEMINI_KEY; }
