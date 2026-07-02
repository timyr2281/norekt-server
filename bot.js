import { Telegraf } from 'telegraf';
import express from 'express';
import { BOT_TOKEN, WEBAPP_URL, REVIEW_STARS, OVERVIEW_STARS } from './config.js';
import { upsertUser, addStars } from './db.js';

export const bot = new Telegraf(BOT_TOKEN);

// /start -> button that opens the mini app
bot.start(async (ctx) => {
  await upsertUser(ctx.from);
  await ctx.reply(
    'RiskCheck — трезвая оценка риска твоей позиции.',
    WEBAPP_URL
      ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть RiskCheck', web_app: { url: WEBAPP_URL } }]] } }
      : undefined
  );
});

// ── Stars invoice creation (called by the API/mini app) ──
// kind: 'review' | 'overview' ; returns an invoice link the WebApp opens via openInvoice()
export async function createStarsInvoice(kind, telegramId) {
  const stars = kind === 'overview' ? OVERVIEW_STARS : REVIEW_STARS;
  const title = kind === 'overview' ? 'RiskCheck — обзор монеты' : 'RiskCheck — разбор позиции';
  const link = await bot.telegram.createInvoiceLink({
    title,
    description: title,
    payload: JSON.stringify({ kind, telegramId }), // echoed back on success
    provider_token: '',          // EMPTY for Telegram Stars (digital goods)
    currency: 'XTR',             // Telegram Stars
    prices: [{ label: title, amount: stars }]
  });
  return { link, stars };
}

// must answer pre_checkout within 10s
bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true).catch(() => {}));

// payment succeeded -> credit the user (here we top up their stars balance;
// the mini app then spends stars for the review/overview, or you can grant the item directly)
bot.on('message', async (ctx, next) => {
  const sp = ctx.message?.successful_payment;
  if (!sp) return next();
  try {
    const { telegramId } = JSON.parse(sp.invoice_payload || '{}');
    const stars = sp.total_amount; // in XTR
    if (telegramId) await addStars(telegramId, stars);
    await ctx.reply(`Оплата получена: ${stars} ★ зачислены.`);
  } catch (e) {
    console.error('[bot] successful_payment handling failed:', e.message);
  }
});

// Webhook handler (Railway gives a public URL; webhook is simpler than long polling there)
export function botWebhook(app, path = '/tg-webhook') {
  app.use(express.json());
  app.post(path, (req, res) => { bot.handleUpdate(req.body, res); });
  return path;
}
