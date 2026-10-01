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

const ddmmyyyy = (dt) =>
  `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;

/** Semaine (lundi → dimanche) contenant ce jour, au format "28/09/2026 au 04/10/2026" (identique à la formule du Sheet). */
function weekFromYMD(y, m, d) {
  const monday = new Date(Date.UTC(y, m - 1, d));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() || 7) - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return `${ddmmyyyy(monday)} au ${ddmmyyyy(sunday)}`;
}

export function weekLabel(date = new Date()) {
  const p = localParts(date);
  return weekFromYMD(p.y, p.m, p.d);
}

export function weekOfSerial(serial) {
  const d = new Date(Math.floor(serial - 25569) * 86400000);
  return weekFromYMD(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export const previousWeekLabel = () => weekLabel(new Date(Date.now() - 7 * 86400000));

/**
 * Semaine choisie par l'utilisateur : n'importe quel jour de la semaine ("29/09", "29/09/2026", "29-09-26"),
 * "derniere" pour la semaine précédente, ou vide pour la semaine en cours. Renvoie null si invalide.
 */
export function normalizeWeek(input) {
  if (!input || !String(input).trim()) return weekLabel();
  const s = String(input).trim().toLowerCase();
  if (/^(derni[eè]re|pr[eé]c[eé]dente)$/.test(s)) return previousWeekLabel();
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?(?:\s*au\s.*)?$/);
  if (!m) return null;
  const day = +m[1];
  const month = +m[2];
  let year = m[3] ? +m[3] : localParts().y;
  if (year < 100) year += 2000;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return weekFromYMD(year, month, day);
}
