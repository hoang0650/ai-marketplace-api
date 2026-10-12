/**
 * Business-day arithmetic in Vietnam time (UTC+7). Saturdays and Sundays are skipped;
 * public holidays are NOT modelled (admins should treat Tết / holidays as an extension).
 */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function vnWeekday(ms) {
  return new Date(ms + VN_OFFSET_MS).getUTCDay(); // 0 = Sunday, 6 = Saturday
}

function addBusinessDays(from, days) {
  let ms = new Date(from).getTime();
  if (!Number.isFinite(ms)) return null;
  let left = Math.max(0, Math.floor(Number(days) || 0));
  while (left > 0) {
    ms += DAY_MS;
    const wd = vnWeekday(ms);
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return new Date(ms);
}

function addHours(from, hours) {
  const ms = new Date(from).getTime();
  return Number.isFinite(ms) ? new Date(ms + hours * 60 * 60 * 1000) : null;
}

function addDays(from, days) {
  const ms = new Date(from).getTime();
  return Number.isFinite(ms) ? new Date(ms + days * DAY_MS) : null;
}

module.exports = { addBusinessDays, addHours, addDays };
