/**
 * Optional read-only credential portal. Set DASHBOARD_PUBLIC_URL and run:
 *   node dashboard-server.js
 * Put the same URL in .env (HTTPS recommended). Bind defaults to 127.0.0.1 — use a reverse proxy in production.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const { Database } = require('./database');
const { getSipServerHost } = require('./sip-config');

const db = new Database();
const app = express();
const port = parseInt(process.env.DASHBOARD_PORT || '3847', 10);
const bind = (process.env.DASHBOARD_BIND || '127.0.0.1').trim();

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

app.get('/v/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    try {
        const row = await db.getDashboardSession(req.params.token);
        if (!row) {
            res.status(410).type('html').send('<p>Invalid or expired link.</p>');
            return;
        }
        const host = row.sip_host || getSipServerHost();
        const pwdHtml = row.magnus_password
            ? `<code>${esc(row.magnus_password)}</code>`
            : '<em>Not stored for this purchase — use the password you already use for this account.</em>';
        res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Account</title>
<style>
body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.45;background:#0f1419;color:#e6edf3}
h1{font-size:1.25rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem 1.25rem;margin-top:1rem}
code{background:#21262d;padding:0.15rem 0.4rem;border-radius:4px;font-size:0.95rem;word-break:break-all}
.warn{color:#d29922;font-size:0.9rem;margin-top:1rem}
</style></head><body>
<h1>Your VoIP login</h1>
<div class="card">
<p><strong>Username</strong><br/><code>${esc(row.magnus_username)}</code></p>
<p><strong>Password</strong><br/>${pwdHtml}</p>
<p><strong>SIP server / registrar</strong><br/><code>${esc(host)}</code></p>
</div>
<p class="warn">Do not bookmark this page. Close when finished. Link expires automatically.</p>
</body></html>`);
    } catch (e) {
        console.error(e);
        res.status(500).type('html').send('<p>Server error.</p>');
    }
});

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.listen(port, bind, () => {
    console.log(`Credential dashboard listening on http://${bind}:${port}`);
    if (bind === '127.0.0.1' || bind === '::1') {
        console.log('Tip: expose via HTTPS reverse proxy and set DASHBOARD_PUBLIC_URL in .env for the bot to send links.');
    }
});
