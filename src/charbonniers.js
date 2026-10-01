import { env, PRODUCTS, SHEETS } from './config.js';
import * as gs from './sheets.js';
import { COLS, SALAIRES_FIRST_ROW, weekFormula, salairesHeader } from './setup.js';
import { toSheetSerial, weekOfSerial } from './time.js';
import { UserError, num, qtyFrom, emptyQty, addQty, lastDataRow, newRef, round2 } from './utils.js';

// Colonnes d'un onglet charbonnier :
// A Date | B Semaine (formule) | C CP | D C | E BC | F CO | G Montant (formule) | H Source | I Réf | J Note
export const IDX = { date: 0, week: 1, qty: 2, montant: 6, source: 7, ref: 8, note: 9 };

const RESERVED = Object.values(SHEETS).map((s) => s.toLowerCase());
const NAME_RE = /^\p{L}[\p{L}\p{N} _'.-]{0,29}$/u;

let registry = [];

export const allCharbonniers = () => registry;
export const activeCharbonniers = () => registry.filter((c) => c.actif);
export const findByChannel = (id) => registry.find((c) => c.actif && c.channelId === id);
export const findByUser = (id) => registry.find((c) => c.actif && c.discordId === id);
export const findByName = (name) => registry.find((c) => c.name.toLowerCase() === String(name).trim().toLowerCase());

export function validateName(name) {
  if (!NAME_RE.test(name)) {
    throw new UserError(`Nom invalide : « ${name} ». Utilise uniquement lettres, chiffres, espaces, - _ ' . (30 caractères max, commence par une lettre).`);
  }
  if (RESERVED.includes(name.toLowerCase())) throw new UserError(`« ${name} » est un nom d'onglet réservé.`);
}

/** Relit l'onglet "Charbonniers". */
export async function loadRegistry() {
  const rows = await gs.read(`${gs.q(SHEETS.CHARBONNIERS)}!A2:F`);
  registry = rows
    .map((r, i) => ({
      name: String(r[0] ?? '').trim(),
      discordId: String(r[1] ?? '').trim(),
      channelId: String(r[2] ?? '').trim(),
      tab: String(r[3] ?? '').trim() || String(r[0] ?? '').trim(),
      actif: !/^(non|no|false|0)$/i.test(String(r[4] ?? 'OUI').trim()),
      row: i + 2,
    }))
    .filter((c) => c.name);
  return registry;
}

function tabHeader() {
  const P = gs.q(SHEETS.PRIX);
  const [c1, c2, c3, c4] = COLS.depot;
  const week = `={"Semaine";ARRAYFORMULA(IF(A2:A="","",IFERROR(${weekFormula('A2:A')},"?")))}`;
  const sum = COLS.depot.map((col, i) => `${col}2:${col}*${P}!$C$${i + 2}`).join('+');
  const montant = `={"Montant (${env.currency})";ARRAYFORMULA(IF(LEN(A2:A&${c1}2:${c1}&${c2}2:${c2}&${c3}2:${c3}&${c4}2:${c4})=0,"",IFERROR(ROUND(${sum},2),"?")))}`;
  return ['Date', week, ...PRODUCTS.map((p) => p.code), montant, 'Source', 'Réf', 'Note'];
}

/** Crée l'onglet d'un charbonnier s'il n'existe pas. */
export async function ensureTab(title) {
  const meta = await gs.getMeta(true);
  if (meta.sheets.has(title)) return false;
  const res = await gs.batchUpdate([{ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: 10, frozenRowCount: 1 } } } }]);
  const sheetId = res.replies[0].addSheet.properties.sheetId;
  await gs.write(`${gs.q(title)}!A1:J1`, [tabHeader()], false);
  await gs.batchUpdate([gs.headerFormat(sheetId), gs.columnFormat(sheetId, 0, gs.DATE_TIME)]);
  await gs.getMeta(true);
  return true;
}

/**
 * Réécrit les formules qui dépendent de la liste des charbonniers :
 * - onglet "Salaires" (une ligne par charbonnier)
 * - colonne "Déposé" de l'onglet "Stock"
 */
export async function rebuildFormulas() {
  const meta = await gs.getMeta(true);
  const list = registry.filter((c) => meta.sheets.has(c.tab));
  const S = gs.q(SHEETS.SALAIRES);
  const first = SALAIRES_FIRST_ROW;

  const rows = list.map((c) => {
    const t = gs.q(c.tab);
    return [
      c.name,
      ...COLS.depot.map((col) => `=SUMIF(${t}!$B:$B,$B$2,${t}!${col}:${col})`),
      `=SUMIF(${t}!$B:$B,$B$2,${t}!$G:$G)`,
      c.actif ? 'Actif' : 'Inactif',
    ];
  });
  const last = first + rows.length - 1;
  const total = rows.length
    ? ['TOTAL', ...['B', 'C', 'D', 'E', 'F'].map((col) => `=SUM(${col}${first}:${col}${last})`), '']
    : ['TOTAL', 0, 0, 0, 0, 0, ''];

  // Formules de semaine (remises à jour à chaque fois : corrige les onglets créés avec un ancien format)
  await gs.writeMany([
    ...list.map((c) => ({ range: `${gs.q(c.tab)}!B1`, values: [[tabHeader()[1]]] })),
    ...Object.entries(salairesHeader()).map(([cell, values]) => ({ range: `${S}!${cell}`, values })),
  ], false);

  await gs.clear(`${S}!A${first}:G`);
  await gs.write(`${S}!A${first}:G${first + rows.length}`, [...rows, total], false);

  const stock = COLS.depot.map((col) => [
    list.length ? `=${list.map((c) => `SUM(${gs.q(c.tab)}!${col}2:${col})`).join('+')}` : 0,
  ]);
  await gs.write(`${gs.q(SHEETS.STOCK)}!C2:C${PRODUCTS.length + 1}`, stock, false);
}

export function addCharbonnier({ name, discordId, channelId }) {
  return gs.withLock(async () => {
    validateName(name);
    await loadRegistry();
    const sameUser = findByUser(discordId);
    if (sameUser) throw new UserError(`<@${discordId}> est déjà enregistré comme charbonnier (**${sameUser.name}**).`);
    const existing = findByName(name);
    if (existing?.actif) throw new UserError(`Un charbonnier nommé **${name}** existe déjà.`);

    const R = gs.q(SHEETS.CHARBONNIERS);
    if (existing) {
      // Réactivation d'un ancien charbonnier : on garde son onglet et son historique
      await gs.write(`${R}!B${existing.row}:E${existing.row}`, [[discordId, channelId, existing.tab, 'OUI']]);
      await ensureTab(existing.tab);
    } else {
      await ensureTab(name);
      const row = registry.reduce((m, c) => Math.max(m, c.row), 1) + 1;
      await gs.ensureRows(SHEETS.CHARBONNIERS, row);
      await gs.write(`${R}!A${row}:F${row}`, [[name, discordId, channelId, name, 'OUI', toSheetSerial()]]);
    }
    await loadRegistry();
    await rebuildFormulas();
    return findByUser(discordId);
  });
}

export function deactivateCharbonnier(c) {
  return gs.withLock(async () => {
    await gs.write(`${gs.q(SHEETS.CHARBONNIERS)}!E${c.row}`, [['NON']]);
    await loadRegistry();
    await rebuildFormulas();
  });
}

const tabRange = (c) => `${gs.q(c.tab)}!A2:J`;

/** Enregistre un dépôt dans l'onglet du charbonnier. */
export function recordDeposit(c, qty, { source = 'Discord', note = '' } = {}) {
  return gs.withLock(async () => {
    const rows = await gs.read(tabRange(c), { unformatted: true });
    const row = lastDataRow(rows, [IDX.date, 2, 3, 4, 5, IDX.ref]) + 3;
    await gs.ensureRows(c.tab, row);
    const ref = newRef('D');
    const serial = toSheetSerial();
    const t = gs.q(c.tab);
    await gs.writeMany([
      { range: `${t}!A${row}`, values: [[serial]] },
      { range: `${t}!C${row}:F${row}`, values: [PRODUCTS.map((p) => qty[p.code] || '')] },
      { range: `${t}!H${row}:J${row}`, values: [[source, ref, String(note).slice(0, 300)]] },
    ]);
    return { row, ref, serial, week: weekOfSerial(serial) };
  });
}

/** Supprime un dépôt (par réf, sinon le dernier dépôt fait depuis Discord). */
export function deleteDeposit(c, ref) {
  return gs.withLock(async () => {
    const rows = await gs.read(tabRange(c), { unformatted: true });
    const idx = ref
      ? rows.findIndex((r) => String(r[IDX.ref] ?? '').toUpperCase() === ref.trim().toUpperCase())
      : rows.findLastIndex((r) => r[IDX.source] === 'Discord' && r[IDX.ref]);
    if (idx === -1) throw new UserError(ref ? `Aucun dépôt avec la réf **${ref}**.` : 'Aucun dépôt fait via Discord à annuler.');
    const r = rows[idx];
    const { sheetId } = await gs.sheetProps(c.tab);
    await gs.batchUpdate([{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: idx + 1, endIndex: idx + 2 } } }]);
    return { ref: r[IDX.ref], qty: qtyFrom(r, IDX.qty), week: r[IDX.week], montant: num(r[IDX.montant]) };
  });
}

export function summarize(rows, week) {
  const res = { qty: emptyQty(), montant: 0, count: 0 };
  for (const r of rows) {
    if (r[IDX.week] !== week) continue;
    addQty(res.qty, qtyFrom(r, IDX.qty));
    res.montant += num(r[IDX.montant]);
    res.count++;
  }
  res.montant = round2(res.montant);
  return res;
}

export async function readTabs(list) {
  const meta = await gs.getMeta();
  const existing = list.filter((c) => meta.sheets.has(c.tab));
  const data = await gs.readMany(existing.map(tabRange), { unformatted: true });
  return existing.map((c, i) => ({ c, rows: data[i] }));
}

export async function weekSummary(c, week) {
  return summarize(await gs.read(tabRange(c), { unformatted: true }), week);
}

/** Salaires de tous les charbonniers pour une semaine. */
export async function salariesForWeek(week) {
  const tabs = await readTabs(registry);
  return tabs
    .map(({ c, rows }) => ({ c, ...summarize(rows, week) }))
    .filter((s) => s.c.actif || s.count > 0);
}
