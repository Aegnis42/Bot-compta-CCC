import { env, PRODUCTS, SHEETS, STOCK_MAX, BONUS_RACHAT, overCapacity } from './config.js';
import { getStock } from './contrats.js';
import * as gs from './sheets.js';
import { COLS, SALAIRES_FIRST_ROW, weekFormula, salairesHeader } from './setup.js';
import { toSheetSerial, weekOfSerial } from './time.js';
import { UserError, num, qtyFrom, emptyQty, addQty, lastDataRow, newRef, round2 } from './utils.js';

// Colonnes d'un onglet charbonnier :
// A Date | B Semaine (formule) | C CP | D C | E BC | F CO | G Montant (formule) | H Source | I Réf | J Note
// | K Bonus rachat par unité, figé au moment du dépôt (changer le bonus ne modifie pas les dépôts passés)
export const IDX = { date: 0, week: 1, qty: 2, montant: 6, source: 7, ref: 8, note: 9, bonus: 10 };
const TAB_COLUMNS = 11;

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
  const rows = await gs.read(`${gs.q(SHEETS.CHARBONNIERS)}!A2:G`, { unformatted: true });
  registry = rows
    .map((r, i) => ({
      name: String(r[0] ?? '').trim(),
      discordId: String(r[1] ?? '').trim(),
      channelId: String(r[2] ?? '').trim(),
      tab: String(r[3] ?? '').trim() || String(r[0] ?? '').trim(),
      actif: !/^(non|no|false|0)$/i.test(String(r[4] ?? 'OUI').trim()),
      bonus: num(r[6]),
      bonusSet: r[6] !== undefined && r[6] !== '',
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
  const bonus = `(${COLS.depot.map((col) => `${col}2:${col}`).join('+')})*K2:K`;
  const montant = `={"Montant (${env.currency})";ARRAYFORMULA(IF(LEN(A2:A&${c1}2:${c1}&${c2}2:${c2}&${c3}2:${c3}&${c4}2:${c4})=0,"",IFERROR(ROUND(${sum}+${bonus},2),"?")))}`;
  return ['Date', week, ...PRODUCTS.map((p) => p.code), montant, 'Source', 'Réf', 'Note', `Bonus rachat (${env.currency}/unité)`];
}

/** Crée l'onglet d'un charbonnier s'il n'existe pas. */
export async function ensureTab(title) {
  const meta = await gs.getMeta(true);
  if (meta.sheets.has(title)) return false;
  const res = await gs.batchUpdate([{ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: TAB_COLUMNS, frozenRowCount: 1 } } } }]);
  const sheetId = res.replies[0].addSheet.properties.sheetId;
  await gs.write(`${gs.q(title)}!A1:K1`, [tabHeader()], false);
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

  // Onglets créés avant la colonne K (bonus) : on ajoute la colonne manquante
  const narrow = list.map((c) => meta.sheets.get(c.tab)).filter((p) => p.gridProperties.columnCount < TAB_COLUMNS);
  await gs.batchUpdate(narrow.map((p) => ({
    appendDimension: { sheetId: p.sheetId, dimension: 'COLUMNS', length: TAB_COLUMNS - p.gridProperties.columnCount },
  })));

  // En-têtes et formules des onglets (remis à jour à chaque fois : corrige les onglets créés avec un ancien format)
  const header = tabHeader();
  await gs.writeMany([
    ...list.map((c) => ({ range: `${gs.q(c.tab)}!A1:K1`, values: [header] })),
    ...Object.entries(salairesHeader()).map(([cell, values]) => ({ range: `${S}!${cell}`, values })),
  ], false);
  await applyDefaultBonus();

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

const tabRange = (c) => `${gs.q(c.tab)}!A2:K`;

/** Ajoute la colonne K (bonus) à un onglet créé avant son apparition. */
async function ensureTabColumns(title) {
  const p = await gs.sheetProps(title);
  if (p.gridProperties.columnCount >= TAB_COLUMNS) return;
  await gs.batchUpdate([{ appendDimension: { sheetId: p.sheetId, dimension: 'COLUMNS', length: TAB_COLUMNS - p.gridProperties.columnCount } }]);
  await gs.getMeta(true);
}

/**
 * Colonne G de l'onglet "Charbonniers" : bonus de rachat par unité.
 * Les comptes de BONUS_RACHAT.ids reçoivent le bonus par défaut si la case est vide
 * (une valeur saisie à la main, même 0, est respectée).
 */
async function applyDefaultBonus() {
  const R = gs.q(SHEETS.CHARBONNIERS);
  const todo = registry.filter((c) => !c.bonusSet && BONUS_RACHAT.ids.includes(c.discordId));
  await gs.writeMany([
    { range: `${R}!G1`, values: [[`Bonus rachat (${env.currency}/unité)`]] },
    ...todo.map((c) => ({ range: `${R}!G${c.row}`, values: [[BONUS_RACHAT.montant]] })),
  ]);
  for (const c of todo) Object.assign(c, { bonus: BONUS_RACHAT.montant, bonusSet: true });
}

const fmtN = (n) => Math.round(n).toLocaleString('fr-FR');

/** Enregistre un dépôt dans l'onglet du charbonnier (refusé si le stock du produit est déjà plein). */
export function recordDeposit(c, qty, { source = 'Discord', note = '' } = {}) {
  return gs.withLock(async () => {
    // Vérifié sous le verrou, sur le stock à jour (dépôts précédents compris)
    const stock = Object.fromEntries(Object.entries(await getStock()).map(([code, s]) => [code, s.stock]));
    const over = overCapacity(qty, stock);
    if (over.length) {
      const name = (code) => PRODUCTS.find((p) => p.code === code).name;
      throw new UserError([
        `🔒 **Dépôt refusé : stock plein** (${fmtN(STOCK_MAX)} ou plus).`,
        ...over.map((o) => `• ${name(o.code)} (${o.code}) : ${fmtN(o.stock)} en stock.`),
        `Rien n'a été enregistré. Les dépôts reprendront quand le stock repassera sous ${fmtN(STOCK_MAX)}.`,
      ].join('\n'));
    }
    const rows = await gs.read(tabRange(c), { unformatted: true });
    const row = lastDataRow(rows, [IDX.date, 2, 3, 4, 5, IDX.ref]) + 3;
    await gs.ensureRows(c.tab, row);
    await ensureTabColumns(c.tab);
    const ref = newRef('D');
    const serial = toSheetSerial();
    const t = gs.q(c.tab);
    await gs.writeMany([
      { range: `${t}!A${row}`, values: [[serial]] },
      { range: `${t}!C${row}:F${row}`, values: [PRODUCTS.map((p) => qty[p.code] || '')] },
      { range: `${t}!H${row}:K${row}`, values: [[source, ref, String(note).slice(0, 300), c.bonus || '']] },
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
