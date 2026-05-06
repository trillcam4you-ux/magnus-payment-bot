const axios = require('axios');
const crypto = require('crypto');

class MagnusBillingAPI {
    constructor(apiKey, apiSecret, publicUrl) {
        this.api_key = apiKey;
        this.api_secret = apiSecret;
        this.public_url = publicUrl;
    }

    async query(req = {}) {
        const module = req.module || null;
        const action = req.action || null;

        // Generate nonce exactly like Python does
        const now = Date.now();
        const micro = process.hrtime()[1].toString().padStart(9, '0').substring(0, 6);
        req.nonce = now.toString() + micro;

        // Build post data (NO URL encoding for values - this is the key!)
        const postData = Object.entries(req)
            .map(([k, v]) => `${k}=${v}`)
            .join('&');
        
        // HMAC with secret as key
        const sign = crypto.createHmac('sha512', this.api_secret)
            .update(Buffer.from(postData))
            .digest('hex');

        try {
            const url = `${this.public_url}/index.php/${module}/${action}`;
            const response = await axios.post(url, postData, {
                headers: {
                    'Key': this.api_key,
                    'Sign': sign,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/4.0 (compatible; MagnusBilling Node.js bot)'
                },
                timeout: 15000,
                // Magnus often returns 403 HTML for disallowed modules; don't throw so callers can handle { success: false }
                validateStatus: () => true
            });

            const data = response.data;
            if (response.status >= 400) {
                console.error('API HTTP', response.status, module, action);
                if (typeof data === 'string') {
                    console.error('Response:', data.substring(0, 200));
                    return { success: false, errors: [`HTTP ${response.status}`] };
                }
                return typeof data === 'object' && data !== null
                    ? data
                    : { success: false, errors: [`HTTP ${response.status}`] };
            }

            return data;
        } catch (error) {
            console.error('API Error:', error.response?.status);
            console.error('Response:', error.response?.data?.substring?.(0, 200));
            throw error;
        }
    }

    async read(module, page = 1, filter = []) {
        const req = {
            module,
            action: 'read',
            nonce: Date.now().toString()
        };
        
        // Only add pagination/filter if not page 1 or filter exists
        if (page !== 1) {
            req.page = page;
            req.start = (page - 1) * 25;
            req.limit = 25;
        }
        
        if (filter && filter.length > 0) {
            req.filter = JSON.stringify(filter);
        }
        
        return this.query(req);
    }

    async create(module, data = {}) {
        data.module = module;
        data.action = 'save';
        data.id = 0;
        return this.query(data);
    }

    async update(module, id, data) {
        data.module = module;
        data.action = 'save';
        data.id = id;
        return this.query(data);
    }

    async destroy(module, id) {
        return this.query({
            module,
            action: 'destroy',
            id
        });
    }

    /**
     * Find a user by SIP/Magnus username (not limited to the first API page).
     */
    async getUserByUsername(username) {
        if (username === undefined || username === null) return null;
        const want = String(username).trim();
        if (!want) return null;

        const matchRow = (rows) =>
            rows?.find((u) => u && String(u.username) === want) ||
            rows?.find((u) => u && String(u.username).toLowerCase() === want.toLowerCase()) ||
            null;

        const filterAttempts = [
            [{ property: 'username', value: want, operator: 'eq' }],
            [{ property: 'username', value: want, operator: 'like' }],
            [{ field: 'username', value: want, comparison: 'eq' }]
        ];

        for (const filter of filterAttempts) {
            const result = await this.read('user', 1, filter);
            const hit = matchRow(result.rows);
            if (hit) return hit;
        }

        let page = 1;
        for (;;) {
            const result = await this.read('user', page);
            const hit = matchRow(result.rows);
            if (hit) return hit;
            const rows = result.rows || [];
            if (rows.length < 25) return null;
            page += 1;
            if (page > 400) return null;
        }
    }

    /**
     * SIP row for a Magnus user id (paginates if not on first page).
     */
    async getSipByUserId(userId) {
        const id = Number(userId);
        if (!Number.isFinite(id)) return null;

        const matchRow = (rows) => rows?.find((s) => s && Number(s.id_user) === id) || null;

        const filterAttempts = [
            [{ property: 'id_user', value: id, operator: 'eq' }],
            [{ field: 'id_user', value: id, comparison: 'eq' }]
        ];

        for (const filter of filterAttempts) {
            const result = await this.read('sip', 1, filter);
            const hit = matchRow(result.rows);
            if (hit) return hit;
        }

        let page = 1;
        for (;;) {
            const result = await this.read('sip', page);
            const hit = matchRow(result.rows);
            if (hit) return hit;
            const rows = result.rows || [];
            if (rows.length < 25) return null;
            page += 1;
            if (page > 400) return null;
        }
    }
}

module.exports = { MagnusBillingAPI };
