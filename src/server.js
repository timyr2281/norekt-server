import express from 'express';
import { PORT, WEBAPP_URL, BOT_TOKEN } from './config.js';
import { initDb } from './db.js';
import { api, setBotUsername } from './api.js';
import { bot, botWebhook, getBotUsername, setMenuButton } from './bot.js';
import { startChainWatcher } from './chain.js';

const app = express();

// CORS so the hosted mini app (different origin) can call this API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', WEBAPP_URL || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Init-Data');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_, res) => res.send('RiskCheck server is running.'));
app.use('/api', api);

async function main() {
  if (!BOT_TOKEN) { console.error('BOT_TOKEN is missing'); process.exit(1); }
  await initDb();

  // Telegram webhook (Railway gives you a public domain)
  const path = botWebhook(app);
  const base = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (base) {
    const url = (base.startsWith('http') ? base : `https://${base}`) + path;
    await bot.telegram.setWebhook(url).then(() => console.log('[bot] webhook set:', url))
      .catch(e => console.error('[bot] setWebhook failed:', e.message));
  } else {
    // fallback to long polling if no public URL is configured
    bot.launch().then(() => console.log('[bot] long polling started'));
  }

  startChainWatcher();

  const uname = await getBotUsername();
  if (uname) { setBotUsername(uname); console.log('[bot] username @' + uname); }
  await setMenuButton();

  app.listen(PORT, () => console.log(`[api] listening on ${PORT}`));
}

main().catch(e => { console.error(e); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
