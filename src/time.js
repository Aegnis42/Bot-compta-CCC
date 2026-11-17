import { env, SEMAINE } from './config.js';

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

const DAY = 86400000;
const TRANSITION = Date.UTC(SEMAINE.transition[0], SEMAINE.transition[1] - 1, SEMAINE.transition[2]); // lundi 16/11/2026
const DIMANCHE = Date.UTC(SEMAINE.dimanche[0], SEMAINE.dimanche[1] - 1, SEMAINE.dimanche[2]); // dimanche 22/11/2026

/**
 * Début et fin (inclus) de la semaine contenant le jour `t` (minuit UTC du jour local) :
 * avant la transition du lundi au dimanche, puis une semaine de transition (lundi 16 → samedi 21/11/2026),
 * puis du dimanche au samedi. Mêmes règles que les formules du Sheet (setup.js : weekStartFormula).
 */
function boundsOfDay(t) {
  const dow = new Date(t).getUTCDay(); // 0 = dimanche
  if (t < TRANSITION) {
    const start = t - ((dow + 6) % 7) * DAY;
    return { start, end: start + 6 * DAY };
  }
  if (t < DIMANCHE) return { start: TRANSITION, end: DIMANCHE - DAY };
  const start = t - dow * DAY;
  return { start, end: start + 6 * DAY };
}

const labelOf = ({ start, end }) => `${ddmmyyyy(new Date(start))} au ${ddmmyyyy(new Date(end))}`;
const weekFromYMD = (y, m, d) => labelOf(boundsOfDay(Date.UTC(y, m - 1, d)));

/** Semaine contenant ce jour, au format "16/11/2026 au 21/11/2026" (identique à la formule du Sheet). */
export function weekLabel(date = new Date()) {
  const p = localParts(date);
  return weekFromYMD(p.y, p.m, p.d);
}

export function weekOfSerial(serial) {
  const d = new Date(Math.floor(serial - 25569) * DAY);
  return weekFromYMD(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Semaine contenant `serial` (numéro de série Sheets) : premier jour et premier jour de la semaine suivante. */
export function weekBoundsSerial(serial) {
  const { start, end } = boundsOfDay(Math.floor(serial - 25569) * DAY);
  return { start: start / DAY + 25569, next: end / DAY + 25569 + 1 };
}

/** Jour de la semaine (0 = dimanche) et heure locale. */
export function localClock(date = new Date()) {
  const p = localParts(date);
  return { weekday: new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(), hour: p.h };
}

/** Semaine précédente : celle du jour qui précède le début de la semaine en cours (les semaines n'ont pas toutes 7 jours). */
export function previousWeekLabel() {
  const { start } = weekBoundsSerial(toSheetSerial());
  return weekOfSerial(start - 1);
}

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

/**
 * Deux libellés désignent-ils la même semaine ? On compare la date de début : lors du passage aux semaines
 * du dimanche au samedi, « 16/11/2026 au 22/11/2026 » (ancien calcul) et « 16/11/2026 au 21/11/2026 » sont la même.
 */
export const sameWeek = (a, b) => Boolean(a && b) && String(a).split(' au ')[0] === String(b).split(' au ')[0];
