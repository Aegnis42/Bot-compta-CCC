import { env, PRODUCTS, SHEETS, STOCK_MAX, BONUS_RACHAT, PLAFOND, overCapacity } from './config.js';
import { getStock } from './contrats.js';
import * as gs from './sheets.js';
import { colIndex, colLetter, lastProductCol, qtyAt, qtyWrites } from './columns.js';
import { COLS, SALAIRES_FIRST_ROW, weekFormula, salairesHeader, recapDynamicWrites } from './setup.js';
import { getSetting } from './settings.js';
import { blockedIn, blockedMessage } from './rachat.js';
import { toSheetSerial, weekOfSerial } from './time.js';
import { UserError, num, qtyFrom, emptyQty, addQty, lastDataRow, newRef, round2 } from './utils.js';

// Colonnes d'un onglet charbonnier :
// A Date | B Semaine (formule) | C CP | D C | E BC | F CO | G Montant (formule) | H Source | I Réf | J Note
// | K Bonus rachat par unité, figé au moment du dépôt (changer le bonus ne modifie pas les dépôts passés)
// | L Bois, puis les éventuels produits ajoutés plus tard (voir columns.js)
export const IDX = { date: 0, week: 1, montant: 6, source: 7, ref: 8, note: 9, bonus: 10 };
const TAB_COLUMNS = Math.max(colIndex('K'), lastProductCol('depot')) + 1;
const TAB_LAST = colLetter(TAB_COLUMNS - 1);

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
let loadSeq = 0;
export async function loadRegistry() {
  const seq = ++loadSeq;
  const rows = await gs.read(`${gs.q(SHEETS.CHARBONNIERS)}!A2:I`, { unformatted: true });
  // Une lecture plus récente a déjà été lancée (ex. après une suppression) : on ne l'écrase pas avec celle-ci
  if (seq !== loadSeq) return registry;
  registry = rows
    .map((r, i) => ({
      name: String(r[0] ?? '').trim(),
      discordId: String(r[1] ?? '').trim(),
      channelId: String(r[2] ?? '').trim(),
      tab: String(r[3] ?? '').trim() || String(r[0] ?? '').trim(),
      actif: !/^(non|no|false|0)$/i.test(String(r[4] ?? 'OUI').trim()),
      bonus: num(r[6]),
      bonusSet: r[6] !== undefined && r[6] !== '',
      // Citoyenneté payée quand il fournit du charbon (vide = OUI)
      citoyennete: !/^(non|no|false|0)$/i.test(String(r[7] ?? '').trim()),
      citoyenneteSet: r[7] !== undefined && r[7] !== '',
      // Plafond de salaire hebdomadaire (vide = PLAFOND.base, jamais plus que PLAFOND.max)
      plafond: r[8] === undefined || r[8] === '' ? PLAFOND.base : Math.min(Math.max(0, num(r[8])), PLAFOND.max),
      plafondSet: r[8] !== undefined && r[8] !== '',
      addedAt: typeof r[5] === 'number' ? r[5] : null, // « Ajouté le » (numéro de série Sheets)
      row: i + 2,
    }))
    .filter((c) => c.name);
  return registry;
}

function tabHeader() {
  const P = gs.q(SHEETS.PRIX);
  const week = `={"Semaine";ARRAYFORMULA(IF(A2:A="","",IFERROR(${weekFormula('A2:A')},"?")))}`;
  const sum = COLS.depot.map((col, i) => `${col}2:${col}*${P}!$C${i + 2}`).join('+');
  const bonus = `(${COLS.depot.map((col) => `${col}2:${col}`).join('+')})*K2:K`;
  const filled = ['A2:A', ...COLS.depot.map((col) => `${col}2:${col}`)].join('&');
  const montant = `={"Montant (${env.currency})";ARRAYFORMULA(IF(LEN(${filled})=0,"",IFERROR(ROUND(${sum}+${bonus},2),"?")))}`;
  const row = Array(TAB_COLUMNS).fill('');
  Object.entries({ A: 'Date', B: week, G: montant, H: 'Source', I: 'Réf', J: 'Note', K: `Bonus rachat (${env.currency}/unité)` })
    .forEach(([letter, v]) => { row[colIndex(letter)] = v; });
  PRODUCTS.forEach((p, i) => { row[colIndex(COLS.depot[i])] = p.code; });
  return row;
}

/** Crée l'onglet d'un charbonnier s'il n'existe pas. */
export async function ensureTab(title) {
  const meta = await gs.getMeta(true);
  if (meta.sheets.has(title)) return false;
  const res = await gs.batchUpdate([{ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: TAB_COLUMNS, frozenRowCount: 1 } } } }]);
  const sheetId = res.replies[0].addSheet.properties.sheetId;
  await gs.write(`${gs.q(title)}!A1:${TAB_LAST}1`, [tabHeader()], false);
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
    const brut = `SUMIF(${t}!$B:$B,$B$2,${t}!$G:$G)`;
    const cap = plafondFormula(c);
    return [
      c.name,
      ...COLS.depot.map((col) => `=SUMIF(${t}!$B:$B,$B$2,${t}!${col}:${col})`),
      `=MIN(${brut},${cap})`, // salaire payé, plafonné
      `=MAX(0,${brut}-${cap})`, // surplus = don à l'entreprise
      c.actif ? 'Actif' : 'Inactif',
    ];
  });
  const last = first + rows.length - 1;
  // Colonnes : A nom | une par produit | salaire | don | statut
  const sumCols = Array.from({ length: PRODUCTS.length + 2 }, (_, k) => colLetter(k + 1));
  const lastCol = colLetter(PRODUCTS.length + 3);
  const total = rows.length
    ? ['TOTAL', ...sumCols.map((col) => `=SUM(${col}${first}:${col}${last})`), '']
    : ['TOTAL', ...sumCols.map(() => 0), ''];

  // Onglets créés avant la colonne K (bonus) : on ajoute la colonne manquante
  const narrow = list.map((c) => meta.sheets.get(c.tab)).filter((p) => p.gridProperties.columnCount < TAB_COLUMNS);
  await gs.batchUpdate(narrow.map((p) => ({
    appendDimension: { sheetId: p.sheetId, dimension: 'COLUMNS', length: TAB_COLUMNS - p.gridProperties.columnCount },
  })));

  // En-têtes et formules des onglets (remis à jour à chaque fois : corrige les onglets créés avec un ancien format)
  const header = tabHeader();
  await gs.writeMany([
    ...list.map((c) => ({ range: `${gs.q(c.tab)}!A1:${TAB_LAST}1`, values: [header] })),
    ...Object.entries(salairesHeader()).map(([cell, values]) => ({ range: `${S}!${cell}`, values })),
  ], false);
  await applyDefaultBonus();

  await gs.write(`${S}!A4:${lastCol}4`, [['Charbonnier', ...PRODUCTS.map((p) => p.code), `Salaire dû (${env.currency}, plafonné)`, `Don à l'entreprise (${env.currency})`, 'Statut']]);
  await gs.clear(`${S}!A${first}:${colLetter(Math.max(7, PRODUCTS.length + 3))}`);
  await gs.write(`${S}!A${first}:${lastCol}${first + rows.length}`, [...rows, total], false);

  const stock = COLS.depot.map((col) => [
    list.length ? `=${list.map((c) => `SUM(${gs.q(c.tab)}!${col}2:${col})`).join('+')}` : 0,
  ]);
  await gs.write(`${gs.q(SHEETS.STOCK)}!C2:C${PRODUCTS.length + 1}`, stock, false);

  // Récap (Feuille 1) : rachat de la semaine et nombre de charbonniers ayant fourni, une fois le récap mis en page
  if (getSetting('recap_version')) await gs.writeMany(recapDynamicWrites(list), false);
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

/**
 * Numéro de ligne À JOUR d'un charbonnier (à appeler sous le verrou) : le registre en mémoire peut dater
 * d'avant une suppression qui a décalé les lignes. On relit l'onglet et on retrouve la ligne par nom + compte Discord.
 */
async function freshRow(c) {
  await loadRegistry();
  const fresh = registry.find((x) => x.name === c.name && x.discordId === c.discordId);
  if (!fresh) throw new UserError(`**${c.name}** n'est plus dans l'onglet Charbonniers (déjà supprimé ?).`);
  return fresh.row;
}

export function deactivateCharbonnier(c) {
  return gs.withLock(async () => {
    await gs.write(`${gs.q(SHEETS.CHARBONNIERS)}!E${await freshRow(c)}`, [['NON']]);
    await loadRegistry();
    await rebuildFormulas();
  });
}

/** Charbonnier (actif ou non) par compte Discord ou par nom. */
export const findAny = ({ userId, name }) =>
  (userId && registry.find((c) => c.discordId === userId)) || (name && findByName(name)) || null;

/** Ce que contient l'onglet d'un charbonnier : nombre de dépôts et quantités totales déposées. */
export async function tabTotals(c) {
  const meta = await gs.getMeta();
  if (!meta.sheets.has(c.tab)) return { count: 0, qty: emptyQty() };
  const rows = await gs.read(tabRange(c), { unformatted: true });
  const qty = emptyQty();
  let count = 0;
  for (const r of rows) {
    const q = qtyAt(r, 'depot');
    if (!PRODUCTS.some((p) => q[p.code])) continue;
    addQty(qty, q);
    count++;
  }
  return { count, qty };
}

/**
 * Supprime définitivement un charbonnier du Sheet : son onglet et sa ligne dans « Charbonniers ».
 * Le charbon qu'il a déposé reste dans le stock : il est reporté dans la colonne « Ajustement manuel » (D)
 * de l'onglet Stock, sinon il disparaîtrait avec l'onglet.
 */
export function deleteCharbonnier(c) {
  return gs.withLock(async () => {
    const row = await freshRow(c); // jamais une ligne décalée : on supprimerait un autre charbonnier
    const totals = await tabTotals(c);
    const St = gs.q(SHEETS.STOCK);
    if (PRODUCTS.some((p) => totals.qty[p.code])) {
      const ajust = await gs.read(`${St}!D2:D${PRODUCTS.length + 1}`, { unformatted: true });
      await gs.write(`${St}!D2:D${PRODUCTS.length + 1}`, PRODUCTS.map((p, i) => [num(ajust[i]?.[0]) + totals.qty[p.code]]));
    }
    const meta = await gs.getMeta(true);
    const requests = [];
    // Onglet supprimé seulement s'il n'est partagé avec aucun autre charbonnier
    if (meta.sheets.has(c.tab) && !registry.some((x) => x !== c && x.tab === c.tab)) {
      requests.push({ deleteSheet: { sheetId: meta.sheets.get(c.tab).sheetId } });
    }
    const reg = meta.sheets.get(SHEETS.CHARBONNIERS);
    requests.push({ deleteDimension: { range: { sheetId: reg.sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } });
    await gs.batchUpdate(requests);
    await gs.getMeta(true);
    await loadRegistry();
    await rebuildFormulas();
    return totals;
  });
}

const tabRange = (c) => `${gs.q(c.tab)}!A2:${TAB_LAST}`;

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
  // Colonne H : citoyenneté (OUI par défaut) · colonne I : plafond hebdo (600 par défaut). Écrits pour être lisibles dans le Sheet.
  const citoyens = registry.filter((c) => !c.citoyenneteSet);
  const plafonds = registry.filter((c) => !c.plafondSet);
  await gs.writeMany([
    { range: `${R}!G1:I1`, values: [[`Bonus rachat (${env.currency}/unité)`, 'Citoyenneté (OUI/NON)', `Plafond hebdo (${env.currency}, max ${PLAFOND.max})`]] },
    ...todo.map((c) => ({ range: `${R}!G${c.row}`, values: [[BONUS_RACHAT.montant]] })),
    ...citoyens.map((c) => ({ range: `${R}!H${c.row}`, values: [['OUI']] })),
    ...plafonds.map((c) => ({ range: `${R}!I${c.row}`, values: [[PLAFOND.base]] })),
  ]);
  for (const c of todo) Object.assign(c, { bonus: BONUS_RACHAT.montant, bonusSet: true });
  for (const c of citoyens) Object.assign(c, { citoyennete: true, citoyenneteSet: true });
  for (const c of plafonds) Object.assign(c, { plafond: PLAFOND.base, plafondSet: true });
}

/** Formule Sheets du plafond d'un charbonnier (lit la colonne I de l'onglet Charbonniers). */
export function plafondFormula(c) {
  const cell = `${gs.q(SHEETS.CHARBONNIERS)}!$I${c.row}`;
  return `IF(${cell}="",${PLAFOND.base},MIN(${cell},${PLAFOND.max}))`;
}

/** Fixe le plafond de salaire hebdomadaire d'un charbonnier (entre 0 et PLAFOND.max). */
export function setPlafond(c, value) {
  const v = Math.round(Number(value));
  if (!(v >= 0) || v > PLAFOND.max) throw new UserError(`Plafond invalide : il doit être entre 0 et ${PLAFOND.max} ${env.currency}.`);
  return gs.withLock(async () => {
    await gs.write(`${gs.q(SHEETS.CHARBONNIERS)}!I${await freshRow(c)}`, [[v]]);
    await loadRegistry();
    await rebuildFormulas();
  });
}

/**
 * Applique le plafond à un total de semaine : montant = salaire payé, don = ce qui dépasse,
 * brut = valeur totale du charbon déposé.
 */
export function withPlafond(res, c) {
  const plafond = c?.plafond ?? Infinity;
  return { ...res, brut: res.montant, plafond, montant: round2(Math.min(res.montant, plafond)), don: round2(Math.max(0, res.montant - plafond)) };
}

/**
 * Message à afficher après un dépôt de valeur `added` si le plafond est dépassé (null sinon).
 * weekSum : total de la semaine dépôt compris (résultat de weekSummary).
 */
export function plafondNotice(weekSum, added) {
  const { plafond, brut } = weekSum;
  if (!Number.isFinite(plafond) || brut <= plafond) return null;
  const before = brut - added;
  const money = (n) => `${(Math.round(n * 100) / 100).toLocaleString('fr-FR')} ${env.currency}`;
  if (before >= plafond) {
    return `🎁 **Plafond hebdomadaire déjà atteint** (${money(plafond)}) : ce dépôt (${money(added)}) est un **don à l'entreprise**, il ne sera pas payé. Merci !`;
  }
  return `⚠️ **Plafond hebdomadaire dépassé** : ton salaire de la semaine est plafonné à ${money(plafond)}. **${money(brut - plafond)}** de ce dépôt dépassent et comptent comme un **don à l'entreprise**.`;
}

/** Payer ou non la citoyenneté à un charbonnier quand il fournit du charbon. */
export function setCitizenship(c, payer) {
  return gs.withLock(async () => {
    await gs.write(`${gs.q(SHEETS.CHARBONNIERS)}!H${await freshRow(c)}`, [[payer ? 'OUI' : 'NON']]);
    await loadRegistry();
    await rebuildFormulas();
  });
}

const fmtN = (n) => Math.round(n).toLocaleString('fr-FR');

/** Enregistre un dépôt dans l'onglet du charbonnier (refusé si le stock du produit est déjà plein). */
export function recordDeposit(c, qty, { source = 'Discord', note = '' } = {}) {
  return gs.withLock(async () => {
    // Rachat bloqué (Briquette / Coke) : dépôt refusé en entier
    const blocked = blockedIn(qty);
    if (blocked.length) throw new UserError(blockedMessage(blocked));
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
    const row = lastDataRow(rows, [IDX.date, ...COLS.depot.map(colIndex), IDX.ref]) + 3;
    await gs.ensureRows(c.tab, row);
    await ensureTabColumns(c.tab);
    const ref = newRef('D');
    const serial = toSheetSerial();
    const t = gs.q(c.tab);
    await gs.writeMany([
      { range: `${t}!A${row}`, values: [[serial]] },
      ...qtyWrites(t, 'depot', row, qty),
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
    // On vide les cellules du dépôt au lieu de supprimer la ligne : rien ne se décale, et si Google répond trop
    // tard et que l'opération est relancée, la référence n'existe plus → rien d'autre n'est effacé.
    await gs.clear(`${gs.q(c.tab)}!A${idx + 2}:${TAB_LAST}${idx + 2}`);
    return { ref: r[IDX.ref], qty: qtyAt(r, 'depot'), week: r[IDX.week], montant: num(r[IDX.montant]) };
  });
}

/** Dernier dépôt fait via Discord (pour proposer de l'annuler), ou null. */
export async function lastDiscordDeposit(c) {
  const rows = await gs.read(tabRange(c), { unformatted: true });
  const r = rows.findLast((x) => x[IDX.source] === 'Discord' && x[IDX.ref]);
  return r ? { ref: String(r[IDX.ref]), qty: qtyAt(r, 'depot'), week: r[IDX.week], montant: num(r[IDX.montant]) } : null;
}

export function summarize(rows, week) {
  const res = { qty: emptyQty(), montant: 0, count: 0 };
  for (const r of rows) {
    if (r[IDX.week] !== week) continue;
    addQty(res.qty, qtyAt(r, 'depot'));
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
  return withPlafond(summarize(await gs.read(tabRange(c), { unformatted: true }), week), c);
}

/** Salaires de tous les charbonniers pour une semaine. */
export async function salariesForWeek(week) {
  const tabs = await readTabs(registry);
  return tabs
    .map(({ c, rows }) => ({ c, ...withPlafond(summarize(rows, week), c) }))
    .filter((s) => s.c.actif || s.count > 0);
}

/**
 * Activité de chaque charbonnier (actifs et inactifs), du plus inactif au plus actif :
 * depuis combien de jours il est enregistré, et depuis combien de jours il n'a rien fourni
 * (depuis son dernier dépôt, ou depuis son arrivée s'il n'a jamais rien déposé).
 */
export async function charbonnierActivity(now = toSheetSerial()) {
  const tabs = await readTabs(registry);
  const rowsOf = new Map(tabs.map(({ c, rows }) => [c, rows]));
  return registry
    .map((c) => {
      const dates = (rowsOf.get(c) ?? [])
        .filter((r) => typeof r[IDX.date] === 'number' && PRODUCTS.some((p) => qtyAt(r, 'depot')[p.code]))
        .map((r) => r[IDX.date]);
      const lastAt = dates.length ? Math.max(...dates) : null;
      const since = lastAt ?? c.addedAt;
      return {
        c,
        count: dates.length,
        addedAt: c.addedAt,
        lastAt,
        daysHere: c.addedAt === null ? null : Math.floor(now - c.addedAt),
        daysIdle: since === null ? null : Math.floor(now - since),
      };
    })
    .sort((a, b) => (b.daysIdle ?? -1) - (a.daysIdle ?? -1));
}
