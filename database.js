const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'orders.db');

class Database {
    constructor() {
        this.db = new sqlite3.Database(DB_PATH);
        this.init();
    }

    init() {
        this.db.serialize(() => {
            // Orders table
            this.db.run(`
                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_id TEXT NOT NULL,
                    telegram_username TEXT,
                    order_type TEXT NOT NULL,
                    plan_key TEXT NOT NULL,
                    plan_name TEXT NOT NULL,
                    price_usd REAL NOT NULL,
                    btc_amount REAL,
                    btc_address TEXT,
                    tx_hash TEXT,
                    status TEXT DEFAULT 'pending',
                    magnus_username TEXT,
                    magnus_password TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    paid_at DATETIME,
                    confirmed_by TEXT,
                    notes TEXT
                )
            `);

            // Admin users table
            this.db.run(`
                CREATE TABLE IF NOT EXISTS admins (
                    telegram_id TEXT PRIMARY KEY,
                    username TEXT,
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    added_by TEXT
                )
            `);

            // Payment confirmations table
            this.db.run(`
                CREATE TABLE IF NOT EXISTS payment_confirmations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    admin_id TEXT NOT NULL,
                    confirmed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id)
                )
            `);

            this.db.run(
                'ALTER TABLE orders ADD COLUMN btcpay_invoice_id TEXT',
                (err) => {
                    if (err && !String(err.message).includes('duplicate column')) {
                        console.error('orders migration:', err.message);
                    }
                }
            );

            this.db.run(
                'ALTER TABLE orders ADD COLUMN replace_previous_username TEXT',
                (err) => {
                    if (err && !String(err.message).includes('duplicate column')) {
                        console.error('orders migration:', err.message);
                    }
                }
            );

            this.db.run(
                'ALTER TABLE orders ADD COLUMN invoice_expires_at TEXT',
                (err) => {
                    if (err && !String(err.message).includes('duplicate column')) {
                        console.error('orders migration:', err.message);
                    }
                }
            );

            this.db.run(
                'ALTER TABLE orders ADD COLUMN invoice_reminder_sent_at TEXT',
                (err) => {
                    if (err && !String(err.message).includes('duplicate column')) {
                        console.error('orders migration:', err.message);
                    }
                }
            );

            this.db.run(`
                CREATE TABLE IF NOT EXISTS dashboard_sessions (
                    token TEXT PRIMARY KEY,
                    telegram_id TEXT NOT NULL,
                    order_id INTEGER,
                    magnus_username TEXT NOT NULL,
                    magnus_password TEXT,
                    sip_host TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    expires_at DATETIME NOT NULL
                )
            `);
        });
    }

    createDashboardSession({ telegram_id, order_id, magnus_username, magnus_password, sip_host, ttlDays = 7 }) {
        const token = crypto.randomBytes(24).toString('hex');
        const expires = new Date(Date.now() + ttlDays * 86400000).toISOString();
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO dashboard_sessions (token, telegram_id, order_id, magnus_username, magnus_password, sip_host, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [token, telegram_id, order_id ?? null, magnus_username, magnus_password ?? null, sip_host, expires],
                (err) => {
                    if (err) reject(err);
                    else resolve(token);
                }
            );
        });
    }

    getDashboardSession(token) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM dashboard_sessions WHERE token = ? AND datetime(expires_at) > datetime('now')`,
                [token],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    /** Latest paid order where we stored the generated password (new signups). */
    getLatestOrderWithStoredPassword(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM orders
                 WHERE telegram_id = ? AND status = 'paid' AND magnus_password IS NOT NULL AND magnus_password != ''
                 ORDER BY datetime(COALESCE(paid_at, created_at)) DESC LIMIT 1`,
                [telegramId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    /** Latest paid order for this Telegram user (any type — used for View account after purchase). */
    getLatestPaidOrderForTelegram(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM orders
                 WHERE telegram_id = ? AND status = 'paid'
                 ORDER BY datetime(COALESCE(paid_at, created_at)) DESC LIMIT 1`,
                [telegramId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    // Order operations
    createOrder(orderData) {
        return new Promise((resolve, reject) => {
            const {
                telegram_id, telegram_username, order_type,
                plan_key, plan_name, price_usd, btc_amount,
                btc_address, magnus_username, magnus_password,
                replace_previous_username
            } = orderData;

            this.db.run(
                `INSERT INTO orders (telegram_id, telegram_username, order_type, plan_key, plan_name, price_usd, btc_amount, btc_address, magnus_username, magnus_password, replace_previous_username)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    telegram_id,
                    telegram_username,
                    order_type,
                    plan_key,
                    plan_name,
                    price_usd,
                    btc_amount,
                    btc_address,
                    magnus_username,
                    magnus_password,
                    replace_previous_username ?? null
                ],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getOrder(orderId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM orders WHERE id = ?', [orderId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    updateOrder(orderId, fields) {
        const allowed = [
            'status',
            'magnus_username',
            'magnus_password',
            'tx_hash',
            'notes',
            'paid_at',
            'btc_amount',
            'btc_address',
            'btcpay_invoice_id',
            'invoice_expires_at',
            'invoice_reminder_sent_at'
        ];
        const keys = Object.keys(fields).filter((k) => allowed.includes(k));
        if (keys.length === 0) return Promise.resolve(0);
        const setClause = keys.map((k) => `${k} = ?`).join(', ');
        const values = keys.map((k) => fields[k]);
        values.push(orderId);
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE orders SET ${setClause} WHERE id = ?`,
                values,
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    getPendingOrders() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT * FROM orders WHERE status = "pending" ORDER BY created_at DESC', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    /** Latest unpaid BTCPay checkout for this Telegram user (for “paid” after session reset). */
    getLatestPendingBtcpayOrderForTelegram(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM orders
                 WHERE telegram_id = ? AND status = 'pending'
                   AND btcpay_invoice_id IS NOT NULL AND TRIM(btcpay_invoice_id) != ''
                 ORDER BY datetime(created_at) DESC LIMIT 1`,
                [telegramId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    getUserOrders(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT * FROM orders WHERE telegram_id = ? ORDER BY created_at DESC', [telegramId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    /** Pending BTCPay orders that have a stored invoice expiry (for reminder job). */
    getPendingOrdersWithInvoiceExpiry() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM orders
                 WHERE status = 'pending'
                   AND btcpay_invoice_id IS NOT NULL AND TRIM(btcpay_invoice_id) != ''
                   AND invoice_expires_at IS NOT NULL AND TRIM(invoice_expires_at) != ''`,
                [],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    confirmPayment(orderId, adminId) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('UPDATE orders SET status = "paid", paid_at = CURRENT_TIMESTAMP, confirmed_by = ? WHERE id = ?', [adminId, orderId]);
                this.db.run('INSERT INTO payment_confirmations (order_id, admin_id) VALUES (?, ?)', [orderId, adminId], function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
            });
        });
    }

    cancelOrder(orderId) {
        return new Promise((resolve, reject) => {
            this.db.run('UPDATE orders SET status = "cancelled" WHERE id = ?', [orderId], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    // Admin operations
    addAdmin(telegramId, username, addedBy) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR IGNORE INTO admins (telegram_id, username, added_by) VALUES (?, ?, ?)',
                [telegramId, username, addedBy],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    isAdmin(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT 1 FROM admins WHERE telegram_id = ?', [telegramId], (err, row) => {
                if (err) reject(err);
                else resolve(!!row);
            });
        });
    }

    getAdmins() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT * FROM admins ORDER BY added_at DESC', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    removeAdmin(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM admins WHERE telegram_id = ?', [telegramId], function(err) {
                if (err) reject(err);
                else resolve(this.changes > 0);
            });
        });
    }

    // Stats
    getStats() {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT 
                    COUNT(*) as total_orders,
                    SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_orders,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_orders,
                    SUM(CASE WHEN status = 'paid' THEN price_usd ELSE 0 END) as total_revenue
                FROM orders
            `, [], (err, row) => {
                if (err) reject(err);
                else resolve(row?.[0] || {});
            });
        });
    }
}

module.exports = { Database };
