const crypto = require('crypto');
const axios = require('axios');

function normalizeHost(host) {
    return String(host || '').trim().replace(/\/+$/, '');
}

/**
 * BTCPay-SIG: sha256=hex(hmac_sha256(webhookSecret, rawBody))
 * @param {Buffer} rawBody
 * @param {string|undefined} sigHeader
 * @param {string|undefined} secret
 */
function verifyWebhookSignature(rawBody, sigHeader, secret) {
    if (!secret || typeof sigHeader !== 'string' || !sigHeader.startsWith('sha256=')) {
        return false;
    }
    const h = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const expected = `sha256=${h}`;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sigHeader, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function invoiceIsPaidEnough(inv) {
    if (!inv) return false;
    const st = String(inv.status || '').trim().toLowerCase();
    if (st === 'settled' || st === 'complete') return true;
    const add = String(inv.additionalStatus || '').trim().toLowerCase();
    if (st === 'processing' && ['paid', 'overpaid', 'marked'].includes(add)) {
        return true;
    }
    return false;
}

async function getInvoice(host, storeId, apiKey, invoiceId) {
    const url = `${normalizeHost(host)}/api/v1/stores/${encodeURIComponent(storeId)}/invoices/${encodeURIComponent(invoiceId)}`;
    const { data } = await axios.get(url, {
        headers: { Authorization: `token ${apiKey}` },
        timeout: 30000
    });
    return data;
}

/**
 * @param {string} host
 * @param {string} storeId
 * @param {string} apiKey
 * @param {{ amountUsd: number, orderId: string|number, description?: string }} opts
 */
async function createInvoice(host, storeId, apiKey, opts) {
    const url = `${normalizeHost(host)}/api/v1/stores/${encodeURIComponent(storeId)}/invoices`;
    const amount = Number(opts.amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Invalid USD amount for BTCPay invoice');
    }
    const { data, status } = await axios.post(
        url,
        {
            amount: amount.toFixed(2),
            currency: 'USD',
            metadata: {
                orderId: String(opts.orderId),
                itemDesc: String(opts.description || `Order #${opts.orderId}`)
            },
            checkout: {
                speedPolicy: process.env.BTCPAY_SPEED_POLICY || 'MediumSpeed'
            }
        },
        {
            headers: {
                Authorization: `token ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000,
            validateStatus: () => true
        }
    );
    if (status >= 400) {
        const msg = data && (data.message || data.title || JSON.stringify(data));
        let err = `BTCPay create invoice failed (${status}): ${msg}`;
        const m = String(msg);
        if (m.includes('Full node not available') || m.includes('Payment method unavailable')) {
            err +=
                ' Your BTCPay Bitcoin node is not ready yet (still syncing or not running). In BTCPay: check Server → Services → Bitcoin, wait for sync, then try again. Testnet syncs much faster if you are still setting up.';
        }
        throw new Error(err);
    }
    return data;
}

/**
 * Collect raw body, verify signature, react to invoice payment events.
 * @param {{ secret: string, host: string, storeId: string, apiKey: string, onPaidOrder: (orderId: string, inv: object) => Promise<void> }} opts
 */
function createBtcpayWebhookListener(opts) {
    return async function btcpayWebhook(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks);
        const sig = req.headers['btcpay-sig'] || req.headers['BTCPAY-SIG'];
        if (!verifyWebhookSignature(raw, sig, opts.secret)) {
            res.writeHead(401).end('invalid signature');
            return;
        }

        let body;
        try {
            body = JSON.parse(raw.toString('utf8'));
        } catch {
            res.writeHead(400).end();
            return;
        }

        const type = body.type;
        const invoiceId = body.invoiceId || body.invoice?.id || body.data?.invoiceId;
        if (!invoiceId) {
            res.writeHead(200).end('ok');
            return;
        }

        // Any Invoice* event: re-fetch invoice (manual “mark settled” uses InvoiceSettled; some versions differ).
        if (!type || !String(type).startsWith('Invoice')) {
            res.writeHead(200).end('ok');
            return;
        }

        let inv;
        try {
            inv = await getInvoice(opts.host, opts.storeId, opts.apiKey, invoiceId);
        } catch (e) {
            console.error('BTCPay webhook: getInvoice failed', e.response?.data || e.message);
            res.writeHead(500).end();
            return;
        }

        const meta = inv.metadata || {};
        const orderId = meta.orderId || meta.order_id;
        if (!orderId || !invoiceIsPaidEnough(inv)) {
            res.writeHead(200).end('ok');
            return;
        }

        try {
            await opts.onPaidOrder(String(orderId), inv);
        } catch (e) {
            console.error('BTCPay webhook: onPaidOrder failed', e);
            res.writeHead(500).end();
            return;
        }
        res.writeHead(200).end('ok');
    };
}

module.exports = {
    normalizeHost,
    verifyWebhookSignature,
    invoiceIsPaidEnough,
    getInvoice,
    createInvoice,
    createBtcpayWebhookListener
};
