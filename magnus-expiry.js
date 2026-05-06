/**
 * Magnus API vs customer copy:
 * - `expiryMidnightAfterPlan` = anchor local midnight + planDays + 1 → sent as `expirationdate` / matches Magnus `expiredays` quirks.
 * - `customerFacingPlanEndDate` = anchor local midnight + planDays → **last calendar day** of the purchased period for messages
 *   (e.g. 1-day plan bought on the 3rd → customer sees the 4th, not the 5th).
 * API: send DATE only `YYYY-MM-DD` — datetimes (with `T` or spaces) often break the signed POST and return HTTP 403.
 */

function pad2(n) {
    return String(n).padStart(2, '0');
}

function startOfLocalDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

/** Parse Magnus user.expirationdate (DATE or DATETIME). */
function parseMagnusExpiration(raw) {
    if (!raw || String(raw).startsWith('0000-00-00')) return null;
    const s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d, 0, 0, 0, 0);
    }
    const isoish = s.includes(' ') ? s.replace(' ', 'T') : s;
    const dt = new Date(isoish);
    return Number.isNaN(dt.getTime()) ? null : startOfLocalDay(dt);
}

/**
 * Expiry at 00:00:00 on the calendar day that is (planDays + 1) after the anchor's local calendar day.
 * Example: anchor May 3 local, planDays 1 → May 5 00:00:00 local.
 */
function expiryMidnightAfterPlan(anchorDate, planDays) {
    const n = Number(planDays);
    const days = Number.isFinite(n) && n > 0 ? n : 0;
    const a = startOfLocalDay(anchorDate);
    a.setDate(a.getDate() + days + 1);
    return a;
}

/** `expiredays` sent to Magnus (panel expects one extra day for correct access length). */
function magnusExpiredays(planDays) {
    const n = Number(planDays);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return n + 1;
}

/** Human / docs style: `2026-05-05 00:00:00` (always midnight). Prefer `formatCustomerPlanEndDateOnly` for customer Telegram copy. */
function formatExpiryDisplaySpace(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 00:00:00`;
}

/**
 * Last calendar day included in the plan (what we show customers).
 * Same anchor + planDays as “N-day” wording — not the internal Magnus cutoff date.
 */
function customerFacingPlanEndDate(anchorDate, planDays) {
    const n = Number(planDays);
    const days = Number.isFinite(n) && n > 0 ? n : 0;
    const a = startOfLocalDay(anchorDate);
    a.setDate(a.getDate() + days);
    return a;
}

/** `YYYY-MM-DD` for customer-facing “through end of this date” lines. */
function formatCustomerPlanEndDateOnly(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Magnus `expirationdate` on save — date only (avoids 403 on HMAC / form parsing). */
function formatExpirationDateOnlyForMagnusApi(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

module.exports = {
    startOfLocalDay,
    parseMagnusExpiration,
    expiryMidnightAfterPlan,
    magnusExpiredays,
    formatExpiryDisplaySpace,
    customerFacingPlanEndDate,
    formatCustomerPlanEndDateOnly,
    formatExpirationDateOnlyForMagnusApi
};
