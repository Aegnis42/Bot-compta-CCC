import { PRODUCTS, CODES, SHEETS } from './config.js';
import * as gs from './sheets.js';
import { num, round2 } from './utils.js';

let prices = Object.fromEntries(PRODUCTS.map((p) => [p.code, { rachat: p.rachat, normal: p.normal, chatelerie: p.chatelerie }]));

/** Recharge les prix depuis l'onglet "Prix" (le Sheet fait foi). */
export async function loadPrices() {
  const rows = await gs.read(`${gs.q(SHEETS.PRIX)}!A2:E`, { unformatted: true });
  for (const r of rows) {
    const code = String(r[1] ?? '').trim().toUpperCase();
    if (!prices[code]) continue;
    prices[code] = {
      rachat: r[2] === undefined || r[2] === '' ? prices[code].rachat : num(r[2]),
      normal: r[3] === undefined || r[3] === '' ? prices[code].normal : num(r[3]),
      chatelerie: r[4] === undefined || r[4] === '' ? prices[code].chatelerie : num(r[4]),
    };
  }
  return prices;
}

export const getPrices = () => prices;

/** Valeur de rachat ; `bonus` = septimes ajoutés par unité (bonus du charbonnier). */
export const rachatValue = (qty, bonus = 0) => round2(CODES.reduce((s, c) => s + qty[c] * (prices[c].rachat + bonus), 0));

export const isChatelerie = (tarif) => /chat/i.test(String(tarif ?? ''));

export const venteValue = (qty, tarif) =>
  round2(CODES.reduce((s, c) => s + qty[c] * (isChatelerie(tarif) ? prices[c].chatelerie : prices[c].normal), 0));
