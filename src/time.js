import { env } from './config.js';

function localParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: env.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second };
}

/** Date/heure locale au format "numéro de série" de Google Sheets. */
export function toSheetSerial(date = new Date()) {
  const p = localParts(date);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) / 86400000 + 25569;
}

function isoWeekFromYMD(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
}

/** Semaine ISO au format "2026-S40" (identique à la formule du Sheet). */
export function weekLabel(date = new Date()) {
  const p = localParts(date);
  return isoWeekFromYMD(p.y, p.m, p.d);
}

export function weekOfSerial(serial) {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return isoWeekFromYMD(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export const previousWeekLabel = () => weekLabel(new Date(Date.now() - 7 * 86400000));

/** Accepte "2026-S40", "2026-40", "S40" ou "40". Renvoie null si invalide. */
export function normalizeWeek(input) {
  if (!input) return weekLabel();
  const s = String(input).trim().toUpperCase();
  let m = s.match(/^(\d{4})\s*-?\s*S?\s*(\d{1,2})$/);
  if (m) return `${m[1]}-S${m[2].padStart(2, '0')}`;
  m = s.match(/^S?\s*(\d{1,2})$/);
  if (m) return `${weekLabel().slice(0, 4)}-S${m[1].padStart(2, '0')}`;
  return null;
}
