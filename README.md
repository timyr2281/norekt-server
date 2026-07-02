# RiskCheck — backend (Railway + Node.js)

Бот + API + фоновый опрос блокчейна + оплата Telegram Stars.
Всё крутится в одном процессе на Railway. Воркер опроса сетей запускается сам внутри сервера.

## Что делает
- Хранит пользователей и баланс (USD) в PostgreSQL, привязка по Telegram ID.
- `/api/deposit/create` выдаёт **точную сумму с уникальной меткой** (base + 0.001…0.999) и адрес.
- Фоновый watcher каждые `POLL_MS` опрашивает твои адреса (BSC, Arbitrum, TRON), находит входящую транзакцию ровно на эту сумму и зачисляет баланс. Один tx используется один раз.
- Оплата звёздами: бот создаёт invoice (валюта `XTR`), мини-апп открывает его, бот ловит оплату и зачисляет звёзды.

## Что нужно добыть самому
1. **BOT_TOKEN** — у @BotFather.
2. **ETHERSCAN_KEY** — один ключ Etherscan API V2 покрывает BSC + Arbitrum + все EVM-сети. Регистрируешься на etherscan.io → создаёшь один API-ключ. **TronGrid** ключ опционально (trongrid.io).
3. Аккаунт **Railway**.

## Деплой на Railway
1. Залей этот проект в GitHub-репозиторий.
2. Railway → New Project → Deploy from GitHub repo → выбери репозиторий.
3. Add Plugin → **PostgreSQL** (Railway сам пропишет `DATABASE_URL`).
4. В Variables впиши переменные из `.env.example` (BOT_TOKEN, WEBAPP_URL, ключи сканеров, адреса).
5. Railway соберёт и запустит `npm start`. Публичный домен он даёт сам — вебхук Telegram выставится автоматически.

## Проверка адресов
`EVM_ADDRESS` используется для BSC и Arbitrum, `TRON_ADDRESS` — для TRC20.
**Перепроверь их** — зачисление идёт по реальным поступлениям, ошибка в адресе = потерянные деньги.

## Важные нюансы (честно)
- **Баланс хранится в USD.** USDT/USDC считаются 1:1, ETH пересчитывается по текущему курсу (CoinGecko) в момент зачисления.
- **Метка 0.001 даёт ~999 вариантов на сумму.** Сервер выдаёт только свободную метку и держит её `DEPOSIT_TTL_MIN` минут; этого достаточно для нормальных объёмов. При экстремальном потоке одинаковых сумм увеличь разрядность метки.
- **BTC не подключён** — адреса BTC не было. Чтобы добавить, нужен отдельный watcher (например, через blockchair/mempool.space) и BTC-адрес.
- **Подтверждения сети.** Сейчас зачисление идёт по факту появления tx в выдаче сканера. Для безопасности можно дождаться N подтверждений — добавь проверку `confirmations` в `fetchIncoming`.
- **Курс ETH** берётся из CoinGecko; на больших объёмах используй платный источник цены.

## Стыковка с мини-аппом
В `riskcheck-miniapp.html` клиентские заглушки заменяются на вызовы этого API.
Каждый запрос шлёт заголовок `X-Init-Data: <Telegram.WebApp.initData>` — сервер проверяет подпись и доверяет Telegram ID.

Эндпоинты:
- `POST /api/me` — профиль и балансы.
- `POST /api/profile` `{name, avatar_url}` — сменить имя/аватар.
- `POST /api/methods` — список монет и сетей с адресами.
- `POST /api/deposit/create` `{coin, network, amount}` → `{address, expected_amount, expires_at, id}`.
- `POST /api/deposit/status` `{id}` → статус + актуальный баланс.
- `POST /api/charge/usd` `{kind:"review"|"overview"}` → списать с USD-баланса.
- `POST /api/stars/invoice` `{kind}` → `{link}` для `Telegram.WebApp.openInvoice(link)`.

## Локальный запуск
```
cp .env.example .env   # заполни значения
npm install
npm start
```
