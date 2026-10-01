import { CODES } from './config.js';

/** Erreur dont le message peut être montré tel quel à l'utilisateur Discord. */
export class UserError extends Error {}

export function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const emptyQty = () => Object.fromEntries(CODES.map((c) => [c, 0]));

/** Lit 4 quantités consécutives (CP, C, BC, CO) à partir de l'index `start` d'une ligne. */
export const qtyFrom = (row, start) => Object.fromEntries(CODES.map((c, i) => [c, num(row?.[start + i])]));

export const hasQty = (qty) => CODES.some((c) => qty[c] !== 0);

export function addQty(a, b) {
  for (const c of CODES) a[c] += b[c];
  return a;
}

/** Index (0-based) de la dernière ligne ayant une valeur dans l'une des colonnes `cols`, -1 si aucune. */
export function lastDataRow(rows, cols) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (cols.some((c) => rows[i]?.[c] !== undefined && rows[i][c] !== '')) return i;
  }
  return -1;
}

export const newRef = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36 ** 2).toString(36).toUpperCase()}`;
