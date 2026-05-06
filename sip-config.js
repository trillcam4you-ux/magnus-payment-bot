/**
 * SIP registrar / dashboard URL helpers (reads env after dotenv is loaded in bot or dashboard-server).
 */

function getSipServerHost() {
    const explicit = (process.env.SIP_SERVER_HOST || '').trim();
    if (explicit) return explicit;
    const u = process.env.MAGNUS_URL || '';
    try {
        const host = new URL(u).hostname;
        return host || '172.235.137.54';
    } catch {
        return '172.235.137.54';
    }
}

/**
 * Public base URL for the credential portal (no trailing slash).
 * Defaults to MAGNUS_URL origin + path (e.g. http://172.235.137.54/mbilling) so links match your billing site.
 * Override with DASHBOARD_PUBLIC_URL if the portal is mounted elsewhere.
 */
function getDashboardPublicBaseUrl() {
    const explicit = (process.env.DASHBOARD_PUBLIC_URL || '').trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    const u = (process.env.MAGNUS_URL || '').trim();
    if (!u) return null;
    try {
        const parsed = new URL(u);
        const path = parsed.pathname.replace(/\/+$/, '') || '';
        return `${parsed.origin}${path}` || null;
    } catch {
        return null;
    }
}

/** Public billing portal URL for Telegram — always ends with `/` (e.g. `http://host/mbilling/). */
function getDashboardPortalDisplayUrl() {
    const base = getDashboardPublicBaseUrl();
    if (!base) return null;
    return base.endsWith('/') ? base : `${base}/`;
}

module.exports = { getSipServerHost, getDashboardPublicBaseUrl, getDashboardPortalDisplayUrl };
