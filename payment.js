const axios = require('axios');
const { createInvoice, getInvoice, invoiceIsPaidEnough } = require('./btcpay-client');

/**
 * Bitcoin Payment Handler
 * - manual: static BTC_ADDRESS + CoinGecko amount (honor system / manual confirm)
 * - blockonomics: per-order address
 * - btcpay: BTCPay Server Greenfield invoices + optional webhooks
 */
class PaymentHandler {
    constructor() {
        this.provider = (process.env.PAYMENT_PROVIDER || 'manual').toLowerCase();
        this.blockonomicsKey = process.env.BLOCKONOMICS_API_KEY;
        this.btcAddress = process.env.BTC_ADDRESS;
        this.btcPriceApi = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';

        this.btcpayHost = process.env.BTCPAY_HOST;
        this.btcpayStoreId = process.env.BTCPAY_STORE_ID;
        this.btcpayApiKey = process.env.BTCPAY_API_KEY;
    }

    isBtcpay() {
        return this.provider === 'btcpay';
    }

    /**
     * Get current BTC/USD exchange rate
     */
    async getBtcPrice() {
        try {
            const response = await axios.get(this.btcPriceApi, { timeout: 10000 });
            return response.data.bitcoin.usd;
        } catch (error) {
            console.error('Failed to fetch BTC price:', error.message);
            return 65000;
        }
    }

    /**
     * Calculate BTC amount for USD price
     */
    async calculateBtcAmount(usdAmount) {
        const btcPrice = await this.getBtcPrice();
        const btcAmount = (usdAmount / btcPrice).toFixed(8);
        return {
            btcAmount,
            btcPrice,
            usdAmount
        };
    }

    /** When BTCPay cannot create an invoice (e.g. node still syncing), use static BTC_ADDRESS if set. */
    _btcpayErrorAllowsManualFallback(err) {
        const m = String(err?.message || err || '');
        return /Full node not available|Payment method unavailable|matching payment method|BTC-CHAIN/i.test(
            m
        );
    }

    /**
     * Manual / blockonomics payment row (not BTCPay hosted checkout).
     * @param {{ manualFallback?: boolean }} opts
     */
    async _generateManualPayment(orderId, usdAmount, opts = {}) {
        const { btcAmount, btcPrice } = await this.calculateBtcAmount(usdAmount);
        let paymentAddress;
        if (this.provider === 'blockonomics' && this.blockonomicsKey) {
            paymentAddress = await this.generateBlockonomicsAddress(orderId);
        } else {
            paymentAddress = this.btcAddress;
        }
        return {
            orderId,
            btcAmount,
            btcPrice,
            usdAmount,
            paymentAddress,
            checkoutLink: null,
            invoiceId: null,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            qrData: `bitcoin:${paymentAddress}?amount=${btcAmount}&message=Order${orderId}`,
            manualFallback: !!opts.manualFallback
        };
    }

    /**
     * Generate payment details for an order
     */
    async generatePayment(orderId, usdAmount) {
        if (this.isBtcpay()) {
            try {
                const inv = await createInvoice(this.btcpayHost, this.btcpayStoreId, this.btcpayApiKey, {
                    amountUsd: usdAmount,
                    orderId,
                    description: `Magnus order #${orderId}`
                });
                const rawExp = inv.expirationTime != null ? Number(inv.expirationTime) : null;
                const expMs =
                    rawExp != null
                        ? rawExp < 1e12
                            ? rawExp * 1000
                            : rawExp
                        : Date.now() + 3600000;
                return {
                    orderId,
                    btcAmount: null,
                    btcPrice: null,
                    usdAmount,
                    paymentAddress: inv.checkoutLink,
                    checkoutLink: inv.checkoutLink,
                    invoiceId: inv.id,
                    expiresAt: new Date(expMs).toISOString(),
                    qrData: inv.checkoutLink,
                    manualFallback: false
                };
            } catch (e) {
                if (this.btcAddress && this._btcpayErrorAllowsManualFallback(e)) {
                    console.warn('BTCPay invoice failed; using manual BTC (BTC_ADDRESS) fallback:', e.message);
                    return this._generateManualPayment(orderId, usdAmount, { manualFallback: true });
                }
                throw e;
            }
        }

        return this._generateManualPayment(orderId, usdAmount, {});
    }

    async generateBlockonomicsAddress(orderId) {
        try {
            const response = await axios.post(
                'https://www.blockonomics.co/api/new_address',
                {},
                {
                    headers: {
                        Authorization: `Bearer ${this.blockonomicsKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );
            return response.data.address;
        } catch (error) {
            console.error('Blockonomics error:', error.message);
            return this.btcAddress;
        }
    }

    async verifyPayment(orderId, txHash) {
        return {
            status: 'pending',
            confirmations: 0,
            message: 'Payment verification requires admin confirmation'
        };
    }

    /** True if BTCPay invoice is paid / settled enough to fulfill (poll or after webhook). */
    async isBtcpayInvoicePaid(invoiceId) {
        if (!invoiceId || !this.isBtcpay()) return false;
        try {
            const inv = await getInvoice(this.btcpayHost, this.btcpayStoreId, this.btcpayApiKey, invoiceId);
            return invoiceIsPaidEnough(inv);
        } catch (e) {
            console.error('BTCPay getInvoice:', e.response?.data || e.message);
            return false;
        }
    }

    isConfigured() {
        if (this.provider === 'manual') {
            return !!this.btcAddress;
        }
        if (this.provider === 'blockonomics') {
            return !!this.blockonomicsKey;
        }
        if (this.provider === 'btcpay') {
            return !!(this.btcpayHost && this.btcpayStoreId && this.btcpayApiKey);
        }
        return false;
    }
}

module.exports = { PaymentHandler };
