require('dotenv').config({ path: __dirname + '/.env' });
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { MagnusBillingAPI } = require('./magnus-api');
const { PaymentHandler } = require('./payment');
const { Database } = require('./database');
const http = require('http');
const { URL } = require('url');
const { createBtcpayWebhookListener } = require('./btcpay-client');

if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN in .env');
    process.exit(1);
}

/**
 * One poller per bot token on this machine (lock in TMP, not project dir).
 * Stops double /start when two terminals or two clones run the same @BotFather token.
 */
const INSTANCE_LOCK = path.join(
    os.tmpdir(),
    `telegram-poll-${crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN).digest('hex').slice(0, 24)}.lock`
);
function ensureSingleBotInstance() {
    const cleanup = () => {
        try {
            if (!fs.existsSync(INSTANCE_LOCK)) return;
            const cur = fs.readFileSync(INSTANCE_LOCK, 'utf8').trim();
            if (cur === String(process.pid)) fs.unlinkSync(INSTANCE_LOCK);
        } catch (_) {}
    };
    const tryCreate = () => {
        try {
            const fd = fs.openSync(INSTANCE_LOCK, 'wx');
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            try {
                fs.unlinkSync(path.join(__dirname, '.telegram-bot.lock'));
            } catch (_) {}
            process.on('exit', cleanup);
            process.on('SIGINT', () => {
                cleanup();
                process.exit(0);
            });
            process.on('SIGTERM', () => {
                cleanup();
                process.exit(0);
            });
            return true;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            return false;
        }
    };
    if (tryCreate()) return;
    let oldPid = NaN;
    try {
        oldPid = parseInt(fs.readFileSync(INSTANCE_LOCK, 'utf8').trim(), 10);
    } catch (_) {}
    if (Number.isFinite(oldPid)) {
        try {
            process.kill(oldPid, 0);
            console.error(
                `Another process is already polling this Telegram token (PID ${oldPid}).\n` +
                    'Stop every other `node bot.js` / `npm start` on this Mac (other terminals or project copies), then try again.\n' +
                    `If that PID is gone: rm "${INSTANCE_LOCK}"`
            );
            process.exit(1);
        } catch (err) {
            if (err.code !== 'ESRCH') {
                console.error('Lock file present but could not verify PID:', err.message);
                process.exit(1);
            }
        }
    }
    try {
        fs.unlinkSync(INSTANCE_LOCK);
    } catch (_) {}
    if (!tryCreate()) {
        console.error('Could not acquire bot instance lock. Try again in a second.');
        process.exit(1);
    }
}
ensureSingleBotInstance();

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function isAdmin(telegramId) {
    return ADMIN_IDS.includes(String(telegramId));
}

// Bot configuration
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const payments = new PaymentHandler();
if (payments.isBtcpay() && !payments.isConfigured()) {
    console.warn(
        'PAYMENT_PROVIDER=btcpay but BTCPAY_HOST / BTCPAY_STORE_ID / BTCPAY_API_KEY is incomplete. ' +
            'BTCPay: Store → Settings (store id), Account → Access tokens → Create token (Greenfield, Can modify invoices).'
    );
}
const db = new Database();
const { getSipServerHost, getDashboardPortalDisplayUrl } = require('./sip-config');
const {
    parseMagnusExpiration,
    expiryMidnightAfterPlan,
    magnusExpiredays,
    customerFacingPlanEndDate,
    formatCustomerPlanEndDateOnly,
    formatExpirationDateOnlyForMagnusApi,
    startOfLocalDay
} = require('./magnus-expiry');

/** Magnus SIP (or user) save field for outbound CLI — often `callerid` on the `sip` module. */
const CALLER_ID_FIELD = (process.env.MAGNUS_CALLERID_FIELD || 'callerid').trim();

// Magnus Billing API
const magnus = new MagnusBillingAPI(
    process.env.MAGNUS_API_KEY,
    process.env.MAGNUS_API_SECRET,
    process.env.MAGNUS_URL
);

// Plan pricing
const PLANS = {
    daily: { name: 'Daily', price: 70, days: 1 },
    '3days': { name: '3 Days', price: 165, days: 3 },
    weekly: { name: 'Weekly', price: 250, days: 7 },
    biweekly: { name: 'Biweekly', price: 400, days: 14 },
    monthly: { name: 'Monthly', price: 700, days: 30 }
};

/** Plan artwork (PNG loads faster than a large animated GIF in Telegram). Optional — falls back to text. */
const PLAN_BANNER_PNG = path.join(__dirname, 'assets', 'plan-poster.png');

// Magnus `credit` on new users (balance / refill). Override with NEW_USER_INITIAL_CREDIT in .env
const envCredit = parseInt(process.env.NEW_USER_INITIAL_CREDIT, 10);
const NEW_USER_INITIAL_CREDIT =
    Number.isFinite(envCredit) && envCredit >= 0 ? envCredit : 50000;

// User sessions
const sessions = new Map();
/** Serializes fulfillment per order id (webhook + “paid” message). */
const fulfillmentByOrderId = new Map();

/** Bottom menu labels — must stay in sync with the message `switch`. */
const MENU = {
    NEW: '➕ New account',
    EXTEND: '🔁 Renew line',
    PRICING: '💳 Pricing',
    HELP: 'ℹ️ Help',
    VIEW: '👤 My account',
    ORDERS: '📦 My orders',
    CALLER_ID: '📞 Caller ID',
    SETUP: '✨ Setup guide'
};

function mainMenuKeyboard() {
    return {
        keyboard: [
            [MENU.NEW, MENU.EXTEND],
            [MENU.PRICING, MENU.HELP],
            [MENU.VIEW, MENU.CALLER_ID],
            [MENU.SETUP, MENU.ORDERS]
        ],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: 'Message or tap a menu button…'
    };
}

function sanitizeCallerId(raw) {
    let trimmed = String(raw).trim().replace(/^\++/, '');
    if (!trimmed || trimmed.length > 24) {
        throw new Error('Caller ID must be 1–24 characters.');
    }
    if (!/^[\d*#]{2,22}$/.test(trimmed)) {
        throw new Error('Use digits only starting with 1 (e.g. 18003884634). No + sign.');
    }
    return trimmed;
}

async function sendMyAccountSummary(chatId, telegramId) {
    const sipHost = getSipServerHost();
    const tid = String(telegramId);

    const withPassword = await db.getLatestOrderWithStoredPassword(tid);
    if (withPassword && withPassword.magnus_username) {
        await bot.sendMessage(
            chatId,
            '👁 *Your account*\n\n' +
                `👤 *Username:* \`${withPassword.magnus_username}\`\n` +
                `🔑 *Password:* \`${withPassword.magnus_password}\`\n` +
                `📡 *SIP server / registrar:* \`${sipHost}\`\n` +
                `📦 *Last plan:* ${withPassword.plan_name}\n\n` +
                '_Anyone with access to this chat can see this — treat like a password manager._',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    const latest = await db.getLatestPaidOrderForTelegram(tid);
    if (latest && latest.magnus_username) {
        await bot.sendMessage(
            chatId,
            '👁 *Your account*\n\n' +
                `👤 *Username:* \`${latest.magnus_username}\`\n` +
                `📡 *SIP server / registrar:* \`${sipHost}\`\n` +
                `📦 *Last purchase:* ${latest.plan_name} (${latest.order_type})\n\n` +
                '_Password is not stored for renewals — use the SIP password you already have for this account._',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    if (latest) {
        await bot.sendMessage(
            chatId,
            '👁 *Your account*\n\n' +
                `📦 *Last purchase:* ${latest.plan_name} — $${latest.price_usd}\n` +
                `📡 *SIP server / registrar:* \`${sipHost}\`\n\n` +
                '_Complete a purchase with a linked username to see more detail here._',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    await bot.sendMessage(
        chatId,
        '👤 *View account*\n\n' +
            'No completed purchase is linked to this chat yet.\n\n' +
            '• After you *buy a new line*, your username and password appear here.\n' +
            '• After you *renew*, you will see your username and SIP server (password stays private).\n\n' +
            `SIP server: \`${sipHost}\``,
        { parse_mode: 'Markdown' }
    );
}

async function maybeSendDashboardLink(chatId) {
    const url = getDashboardPortalDisplayUrl();
    if (!url) return;
    try {
        await bot.sendMessage(
            chatId,
            `🔗 *Web portal*\n${url}\n\n` +
                '_Log in with your Magnus credentials (same as SIP). Open only on a device you trust._',
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
        console.error('dashboard link', e);
    }
}

// Start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    sessions.delete(chatId);
    
    bot.sendMessage(
        chatId,
        '🚀🚀🎉 *Welcome to Proff OTP!*\n\n' + 'What would you like to do?',
        {
            parse_mode: 'Markdown',
            reply_markup: mainMenuKeyboard()
        }
    );
});

bot.onText(/\/orders/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, 'Not authorized.');
        return;
    }
    try {
        const pending = await db.getPendingOrders();
        if (!pending.length) {
            await bot.sendMessage(chatId, 'No pending orders.');
            return;
        }
        let out = '📋 Pending orders\n\n';
        for (const o of pending.slice(0, 20)) {
            out += `#${o.id} — ${o.order_type} — ${o.plan_name} — $${o.price_usd}`;
            if (o.telegram_username) out += ` — @${o.telegram_username}`;
            out += '\n';
        }
        if (pending.length > 20) out += `\n… and ${pending.length - 20} more`;
        await bot.sendMessage(chatId, out);
    } catch (e) {
        console.error(e);
        await bot.sendMessage(chatId, 'Failed to load orders.');
    }
});

bot.onText(/\/myaccount|\/dashboard/i, async (msg) => {
    await sendMyAccountSummary(msg.chat.id, msg.from.id);
});

bot.onText(/\/myorders/i, async (msg) => {
    await showUserOrders(msg.chat.id, msg.from.id);
});

bot.onText(/\/howto|\/gettingstarted/i, async (msg) => {
    await showGettingStarted(msg.chat.id);
});

/**
 * BTCPay: fulfill latest pending invoice when user sends paid/yes even if session left checkout
 * (e.g. after /start or manual “mark settled” in BTCPay without webhooks).
 */
async function tryBtcpayPaidShortcut(chatId) {
    if (!payments.isBtcpay()) return 'continue';
    const order = await db.getLatestPendingBtcpayOrderForTelegram(String(chatId));
    if (!order) return 'continue';
    const ok = await payments.isBtcpayInvoicePaid(order.btcpay_invoice_id);
    if (!ok) {
        await bot.sendMessage(
            chatId,
            'BTCPay still shows this invoice as unpaid. If you just marked it settled in BTCPay, wait a few seconds and send *paid* again.',
            { parse_mode: 'Markdown' }
        );
        return 'handled';
    }
    try {
        const session = buildSessionFromOrder(order);
        await processActivationGuarded(chatId, session);
    } catch (e) {
        console.error(e);
        await bot.sendMessage(chatId, 'Could not complete your order: ' + e.message);
    }
    return 'handled';
}

// Handle messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || typeof text !== 'string') return;
    if (text.startsWith('/')) return;

    if (!sessions.has(chatId)) {
        sessions.set(chatId, { step: 'menu' });
    }

    const session = sessions.get(chatId);

    const paidish = ['yes', 'paid', 'done'].includes(text.toLowerCase().trim());
    if (paidish && (await tryBtcpayPaidShortcut(chatId)) === 'handled') {
        return;
    }

    switch (text) {
        case MENU.NEW:
        case '🆕 Create New Account':
            session.step = 'select_plan_new';
            await showPlans(chatId, 'new');
            break;

        case MENU.EXTEND:
        case '🔑 Activate Existing':
            session.step = 'enter_username';
            bot.sendMessage(chatId,
                'Please enter your *SIP Username*:',
                { parse_mode: 'Markdown' });
            break;

        case MENU.PRICING:
        case '💰 Pricing':
        case '✅ Pricing':
            await showPricing(chatId);
            break;

        case MENU.HELP:
        case '❓ Help':
            await showHelp(chatId);
            break;

        case MENU.VIEW:
        case '👁 View account':
        case '📊 My account':
            await sendMyAccountSummary(chatId, msg.from.id);
            break;

        case MENU.ORDERS:
            await showUserOrders(chatId, msg.from.id);
            break;

        case MENU.CALLER_ID:
        case '📞 Caller ID':
            session.step = 'callerid_username';
            await bot.sendMessage(
                chatId,
                'Enter your *SIP username* (same as Magnus login):',
                { parse_mode: 'Markdown' }
            );
            break;

        case MENU.SETUP:
        case '🚀 How to get started':
            await showGettingStarted(chatId);
            break;

        default:
            await handleInput(chatId, text, session);
    }
});

// Show plans
async function showPlans(chatId, type) {
    const buttons = Object.entries(PLANS).map(([key, plan]) => ({
        text: `${plan.name} · $${plan.price} · ${plan.days}d`,
        callback_data: `${type}_plan_${key}`
    }));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
    }

    const caption =
        '📋 *Please select a plan to continue.*\n\n' + 'Tap a button below to get started.';
    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: rows
        }
    };
    if (fs.existsSync(PLAN_BANNER_PNG)) {
        await bot.sendPhoto(chatId, PLAN_BANNER_PNG, {
            caption,
            ...opts
        });
    } else {
        await bot.sendMessage(chatId, caption, opts);
    }
}

/**
 * Plan step may be `sendMessage` (body text) or `sendPhoto` / `sendAnimation` (caption).
 * Telegram only allows editing the correct field; wrong API yields “no text in the message”.
 * Use plain text (no parse_mode): BTCPay checkout URLs often contain `_` which breaks Markdown.
 */
async function editCheckoutSummary(bot, msg, plainText) {
    const form = {
        chat_id: msg.chat.id,
        message_id: msg.message_id
    };
    if (typeof msg.text === 'string') {
        await bot.editMessageText(plainText, form);
    } else {
        await bot.editMessageCaption(plainText, form);
    }
}

function formatOrderWhen(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return String(iso);
        return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return String(iso);
    }
}

function statusLabel(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'paid') return 'Paid';
    if (s === 'pending') return 'Awaiting payment';
    if (s === 'cancelled') return 'Cancelled';
    return status || '—';
}

async function showUserOrders(chatId, telegramId) {
    const rows = await db.getUserOrders(String(telegramId));
    if (!rows.length) {
        await bot.sendMessage(
            chatId,
            '📦 *My orders*\n\n_No orders linked to this chat yet._',
            { parse_mode: 'Markdown' }
        );
        return;
    }
    let msg = '📦 *My orders*\n\n';
    for (const o of rows.slice(0, 12)) {
        const st =
            o.status === 'paid'
                ? '✅'
                : o.status === 'pending'
                  ? '⏳'
                  : o.status === 'cancelled'
                    ? '❌'
                    : '•';
        msg +=
            `${st} *#${o.id}* · ${statusLabel(o.status)}\n` +
            `${o.plan_name} · $${o.price_usd} · ${o.order_type}\n` +
            `_Created:_ ${formatOrderWhen(o.created_at)}`;
        if (o.paid_at) msg += `\n_Paid:_ ${formatOrderWhen(o.paid_at)}`;
        if (o.status === 'pending' && o.invoice_expires_at) {
            msg += `\n_Invoice expires:_ ${formatOrderWhen(o.invoice_expires_at)}`;
        }
        if (o.status === 'pending' && o.btc_address && /^https?:\/\//i.test(String(o.btc_address))) {
            msg += `\n[Open checkout](${o.btc_address})`;
        }
        msg += '\n\n';
    }
    if (rows.length > 12) {
        msg += `_Showing latest 12 of ${rows.length}._`;
    }
    await bot.sendMessage(chatId, msg.trimEnd(), {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
    });
}

async function sendPaymentReceipt(chatId, orderId) {
    if (!orderId) return;
    const order = await db.getOrder(orderId);
    if (!order || order.status !== 'paid') return;
    const invLine = order.btcpay_invoice_id
        ? `\n_Reference:_ invoice \`${order.btcpay_invoice_id}\`\n`
        : '';
    await bot.sendMessage(
        chatId,
        '🧾 *Payment receipt*\n\n' +
            `*Order* #${order.id}\n` +
            `*Plan:* ${order.plan_name}\n` +
            `*Amount:* $${order.price_usd} USD\n` +
            `*Type:* ${order.order_type === 'new' ? 'New account' : 'Renew line'}\n` +
            `*Paid:* ${formatOrderWhen(order.paid_at)}\n` +
            invLine +
            '\n_Save this message as proof of payment._',
        { parse_mode: 'Markdown' }
    );
}

// Show pricing
async function showPricing(chatId) {
    let message = '💳 *Plans*\n\n';
    Object.entries(PLANS).forEach(([key, plan]) => {
        message += `▸ *${plan.name}* — \`$${plan.price}\` · ${plan.days}d\n`;
    });
    message += '\n_Pick *New account* or *Renew line*, then pay with Bitcoin._';

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Show help
async function showHelp(chatId) {
    bot.sendMessage(
        chatId,
        'ℹ️ *Help*\n\n' +
            `• *${MENU.NEW}* — New VoIP line + credentials\n` +
            `• *${MENU.EXTEND}* — Add time to an existing username\n\n` +
            `• *${MENU.ORDERS}* — Order status, checkout links for unpaid invoices\n\n` +
            'Both flows let you pick a plan. With *BTCPay* or a *BTC address*, you get checkout / payment instructions; otherwise reply *yes* after choosing (demo).\n\n' +
            '*SIP* uses the *same* username and password as Magnus.\n\n' +
            `After purchase: *${MENU.VIEW}* or /myaccount — plus a *payment receipt* message.\n` +
            'A billing portal link appears when `DASHBOARD_PUBLIC_URL` is configured.\n\n' +
            `*${MENU.SETUP}* — apps, Caller ID, and portal tips.\n\n` +
            'For support: [PROFESSOR](https://t.me/mrbeattheodz)',
        { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
}

// Softphone setup + Caller ID (HTML for links and layout)
async function showGettingStarted(chatId) {
    const html =
        '<b>How to Get Started</b> 📱\n\n' +
        'After receiving your login credentials, follow the steps below to begin using the service:\n\n' +
        '<b>iOS</b>\n' +
        'Go to the App Store and download <b>PortSIP</b>.\n\n' +
        '<b>Android</b>\n' +
        'Download our app here:\n' +
        '<a href="https://i.apponthego.com/7fe67">https://i.apponthego.com/7fe67</a>\n\n' +
        'Once installed, log in using your provided credentials and you can begin making calls immediately.\n\n' +
        '<b>Caller ID Configuration</b> ☎️\n\n' +
        'Your Caller ID can be updated in two ways:\n\n' +
        '<b>Payment Bot</b>\n' +
        `You can modify your Caller ID directly in this bot — tap <b>${MENU.CALLER_ID}</b> in the menu below.\n\n` +
        '<b>User Portal</b>\n' +
        '• Log in to your account\n' +
        '• Open the <b>Menu</b>\n' +
        '• Select <b>SIP User</b>\n' +
        '• Click your username\n' +
        '• In the settings window, edit your Caller ID\n' +
        '• Save your changes';

    await bot.sendMessage(chatId, html, { parse_mode: 'HTML' });
}

// Handle user input
async function handleInput(chatId, text, session) {
    switch (session.step) {
        case 'enter_username':
            session.username = text;
            session.step = 'enter_password';
            bot.sendMessage(chatId, 'Please enter your *Password*:', { parse_mode: 'Markdown' });
            break;
            
        case 'enter_password':
            session.password = text;
            session.step = 'select_plan_existing';
            await showPlans(chatId, 'existing');
            break;

        case 'callerid_username':
            session.cid_username = text.trim();
            session.step = 'callerid_password';
            await bot.sendMessage(chatId, 'Enter your *SIP password*:', { parse_mode: 'Markdown' });
            break;

        case 'callerid_password': {
            const cidUser = await magnus.getUserByUsername(session.cid_username);
            if (!cidUser) {
                await bot.sendMessage(chatId, '❌ User not found. Tap *📞 Caller ID* to try again.', { parse_mode: 'Markdown' });
                session.step = 'menu';
                break;
            }
            if (cidUser.password !== text) {
                await bot.sendMessage(chatId, '❌ Wrong password. Tap *📞 Caller ID* to start over.', { parse_mode: 'Markdown' });
                session.step = 'menu';
                break;
            }
            session.cid_user_id = cidUser.id;
            session.step = 'callerid_new';
            await bot.sendMessage(
                chatId,
                'Send the *Caller ID* for outbound calls — digits starting with *1*, no + sign (e.g. `18003884634`).\n\n' +
                    '_Your carrier/trunk and Magnus must allow this number._',
                { parse_mode: 'Markdown' }
            );
            break;
        }

        case 'callerid_new': {
            let cid;
            try {
                cid = sanitizeCallerId(text);
            } catch (e) {
                await bot.sendMessage(chatId, '❌ ' + e.message);
                return;
            }
            const payload = { [CALLER_ID_FIELD]: cid };
            const sipRow = await magnus.getSipByUserId(session.cid_user_id);
            const upd = sipRow
                ? await magnus.update('sip', sipRow.id, payload)
                : await magnus.update('user', session.cid_user_id, payload);
            if (!upd.success) {
                await bot.sendMessage(
                    chatId,
                    '❌ Magnus rejected the change. Common causes: API key has no SIP write, no SIP row for this user, or wrong field name.\n' +
                        'Set `MAGNUS_CALLERID_FIELD` in .env if your panel uses a different column (often `callerid` on SIP).\n' +
                        JSON.stringify(upd.errors || upd)
                );
            } else {
                await bot.sendMessage(
                    chatId,
                    `✅ Caller ID set to \`${cid}\`\n\n` +
                        'If live calls still show an old number, check trunk CLIR, P-Asserted-Identity, and softphone "from user" settings.',
                    { parse_mode: 'Markdown' }
                );
            }
            session.step = 'menu';
            delete session.cid_username;
            delete session.cid_user_id;
            break;
        }

        case 'confirm_payment':
            if (['yes', 'paid', 'done'].includes(text.toLowerCase().trim())) {
                if (payments.isBtcpay() && session.orderId) {
                    const ord = await db.getOrder(session.orderId);
                    if (ord && ord.btcpay_invoice_id) {
                        const ok = await payments.isBtcpayInvoicePaid(ord.btcpay_invoice_id);
                        if (!ok) {
                            await bot.sendMessage(
                                chatId,
                                'BTCPay does not show this invoice as paid yet. Finish payment on the checkout page, wait for confirmations, then try *paid* again.',
                                { parse_mode: 'Markdown' }
                            );
                            break;
                        }
                    }
                }
                await processActivationGuarded(chatId, session);
            }
            break;
    }
}

// Handle callback queries
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const from = query.from;

    if (!sessions.has(chatId)) {
        sessions.set(chatId, { step: 'menu' });
    }
    const session = sessions.get(chatId);

    const ack = (text) => bot.answerCallbackQuery(query.id, { text }).catch(() => {});

    try {
        if (data.startsWith('new_plan_')) {
            const planKey = data.replace('new_plan_', '');
            const plan = PLANS[planKey];
            if (!plan) {
                await ack('Invalid plan');
                return;
            }

            session.plan = plan;
            session.type = 'new';
            session.step = 'confirm_payment';
            session.orderId = null;

            const prevSignup = await db.getLatestOrderWithStoredPassword(String(chatId));
            const replacePreviousUsername = prevSignup?.magnus_username || null;
            session.previousMagnusUsernameToReplace = replacePreviousUsername || undefined;

            let replacementWarning = '';
            if (replacePreviousUsername) {
                replacementWarning =
                    `\n\n⚠️ Returning customer\n` +
                    `You already have an account (${replacePreviousUsername}). ` +
                    `When this purchase completes, that account will be permanently deleted from our system and replaced by your new login.\n`;
            }

            let paymentBlock = '';
            if (payments.isConfigured()) {
                const orderId = await db.createOrder({
                    telegram_id: String(chatId),
                    telegram_username: from.username || null,
                    order_type: 'new',
                    plan_key: planKey,
                    plan_name: plan.name,
                    price_usd: plan.price,
                    btc_amount: null,
                    btc_address: null,
                    magnus_username: null,
                    magnus_password: null,
                    replace_previous_username: replacePreviousUsername
                });
                session.orderId = orderId;
                const pay = await payments.generatePayment(String(orderId), plan.price);
                await db.updateOrder(orderId, {
                    btc_amount: pay.btcAmount != null ? parseFloat(pay.btcAmount) : null,
                    btc_address: pay.paymentAddress,
                    btcpay_invoice_id: pay.invoiceId || null,
                    invoice_expires_at: pay.expiresAt || null
                });
                if (pay.checkoutLink) {
                    paymentBlock =
                        `\n💳 Pay with Bitcoin (BTCPay)\n` +
                        `Order #${orderId} — $${plan.price} USD\n\n` +
                        `Open checkout:\n${pay.checkoutLink}\n\n` +
                        `Your account is created automatically when the invoice is paid.\n` +
                        `You can also reply paid here after paying.\n`;
                } else {
                    const fb = pay.manualFallback
                        ? `\n(BTCPay checkout is temporarily unavailable — send to the address below.)\n`
                        : '';
                    paymentBlock =
                        fb +
                        `\n💳 Pay with Bitcoin\n` +
                        `Send ${pay.btcAmount} BTC\n` +
                        `Address:\n${pay.paymentAddress}\n` +
                        `Order #${orderId}\n` +
                        `(~$${plan.price} USD @ ~$${Math.round(pay.btcPrice)}/BTC)\n\n` +
                        `After sending, reply paid here.\n`;
                }
            } else {
                paymentBlock =
                    `\n⚠️ No payment method in .env (BTC_ADDRESS, PAYMENT_PROVIDER=btcpay, etc.) — demo mode: reply yes to create your account without payment.\n\n`;
            }

            await editCheckoutSummary(
                bot,
                query.message,
                `✅ Plan selected: ${plan.name}\n\n` +
                    `Price: $${plan.price}\n` +
                    `Duration: ${plan.days} days` +
                    replacementWarning +
                    `\n` +
                    paymentBlock
            );

            await bot.sendMessage(chatId, 'Complete your payment to activate your selected plan.');
            await ack();
        } else if (data.startsWith('existing_plan_')) {
            const planKey = data.replace('existing_plan_', '');
            const plan = PLANS[planKey];
            if (!plan) {
                await ack('Invalid plan');
                return;
            }

            session.plan = plan;
            session.type = 'existing';
            session.step = 'confirm_payment';
            session.orderId = null;

            let paymentBlock = '';
            if (payments.isConfigured()) {
                const orderId = await db.createOrder({
                    telegram_id: String(chatId),
                    telegram_username: from.username || null,
                    order_type: 'extend',
                    plan_key: planKey,
                    plan_name: plan.name,
                    price_usd: plan.price,
                    btc_amount: null,
                    btc_address: null,
                    magnus_username: session.username,
                    magnus_password: session.password || null
                });
                session.orderId = orderId;
                const pay = await payments.generatePayment(String(orderId), plan.price);
                await db.updateOrder(orderId, {
                    btc_amount: pay.btcAmount != null ? parseFloat(pay.btcAmount) : null,
                    btc_address: pay.paymentAddress,
                    btcpay_invoice_id: pay.invoiceId || null,
                    invoice_expires_at: pay.expiresAt || null
                });
                if (pay.checkoutLink) {
                    paymentBlock =
                        `\n💳 Pay with Bitcoin (BTCPay)\n` +
                        `Order #${orderId} — $${plan.price} USD\n\n` +
                        `Open checkout:\n${pay.checkoutLink}\n\n` +
                        `Your extension applies automatically when the invoice is paid.\n` +
                        `You can also reply paid here after paying.\n`;
                } else {
                    const fb = pay.manualFallback
                        ? `\n(BTCPay checkout is temporarily unavailable — send to the address below.)\n`
                        : '';
                    paymentBlock =
                        fb +
                        `\n💳 Pay with Bitcoin\n` +
                        `Send ${pay.btcAmount} BTC\n` +
                        `Address:\n${pay.paymentAddress}\n` +
                        `Order #${orderId}\n\n` +
                        `After sending, reply paid here.\n`;
                }
            } else {
                paymentBlock =
                    `\n⚠️ Demo mode: reply yes to extend your account (no payment method in .env).\n\n`;
            }

            await editCheckoutSummary(
                bot,
                query.message,
                `✅ Plan selected: ${plan.name}\n\n` +
                    `Price: $${plan.price}\n` +
                    `Extension: ${plan.days} days\n\n` +
                    `Account: ${session.username}\n` +
                    paymentBlock
            );

            await bot.sendMessage(chatId, 'Complete your payment to activate your selected plan.');
            await ack();
        } else {
            await ack();
        }
    } catch (e) {
        const api = e?.response?.data;
        const apiMsg =
            api && typeof api === 'object'
                ? api.message || api.title || api.code || JSON.stringify(api)
                : api;
        console.error('checkout callback', apiMsg || e?.message || e);
        await ack('Something went wrong');
        let hint = e?.message || '';
        if (apiMsg && String(apiMsg) !== hint) hint = hint ? `${hint} — ${apiMsg}` : String(apiMsg);
        if (hint.length > 350) hint = hint.slice(0, 350) + '…';
        await bot.sendMessage(
            chatId,
            '❌ Could not start checkout. Try again or contact support.' + (hint ? `\n\n${hint}` : '')
        );
    }
});

// Process activation
async function processActivation(chatId, session) {
    await bot.sendMessage(chatId, 'Waiting for payment confirmation. This may take a moment.');

    try {
        if (session.type === 'new') {
            await createNewAccount(chatId, session);
        } else {
            await activateExistingAccount(chatId, session);
        }
        sessions.set(chatId, { step: 'menu' });
    } catch (error) {
        await bot.sendMessage(chatId, '❌ Error: ' + error.message);
        console.error(error);
    }
}

function buildSessionFromOrder(order) {
    const plan = PLANS[order.plan_key];
    if (!plan) {
        throw new Error(`Unknown plan_key: ${order.plan_key}`);
    }
    return {
        step: 'confirm_payment',
        type: order.order_type === 'new' ? 'new' : 'existing',
        plan,
        orderId: order.id,
        username: order.magnus_username || undefined,
        password: order.magnus_password || undefined,
        previousMagnusUsernameToReplace: order.replace_previous_username || undefined
    };
}

async function processActivationGuarded(chatId, session) {
    const oid = session.orderId;
    if (oid) {
        if (fulfillmentByOrderId.has(oid)) {
            try {
                await fulfillmentByOrderId.get(oid);
            } catch (_) {
                /* first attempt failed */
            }
            return;
        }
        const cur = await db.getOrder(oid);
        if (cur && cur.status === 'paid') {
            return;
        }
        const p = processActivation(chatId, session);
        fulfillmentByOrderId.set(oid, p);
        try {
            await p;
        } finally {
            fulfillmentByOrderId.delete(oid);
        }
        return;
    }
    await processActivation(chatId, session);
}

// Generate random credentials
function generateCredentials() {
    const username = 'u' + Math.random().toString(36).substring(2, 8);
    const password = Math.random().toString(36).substring(2, 12);
    return { username, password };
}

/** Remove prior Magnus user + SIP when a returning customer buys another “new line”. */
async function deletePriorMagnusSignup(oldUsername, newUsername) {
    if (!oldUsername || oldUsername === newUsername) return;
    try {
        const oldUser = await magnus.getUserByUsername(oldUsername);
        if (!oldUser?.id) return;
        const sipRow = await magnus.getSipByUserId(oldUser.id);
        if (sipRow?.id) {
            const sipDel = await magnus.destroy('sip', sipRow.id);
            if (!sipDel.success) {
                console.error('destroy sip for replace-previous', oldUsername, sipDel.errors || sipDel);
            }
        }
        const userDel = await magnus.destroy('user', oldUser.id);
        if (!userDel.success) {
            console.error('destroy user for replace-previous', oldUsername, userDel.errors || userDel);
        }
    } catch (e) {
        console.error('deletePriorMagnusSignup', e);
    }
}

// Create new account
async function createNewAccount(chatId, session) {
    try {
        if (session.orderId && !session.previousMagnusUsernameToReplace) {
            const ord = await db.getOrder(session.orderId);
            if (ord?.replace_previous_username) {
                session.previousMagnusUsernameToReplace = ord.replace_previous_username;
            }
        }

        // Generate credentials
        const { username, password } = generateCredentials();
        
        const purchasedAt = new Date();
        const expiresAt = expiryMidnightAfterPlan(purchasedAt, session.plan.days);
        const customerEndDate = customerFacingPlanEndDate(purchasedAt, session.plan.days);

        // Create user (credit 0 first — same as API tests; some installs reject credit on create)
        const userPayload = {
            username: username,
            password: password,
            id_group: 3,
            id_plan: 1,
            credit: 0,
            active: 1,
            callingcard_pin: Math.floor(Math.random() * 1000000).toString().padStart(6, '0'),
            callingcard_number: Math.floor(Math.random() * 10000000000).toString().padStart(10, '0'),
            expirationdate: formatExpirationDateOnlyForMagnusApi(expiresAt),
            enableexpire: 1,
            expiredays: magnusExpiredays(session.plan.days)
        };

        const userResult = await magnus.create('user', userPayload);

        if (!userResult.success) {
            throw new Error('Failed to create user: ' + JSON.stringify(userResult.errors));
        }

        const userId = userResult.rows?.[0]?.id;

        let creditLine = `💳 *Starting credit:* ${NEW_USER_INITIAL_CREDIT.toLocaleString('en-US')}\n`;
        if (userId && NEW_USER_INITIAL_CREDIT > 0) {
            try {
                const credUp = await magnus.update('user', userId, { credit: NEW_USER_INITIAL_CREDIT });
                if (!credUp.success) {
                    creditLine =
                        `💳 *Starting credit:* could not set to ${NEW_USER_INITIAL_CREDIT.toLocaleString('en-US')} automatically — contact support.\n`;
                }
            } catch (e) {
                console.error('Credit update failed:', e.response?.status || e.message);
                creditLine =
                    `💳 *Starting credit:* could not be applied automatically — contact support.\n`;
            }
        }

        // SIP always uses the same username + password as the Magnus user (standard Magnus pattern).
        const sipUsername = username;
        const sipSecret = password;

        let sipLine =
            '\n📞 *SIP softphone:* use the *same* username and password as above (no separate SIP password).';
        if (userId) {
            try {
                const sipResult = await magnus.create('sip', {
                    id_user: userId,
                    name: sipUsername,
                    username: sipUsername,
                    secret: sipSecret,
                    host: 'dynamic',
                    context: 'billing',
                    allow: 'g729,ulaw,alaw',
                    dtmfmode: 'RFC2833',
                    nat: 'yes',
                    type: 'friend',
                    qualify: 'yes'
                });
                if (!sipResult.success) {
                    sipLine +=
                        '\n_Auto SIP row was not created (API/permissions); credentials above are still what you use once SIP exists._';
                }
            } catch (e) {
                console.error('SIP create failed:', e.response?.status || e.message);
                sipLine +=
                    '\n_Auto SIP row was not created (API/permissions); credentials above are still what you use once SIP exists._';
            }
        }

        if (session.orderId) {
            await db.updateOrder(session.orderId, {
                status: 'paid',
                magnus_username: username,
                magnus_password: password,
                paid_at: new Date().toISOString()
            });
        }

        const prior = session.previousMagnusUsernameToReplace;
        let replacedLine = '';
        if (prior && prior !== username) {
            await deletePriorMagnusSignup(prior, username);
            replacedLine = `\n🗑 *Previous account removed:* \`${prior}\` _(deleted from billing — use the new login above)._\n`;
        }

        const sipHost = getSipServerHost();
        await bot.sendMessage(chatId,
            '✅ *Account Created!*\n\n' +
            `👤 *Username:* \`${username}\`\n` +
            `🔑 *Password:* \`${password}\`\n` +
            `📡 *SIP server / registrar:* \`${sipHost}\`\n` +
            creditLine +
            `🔚 *Service through end of:* \`${formatCustomerPlanEndDateOnly(customerEndDate)}\` _(local calendar date; ${session.plan.days}-day plan)_\n` +
            sipLine +
            replacedLine +
            '\n\nPayment received. Updates + support: https://t.me/PROFFOTP\n\n' +
            '⚠️ Save these credentials now.\n' +
            `_Send /myaccount or tap ${MENU.VIEW} anytime to see this again._`, {
            parse_mode: 'Markdown'
        });

        await sendPaymentReceipt(chatId, session.orderId);
        await maybeSendDashboardLink(chatId);

    } catch (error) {
        await bot.sendMessage(chatId, '❌ Failed to create account. Please contact support.');
        throw error;
    }
}

// Activate existing account
async function activateExistingAccount(chatId, session) {
    try {
        // Find user
        const user = await magnus.getUserByUsername(session.username);
        
        if (!user) {
            bot.sendMessage(chatId, '❌ User not found. Please check your username.');
            return;
        }
        
        // Verify password
        if (user.password !== session.password) {
            bot.sendMessage(chatId, '❌ Invalid password. Please try again.');
            return;
        }
        
        const parsed = parseMagnusExpiration(user.expirationdate);
        const anchorMs = Math.max(parsed ? parsed.getTime() : Date.now(), Date.now());
        const anchor = startOfLocalDay(new Date(anchorMs));
        const newExp = expiryMidnightAfterPlan(anchor, session.plan.days);
        const customerEndDate = customerFacingPlanEndDate(anchor, session.plan.days);

        const upd = await magnus.update('user', user.id, {
            expirationdate: formatExpirationDateOnlyForMagnusApi(newExp),
            enableexpire: 1,
            expiredays: magnusExpiredays(session.plan.days),
            active: 1
        });

        if (!upd.success) {
            throw new Error(JSON.stringify(upd.errors || upd));
        }

        if (session.orderId) {
            await db.updateOrder(session.orderId, {
                status: 'paid',
                magnus_username: session.username,
                magnus_password: null,
                paid_at: new Date().toISOString()
            });
        }

        const sipHost = getSipServerHost();
        await bot.sendMessage(chatId,
            '✅ *Account Activated!*\n\n' +
            `👤 Username: \`${session.username}\`\n` +
            `📡 *SIP server / registrar:* \`${sipHost}\`\n` +
            `🔚 *Service through end of:* \`${formatCustomerPlanEndDateOnly(customerEndDate)}\` _(local calendar date; +${session.plan.days} day extension)_\n\n` +
            'Your account is now active.\n' +
            'Payment received. Updates + support: https://t.me/PROFFOTP\n' +
            `_Use the same SIP password as before. Tap ${MENU.VIEW} for server details; ${MENU.CALLER_ID} for Caller ID._`,
            { parse_mode: 'Markdown' });

        await sendPaymentReceipt(chatId, session.orderId);

    } catch (error) {
        await bot.sendMessage(chatId, '❌ Failed to activate account. Please contact support.');
        throw error;
    }
}

const _btcpayWebhookPort = parseInt(process.env.BTCPAY_WEBHOOK_PORT || '0', 10);
const _btcpayWebhookPath = (process.env.BTCPAY_WEBHOOK_PATH || '/btcpay').trim() || '/btcpay';
if (payments.isBtcpay() && _btcpayWebhookPort > 0) {
    const _whSecret = (process.env.BTCPAY_WEBHOOK_SECRET || '').trim();
    if (!_whSecret) {
        console.warn('BTCPAY_WEBHOOK_PORT is set but BTCPAY_WEBHOOK_SECRET is missing; webhook listener not started.');
    } else {
        const _listener = createBtcpayWebhookListener({
            secret: _whSecret,
            host: process.env.BTCPAY_HOST,
            storeId: process.env.BTCPAY_STORE_ID,
            apiKey: process.env.BTCPAY_API_KEY,
            onPaidOrder: async (orderIdStr) => {
                const orderId = parseInt(orderIdStr, 10);
                if (!Number.isFinite(orderId)) return;
                const order = await db.getOrder(orderId);
                if (!order || order.status !== 'pending') return;
                if (order.order_type === 'extend' && !order.magnus_password) {
                    console.error(`BTCPay webhook: order ${orderId} extend without stored password`);
                    try {
                        await bot.sendMessage(
                            order.telegram_id,
                            `Order #${orderId}: BTCPay shows paid, but automatic extension failed. Contact support.`
                        );
                    } catch (e) {
                        console.error(e.message);
                    }
                    return;
                }
                let session;
                try {
                    session = buildSessionFromOrder(order);
                } catch (e) {
                    console.error('buildSessionFromOrder', e);
                    return;
                }
                await processActivationGuarded(order.telegram_id, session);
            }
        });
        const _httpServer = http.createServer((req, res) => {
            let u;
            try {
                u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            } catch {
                res.writeHead(400).end();
                return;
            }
            if (req.method === 'POST' && u.pathname === _btcpayWebhookPath) {
                _listener(req, res).catch((e) => {
                    console.error('BTCPay webhook', e);
                    if (!res.headersSent) res.writeHead(500).end();
                });
                return;
            }
            if (req.method === 'GET' && u.pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, service: 'magnus-payment-bot' }));
                return;
            }
            res.writeHead(404).end();
        });
        _httpServer.listen(_btcpayWebhookPort, '0.0.0.0', () => {
            console.log(`BTCPay webhook: http://0.0.0.0:${_btcpayWebhookPort}${_btcpayWebhookPath}`);
            console.log('In BTCPay → Store → Webhooks, enable invoice events for this URL (settled / processing / etc.).');
        });
    }
}

const INVOICE_REMINDER_POLL_MS = Math.max(60000, parseInt(process.env.INVOICE_REMINDER_POLL_MS || '120000', 10));
const INVOICE_REMINDER_BEFORE_MS =
    Math.max(5, parseInt(process.env.INVOICE_REMINDER_MINUTES_BEFORE || '45', 10)) * 60 * 1000;

async function runInvoiceReminders() {
    if (!payments.isBtcpay()) return;
    let rows;
    try {
        rows = await db.getPendingOrdersWithInvoiceExpiry();
    } catch (e) {
        console.error('invoice reminders: query', e);
        return;
    }
    const now = Date.now();
    for (const o of rows) {
        if (o.invoice_reminder_sent_at) continue;
        const exp = new Date(o.invoice_expires_at).getTime();
        if (!Number.isFinite(exp)) continue;
        if (exp <= now) continue;
        if (exp - now > INVOICE_REMINDER_BEFORE_MS) continue;
        const checkout =
            o.btc_address && /^https?:\/\//i.test(String(o.btc_address)) ? String(o.btc_address) : null;
        const body =
            `⏰ *Invoice reminder*\n\n` +
            `Order *#${o.id}* · ${o.plan_name} · *$${o.price_usd}*\n` +
            `_Expires:_ ${formatOrderWhen(o.invoice_expires_at)}\n\n` +
            (checkout ? `[👉 Open BTCPay checkout](${checkout})\n\n` : '') +
            '_Pay before the invoice expires._';
        try {
            await bot.sendMessage(o.telegram_id, body, { parse_mode: 'Markdown' });
            await db.updateOrder(o.id, { invoice_reminder_sent_at: new Date().toISOString() });
        } catch (e) {
            console.error('invoice reminder send', o.id, e.message);
        }
    }
}

setInterval(runInvoiceReminders, INVOICE_REMINDER_POLL_MS);
setTimeout(() => {
    runInvoiceReminders().catch((e) => console.error('invoice reminders:', e));
}, 20000);

console.log('🤖 Magnus Billing Payment Bot started!');
console.log('Waiting for customers...');

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled error:', error);
});
