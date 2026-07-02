import { Telegraf } from 'telegraf';
import express from 'express';
import { BOT_TOKEN, WEBAPP_URL, REVIEW_STARS, OVERVIEW_STARS } from './config.js';
import { upsertUser, rewardOnFirstPayment } from './db.js';

export const bot = new Telegraf(BOT_TOKEN);

// /start [refId] -> create/link user, then show the mini app button.
// Referral: "https://t.me/<bot>?start=<inviterId>" arrives as ctx.startPayload.
bot.start(async (ctx) => {
  const ref = ctx.startPayload || null;   // inviter's telegram id, if any
  await upsertUser(ctx.from, ref);
  await ctx.reply(
    'NoRekt — трезвая оценка риска твоей позиции.',
    WEBAPP_URL
      ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть NoRekt', web_app: { url: WEBAPP_URL } }]] } }
      : undefined
  );
});

// ── Stars invoice creation (called by the API/mini app) ──
// kind: 'review' | 'overview'
export async function createStarsInvoice(kind, telegramId) {
  const stars = kind === 'overview' ? OVERVIEW_STARS : REVIEW_STARS;
  const title = kind === 'overview' ? 'NoRekt — обзор монеты' : 'NoRekt — разбор позиции';
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

// payment succeeded: Stars are a per-item payment (received into your Stars account).
// We don't keep a spendable stars balance; we just reward the inviter on the buyer's FIRST payment.
bot.on('message', async (ctx, next) => {
  const sp = ctx.message?.successful_payment;
  if (!sp) return next();
  try {
    const { telegramId } = JSON.parse(sp.invoice_payload || '{}');
    if (telegramId) await rewardOnFirstPayment(telegramId);
    await ctx.reply('Оплата получена. Спасибо!');
  } catch (e) {
    console.error('[bot] successful_payment handling failed:', e.message);
  }
});

// resolve and cache the bot username (used to build referral links)
export async function getBotUsername() {
  try { const me = await bot.telegram.getMe(); return me.username; }
  catch { return null; }
}

// Webhook handler (Railway gives a public URL; webhook is simpler than long polling there)
export function botWebhook(app, path = '/tg-webhook') {
  app.use(express.json());
  app.post(path, (req, res) => { bot.handleUpdate(req.body, res); });
  return path;
}
