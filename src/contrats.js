import { CODES, PRODUCTS, SHEETS } from './config.js';
import * as gs from './sheets.js';
import { toSheetSerial } from './time.js';
import { UserError, num, qtyFrom, emptyQty, hasQty, lastDataRow } from './utils.js';

const C = gs.q(SHEETS.CONTRATS);
const L = gs.q(SHEETS.LIVRAISONS);

// Contrats : A ID | B Date | C Client | D Tarif | E-H commandé | I-L livré | M-P reste
//            | Q Prix client | R Montant livré | S Statut | T Annulé | U Note | V Coût matériaux | W Bénéfice
//            | X-AA Prix perso par unité (CP, C, BC, CO ; vide = tarif) | AB Hebdomadaire (OUI = renouvelé chaque lundi)
function toContract(r, i) {
  return {
    row: i + 2,
    id: String(r[0] ?? '').trim(),
    date: r[1],
    client: String(r[2] ?? ''),
    tarif: String(r[3] ?? ''),
    cmd: qtyFrom(r, 4),
    livre: qtyFrom(r, 8),
    reste: qtyFrom(r, 12),
    montant: num(r[16]),
    montantLivre: num(r[17]),
    statut: String(r[18] ?? ''),
    note: String(r[20] ?? ''),
    cout: num(r[21]),
    benefice: num(r[22]),
    // Prix de vente personnalisé par unité, null si le tarif s'applique
    prixPerso: Object.fromEntries(CODES.map((c, k) => [c, num(r[23 + k]) > 0 ? num(r[23 + k]) : null])),
    hebdo: /^oui$/i.test(String(r[27] ?? '').trim()),
    hebdoInfo: String(r[27] ?? ''),
  };
}

export const isOpen = (ct) => ct.statut !== 'Livré' && ct.statut !== 'Annulé';

export async function listContracts() {
  const rows = await gs.read(`${C}!A2:AB`, { unformatted: true });
  return rows.map(toContract).filter((ct) => ct.id);
}

export async function getContract(id) {
  const key = String(id).trim().toUpperCase();
  return (await listContracts()).find((ct) => ct.id.toUpperCase() === key) ?? null;
}

/** Stock par code produit, lu dans l'onglet "Stock" (calculé par formules). */
export async function getStock() {
  const rows = await gs.read(`${gs.q(SHEETS.STOCK)}!A2:I${PRODUCTS.length + 1}`, { unformatted: true });
  const stock = {};
  for (const r of rows) {
    const code = String(r[1] ?? '').trim().toUpperCase();
    if (!CODES.includes(code)) continue;
    stock[code] = { depose: num(r[2]), ajust: num(r[3]), livre: num(r[4]), stock: num(r[5]), reste: num(r[6]), aProduire: num(r[7]), achete: num(r[8]) };
  }
  for (const code of CODES) stock[code] ??= { depose: 0, ajust: 0, livre: 0, stock: 0, reste: 0, aProduire: 0 };
  return stock;
}

export function createContract({ client, tarif, qty, prices = {}, note = '', hebdo = false }) {
  return gs.withLock(async () => {
    const rows = await gs.read(`${C}!A2:A`);
    const max = rows.reduce((m, r) => Math.max(m, Number(String(r[0] ?? '').match(/^CT-(\d+)$/i)?.[1] ?? 0)), 0);
    const id = `CT-${String(max + 1).padStart(3, '0')}`;
    const row = lastDataRow(rows, [0]) + 3;
    await gs.ensureRows(SHEETS.CONTRATS, row);
    await gs.writeMany([
      { range: `${C}!A${row}:H${row}`, values: [[id, toSheetSerial(), client, tarif, ...CODES.map((c) => qty[c] || '')]] },
      { range: `${C}!U${row}`, values: [[note]] },
      { range: `${C}!X${row}:AB${row}`, values: [[...CODES.map((c) => prices[c] || ''), hebdo ? 'OUI' : '']] },
    ]);
    return getContract(id);
  });
}

/**
 * Modifie les prix personnalisés d'un contrat. prices = { CP: 0.9, C: null, ... } :
 * un nombre > 0 fixe le prix, 0 le retire (retour au tarif), undefined ne change rien.
 */
export function setContractPrices(id, prices) {
  return gs.withLock(async () => {
    const ct = await getContract(id);
    if (!ct) throw new UserError(`Contrat **${id}** introuvable.`);
    if (ct.statut === 'Annulé') throw new UserError(`Le contrat **${ct.id}** est annulé.`);
    const values = CODES.map((c) => (prices[c] === undefined ? ct.prixPerso[c] ?? '' : prices[c] || ''));
    await gs.write(`${C}!X${ct.row}:AA${ct.row}`, [values]);
    return getContract(ct.id);
  });
}

/**
 * Livre un contrat à partir du stock.
 * requested = null → livre le maximum possible (reste du contrat, limité par le stock).
 * Renvoie { contract, delivered (null si rien n'a pu être livré), stock }.
 */
export function deliverContract(id, requested, author) {
  return gs.withLock(async () => {
    const ct = await getContract(id);
    if (!ct) throw new UserError(`Contrat **${id}** introuvable.`);
    if (ct.statut === 'Annulé') throw new UserError(`Le contrat **${ct.id}** est annulé.`);
    if (ct.statut === 'Livré') throw new UserError(`Le contrat **${ct.id}** est déjà entièrement livré.`);

    const stock = await getStock();
    const delivered = emptyQty();
    for (const code of CODES) {
      const reste = Math.max(0, ct.reste[code]);
      const want = requested ? Math.min(requested[code], reste) : reste;
      delivered[code] = Math.max(0, Math.min(want, Math.floor(stock[code].stock)));
    }
    if (!hasQty(delivered)) return { contract: ct, delivered: null, stock };

    const rows = await gs.read(`${L}!A2:B`);
    const row = lastDataRow(rows, [0, 1]) + 3;
    await gs.ensureRows(SHEETS.LIVRAISONS, row);
    await gs.writeMany([
      { range: `${L}!A${row}:F${row}`, values: [[toSheetSerial(), ct.id, ...CODES.map((c) => delivered[c] || '')]] },
      { range: `${L}!H${row}`, values: [[author]] },
    ]);
    return { contract: await getContract(ct.id), delivered, stock: await getStock() };
  });
}

export function cancelContract(id) {
  return gs.withLock(async () => {
    const ct = await getContract(id);
    if (!ct) throw new UserError(`Contrat **${id}** introuvable.`);
    await gs.write(`${C}!T${ct.row}`, [['OUI']]);
    return getContract(ct.id);
  });
}

/** Change la colonne « Hebdomadaire » d'un contrat (OUI, vide, ou texte de suivi). */
export function setContractWeekly(ct, value) {
  return gs.withLock(() => gs.write(`${C}!AB${ct.row}`, [[value]]));
}
