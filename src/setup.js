import { env, PRODUCTS, SHEETS, TARIFS, STOCK_LEVELS, SEMAINE } from './config.js';
import { createHash } from 'node:crypto';
import * as gs from './sheets.js';
import { loadSettings, getSetting, setSetting } from './settings.js';
import { plafondFormula } from './charbonniers.js';
import { colsOf, colIndex, colLetter } from './columns.js';

const P = gs.q(SHEETS.PRIX);
const C = gs.q(SHEETS.CONTRATS);
const L = gs.q(SHEETS.LIVRAISONS);
const A = gs.q(SHEETS.ACHATS);
const N = gs.q(SHEETS.NOURRITURE);
const R = gs.q(SHEETS.RECAP);

// Colonnes des quantités de chaque produit dans chaque onglet (dans l'ordre de PRODUCTS) : voir columns.js
export const COLS = Object.fromEntries(
  ['depot', 'livraison', 'commande', 'livre', 'reste', 'prixPerso', 'achat'].map((k) => [k, colsOf(k)]),
);

/** Nombre de colonnes nécessaires : la plus grande parmi les colonnes fixes (`fixedLast`) et celles des produits. */
const widthOf = (fixedLast, sheets) => Math.max(colIndex(fixedLast), ...sheets.flatMap((k) => colsOf(k).map(colIndex))) + 1;

// Onglet Contrats : colonnes fixes jusqu'à AD, puis les colonnes des produits ajoutés (Bois : AE → AH)
const CONTRATS_COLUMNS = widthOf('AD', ['commande', 'livre', 'reste', 'prixPerso']);
const CONTRATS_LAST = colLetter(CONTRATS_COLUMNS - 1);
const LIVRAISONS_LAST = colLetter(widthOf('I', ['livraison']) - 1);
const ACHATS_LAST = colLetter(widthOf('J', ['achat']) - 1);

/** Ligne d'en-tête construite colonne par colonne : { A: 'ID', AE: 'BO commandé', … }. */
const headerRow = (width, cells) => {
  const row = Array(width).fill('');
  for (const [letter, value] of Object.entries(cells)) row[colIndex(letter)] = value;
  return row;
};

// Ligne de début des données dans "Salaires"
export const SALAIRES_FIRST_ROW = 5;

// Semaines (mêmes règles que time.js) : du lundi au dimanche avant la transition, semaine de transition
// du lundi 16 au samedi 21/11/2026, puis du dimanche au samedi. WEEKDAY(d,2) : lundi = 1 ; WEEKDAY(d,1) : dimanche = 1.
const T0 = `DATE(${SEMAINE.transition.join(',')})`;
const T1 = `DATE(${SEMAINE.dimanche.join(',')})`;

/** Formule du premier jour de la semaine contenant la date `d`. */
export const weekStartFormula = (d) =>
  `IF(INT(${d})<${T0},INT(${d})-WEEKDAY(${d},2)+1,IF(INT(${d})<${T1},${T0},INT(${d})-WEEKDAY(${d},1)+1))`;

/** Formule du dernier jour (inclus) de la semaine contenant la date `d`. */
export const weekEndFormula = (d) =>
  `IF(INT(${d})<${T0},INT(${d})-WEEKDAY(${d},2)+7,IF(INT(${d})<${T1},${T1}-1,INT(${d})-WEEKDAY(${d},1)+7))`;

/** Formule donnant la semaine contenant la date `d` : "16/11/2026 au 21/11/2026". */
export const weekFormula = (d) =>
  `TEXT(${weekStartFormula(d)},"dd/mm/yyyy")&" au "&TEXT(${weekEndFormula(d)},"dd/mm/yyyy")`;

/** En-tête de l'onglet Salaires (hors B1, saisi par l'utilisateur). */
export const salairesHeader = () => ({
  A1: [['Semaine à afficher']],
  C1: [['← une date de la semaine voulue (ex : 29/09/2026), ou vide pour la semaine en cours']],
  A2: [['Semaine affichée', `=IF(B1="",${weekFormula('TODAY()')},IFERROR(${weekFormula('B1')},"Date invalide en B1"))`]],
});

/**
 * Prix de vente unitaire du produit i : le prix personnalisé du contrat (`customExpr`) s'il est renseigné
 * et supérieur à 0, sinon le tarif (`tarifExpr` : Normal ou Chatelerie).
 */
const sellPrice = (i, tarifExpr, customExpr) => {
  const tarif = `IF(REGEXMATCH(LOWER(${tarifExpr}),"chat"),${P}!$E${i + 2},${P}!$D${i + 2})`;
  return customExpr ? `IF(IFERROR(${customExpr}*1,0)>0,IFERROR(${customExpr}*1,0),${tarif})` : tarif;
};
const contractCustom = (i) => `${COLS.prixPerso[i]}2:${COLS.prixPerso[i]}`;

/**
 * En-tête de l'onglet Contrats (formules calculées sur toute la colonne).
 * Q : prix payé par le client (tarif de vente) · V : coût des matériaux (prix de rachat) · W : bénéfice = Q − V.
 */
function contratsHeader() {
  const arr = (title, expr) => `={"${title}";ARRAYFORMULA(IF(A2:A="","",${expr}))}`;
  const cmd = (i) => `${COLS.commande[i]}2:${COLS.commande[i]}`;
  const cells = { A: 'ID', B: 'Date', C: 'Client', D: `Tarif (${TARIFS.normal}/${TARIFS.chatelerie})` };
  PRODUCTS.forEach((p, i) => {
    cells[COLS.commande[i]] = `${p.code} commandé`;
    cells[COLS.livre[i]] = arr(`${p.code} livré`, `SUMIF(${L}!B2:B,A2:A,${L}!${COLS.livraison[i]}2:${COLS.livraison[i]})`);
    cells[COLS.reste[i]] = arr(`${p.code} reste`, `${cmd(i)}-${COLS.livre[i]}2:${COLS.livre[i]}`);
    cells[COLS.prixPerso[i]] = `Prix perso ${p.code} (${env.currency}/unité)`;
  });
  Object.assign(cells, {
    Q: arr(`Prix client (${env.currency})`, `ROUND(${PRODUCTS.map((_, i) => `${cmd(i)}*${sellPrice(i, 'D2:D', contractCustom(i))}`).join('+')},2)`),
    R: arr(`Montant livré (${env.currency})`, `ROUND(${PRODUCTS.map((_, i) => `${COLS.livre[i]}2:${COLS.livre[i]}*${sellPrice(i, 'D2:D', contractCustom(i))}`).join('+')},2)`),
    S: arr('Statut', `IF(UPPER(T2:T)="OUI","Annulé",IF(${COLS.reste.map((c) => `(${c}2:${c}<=0)`).join('*')},"Livré",IF(${COLS.livre.map((c) => `${c}2:${c}`).join('+')}>0,"Partiel","En attente")))`),
    T: 'Annulé (OUI)',
    U: 'Note',
    // Coût matériaux = achats extérieurs rattachés au contrat (prix payé)
    //                 + le reste des quantités commandées au prix de rachat des charbonniers
    V: arr(`Coût matériaux (${env.currency})`, `ROUND(${PRODUCTS.map((_, i) => {
      const bought = `SUMIF(${A}!H2:H,A2:A,${A}!${COLS.achat[i]}2:${COLS.achat[i]})`;
      return `IF(${cmd(i)}-${bought}>0,${cmd(i)}-${bought},0)*${P}!$C$${i + 2}`;
    }).join('+')}+SUMIF(${A}!H2:H,A2:A,${A}!G2:G),2)`),
    W: arr(`Bénéfice (${env.currency})`, 'Q2:Q-V2:V'),
    AB: 'Hebdomadaire (OUI)',
    AC: 'Lieu de livraison',
    AD: 'Client Discord (ID)',
  });
  return headerRow(CONTRATS_COLUMNS, cells);
}

/** En-tête de l'onglet Livraisons : montant au prix du contrat (prix perso ou tarif). */
function livraisonsHeader() {
  const look = (col) => `IFERROR(VLOOKUP(B2:B,${C}!A:${CONTRATS_LAST},${col},FALSE),"")`;
  const montant = `={"Montant (${env.currency})";ARRAYFORMULA(IF(B2:B="","",IFERROR(ROUND(${PRODUCTS.map((_, i) => `${COLS.livraison[i]}2:${COLS.livraison[i]}*${sellPrice(i, look(4), look(colIndex(COLS.prixPerso[i]) + 1))}`).join('+')},2),"?")))}`;
  const cells = { A: 'Date', B: 'Contrat', G: montant, H: 'Par', I: 'Note' };
  PRODUCTS.forEach((p, i) => { cells[COLS.livraison[i]] = p.code; });
  return headerRow(colIndex(LIVRAISONS_LAST) + 1, cells);
}

/** Ajoute les colonnes manquantes de l'onglet Contrats (prix perso jusqu'à AA). */
async function ensureContratsColumns() {
  const p = await gs.sheetProps(SHEETS.CONTRATS);
  if (p.gridProperties.columnCount >= CONTRATS_COLUMNS) return;
  await gs.batchUpdate([{ appendDimension: { sheetId: p.sheetId, dimension: 'COLUMNS', length: CONTRATS_COLUMNS - p.gridProperties.columnCount } }]);
  await gs.getMeta(true);
}

const NOURRITURE_HEADER = ['Date', `Montant (${env.currency})`, 'Note', 'Par', 'Hebdomadaire (OUI)', 'ID'];

export const HISTORIQUE_HEADER = [
  'Semaine', 'Début de semaine', 'Chiffre d\'affaires', 'Rachat charbonniers', 'Achats extérieurs', 'Coût matériaux', 'Bénéfice',
  'Salaire gestion', 'Salaire clan', 'Charbonniers ayant fourni', 'Citoyenneté', 'Contrat nourriture', 'Bénéfice final',
  'Taxe', 'BAT', ...PRODUCTS.slice(0, 4).map((p) => `Stock ${p.code} (fin de semaine)`), 'Clôturé le',
  ...PRODUCTS.slice(4).map((p) => `Stock ${p.code} (fin de semaine)`),
];
const HISTORIQUE_LAST = colLetter(HISTORIQUE_HEADER.length - 1);

/** En-tête de l'onglet Achats : produits ajoutés après la colonne J (Bois en K). */
const achatsHeader = () => {
  const cells = { A: 'Date', B: 'Fournisseur', G: `Prix payé (${env.currency})`, H: 'Contrat (optionnel)', I: 'Par', J: 'Note' };
  PRODUCTS.forEach((p, i) => { cells[COLS.achat[i]] = p.code; });
  return headerRow(colIndex(ACHATS_LAST) + 1, cells);
};

const INIT = {
  async [SHEETS.PRIX](sheetId) {
    await gs.write(`${P}!A1:E${PRODUCTS.length + 1}`, [
      ['Produit', 'Code', `Rachat (${env.currency})`, `Vente normale (${env.currency})`, `Vente ${TARIFS.chatelerie} (${env.currency})`],
      ...PRODUCTS.map((p) => [p.name, p.code, p.rachat, p.normal, p.chatelerie]),
    ]);
    return [gs.headerFormat(sheetId)];
  },

  async [SHEETS.CHARBONNIERS](sheetId) {
    await gs.write(`${gs.q(SHEETS.CHARBONNIERS)}!A1:F1`, [['Nom', 'Discord ID', 'Salon ID', 'Onglet', 'Actif (OUI/NON)', 'Ajouté le']]);
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 1, gs.TEXT), gs.columnFormat(sheetId, 2, gs.TEXT), gs.columnFormat(sheetId, 5, gs.DATE_TIME)];
  },

  async [SHEETS.SALAIRES](sheetId) {
    const S = gs.q(SHEETS.SALAIRES);
    const h = salairesHeader();
    await gs.writeMany(Object.entries(h).map(([cell, values]) => ({ range: `${S}!${cell}`, values })), false);
    await gs.write(`${S}!A4:H4`, [['Charbonnier', ...PRODUCTS.map((p) => p.code), `Salaire dû (${env.currency}, plafonné)`, `Don à l'entreprise (${env.currency})`, 'Statut']]);
    return [
      gs.headerFormat(sheetId, 3),
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat' } },
    ];
  },

  async [SHEETS.STOCK](sheetId) {
    const S = gs.q(SHEETS.STOCK);
    // Colonnes C (reconstruite par le bot) et D (saisie manuelle) initialisées à 0, le reste par writeStockFormulas()
    await gs.write(`${S}!A2:D${PRODUCTS.length + 1}`, PRODUCTS.map((p) => [p.name, p.code, 0, 0]));
    await writeStockFormulas();
    return [gs.headerFormat(sheetId)];
  },

  async [SHEETS.ACHATS](sheetId) {
    await gs.write(`${A}!A1:${ACHATS_LAST}1`, [achatsHeader()]);
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 0, gs.DATE_TIME)];
  },

  async [SHEETS.NOURRITURE](sheetId) {
    await gs.write(`${N}!A1:F1`, [NOURRITURE_HEADER]);
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 0, gs.DATE_TIME)];
  },

  async [SHEETS.HISTORIQUE](sheetId) {
    await gs.write(`${gs.q(SHEETS.HISTORIQUE)}!A1:${HISTORIQUE_LAST}1`, [HISTORIQUE_HEADER]);
    const number = { type: 'NUMBER', pattern: '#,##0.00' };
    return [
      gs.headerFormat(sheetId),
      gs.columnFormat(sheetId, 1, { type: 'DATE', pattern: 'dd/mm/yyyy' }),
      ...[2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14].map((col) => gs.columnFormat(sheetId, col, number)),
      gs.columnFormat(sheetId, 19, gs.DATE_TIME),
    ];
  },

  async [SHEETS.RECAP]() {
    return []; // mise en page faite par setupRecap()
  },

  async [SHEETS.CONTRATS](sheetId) {
    await ensureContratsColumns();
    await gs.write(`${C}!A1:${CONTRATS_LAST}1`, [contratsHeader()], false);
    const list = (values, col) => ({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
        rule: { condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
      },
    });
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 1, gs.DATE_TIME), list([TARIFS.normal, TARIFS.chatelerie], 3), list(['OUI'], 19)];
  },

  async [SHEETS.CONFIG](sheetId) {
    await gs.write(`${gs.q(SHEETS.CONFIG)}!A1:B1`, [['Clé', 'Valeur']]);
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 1, gs.TEXT)];
  },

  async [SHEETS.LIVRAISONS](sheetId) {
    await gs.write(`${L}!A1:${LIVRAISONS_LAST}1`, [livraisonsHeader()], false);
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 0, gs.DATE_TIME)];
  },
};

/** Ajoute dans l'onglet Prix la ligne des produits ajoutés après coup (Bois…), sans toucher aux prix existants. */
async function ensurePrixRows() {
  const rows = await gs.read(`${P}!A2:E${PRODUCTS.length + 1}`);
  const writes = [];
  PRODUCTS.forEach((p, i) => {
    const code = String(rows[i]?.[1] ?? '').trim();
    if (!code) writes.push({ range: `${P}!A${i + 2}:E${i + 2}`, values: [[p.name, p.code, p.rachat, p.normal, p.chatelerie]] });
    else if (code.toUpperCase() !== p.code) console.warn(`[Prix] ligne ${i + 2} : « ${code} » au lieu de « ${p.code} » (ordre attendu : ${PRODUCTS.map((x) => x.code).join(', ')})`);
  });
  await gs.writeMany(writes);
}

/**
 * Formules automatiques de l'onglet Stock (colonnes E à I). Les colonnes C (reconstruite par le bot)
 * et D (ajustement manuel) ne sont jamais touchées.
 * Stock actuel = déposé par les charbonniers + ajustement manuel + acheté à l'extérieur − livré.
 */
async function writeStockFormulas() {
  const S = gs.q(SHEETS.STOCK);
  const n = PRODUCTS.length;
  const existing = await gs.read(`${S}!A2:D${n + 2}`);
  const NOTE = 'Colonne D : correction manuelle du stock';
  await gs.writeMany([
    // Produits ajoutés après coup (Bois…) : nom et code, ajustement manuel initialisé à 0 (jamais écrasé ensuite)
    ...PRODUCTS.map((p, i) => ({ range: `${S}!A${i + 2}:B${i + 2}`, values: [[p.name, p.code]] })),
    ...PRODUCTS.map((p, i) => (existing[i]?.[3] === undefined || existing[i]?.[3] === '' ? { range: `${S}!D${i + 2}`, values: [[0]] } : null)).filter(Boolean),
    // Ancienne note qui occupait la ligne juste sous les produits
    ...(String(existing[n]?.[0] ?? '').startsWith(NOTE) ? [{ range: `${S}!A${n + 2}`, values: [['']] }] : []),
    { range: `${S}!A1:I1`, values: [['Produit', 'Code', 'Déposé (charbonniers)', 'Ajustement manuel', 'Livré (contrats)', 'Stock actuel', 'Reste à livrer (contrats)', 'À produire', 'Acheté (extérieur)']] },
    ...PRODUCTS.map((p, i) => {
      const r = i + 2;
      const rc = COLS.reste[i];
      return {
        range: `${S}!E${r}:I${r}`,
        values: [[
          `=SUM(${L}!${COLS.livraison[i]}2:${COLS.livraison[i]})`,
          `=C${r}+D${r}+I${r}-E${r}`,
          `=SUMIFS(${C}!${rc}2:${rc},${C}!S2:S,"<>Annulé",${C}!${rc}2:${rc},">0")`,
          `=MAX(0,G${r}-F${r})`,
          `=SUM(${A}!${COLS.achat[i]}2:${COLS.achat[i]})`,
        ]],
      };
    }),
    { range: `${S}!A${PRODUCTS.length + 3}`, values: [['Colonne D : correction manuelle du stock (perte, inventaire...). Les achats extérieurs vont dans l\'onglet Achats (ou /achat). Le reste est automatique.']] },
  ], false);
}

// ---------- Récapitulatif (Feuille 1) ----------

const RECAP_VERSION = '3';
const WEEK_RANGE = (col) => `${col},">="&$Z$1,${col},"<"&$Z$2`; // critères SUMIFS « dans la semaine en cours »

// Le récap porte toujours sur la semaine en cours : Z1 = premier jour, Z2 = premier jour de la semaine suivante
const RECAP_WEEK = [
  { range: `${R}!A3:C4`, values: [['Semaine en cours', '=TEXT($Z$1,"dd/mm/yyyy")&" au "&TEXT($Z$2-1,"dd/mm/yyyy")', ''], ['', '', '']] },
  { range: `${R}!Z1:Z2`, values: [[`=${weekStartFormula('TODAY()')}`], [`=${weekEndFormula('TODAY()')}+1`]] },
];

/**
 * Formules du récap qui dépendent de la liste des charbonniers (réécrites par rebuildFormulas) :
 * H8 = rachat payé aux charbonniers sur la semaine,
 * J14 = nombre de charbonniers ayant fourni du charbon et à qui on paie la citoyenneté.
 */
export function recapDynamicWrites(list) {
  // Rachat payé = valeur déposée dans la semaine, plafonnée par charbonnier (le surplus est un don)
  const rachat = list.length
    ? `=${list.map((c) => `MIN(SUMIFS(${gs.q(c.tab)}!G2:G,${WEEK_RANGE(`${gs.q(c.tab)}!A2:A`)}),${plafondFormula(c)})`).join('+')}`
    : 0;
  // Citoyenneté : seulement les charbonniers marqués OUI dans l'onglet Charbonniers
  const citoyens = list.filter((c) => c.citoyennete !== false).map((c) => gs.q(c.tab));
  const count = citoyens.length ? `=${citoyens.map((t) => `(COUNTIFS(${WEEK_RANGE(`${t}!A2:A`)},${t}!G2:G,">0")>0)*1`).join('+')}` : 0;
  return [
    { range: `${R}!H8`, values: [[rachat]] },
    { range: `${R}!J14`, values: [[count]] },
  ];
}

/** Bloc stock du récap (A8:E11) : produit, stock, niveau (paliers de STOCK_LEVELS), reste à livrer, à produire. */
function recapStockRows() {
  const S = gs.q(SHEETS.STOCK);
  const lv = STOCK_LEVELS.levels;
  const levelFormula = (cell) =>
    `=IF(${cell}>=${lv[0].min},"${lv[0].icon}",IF(${cell}>=${lv[1].min},"${lv[1].icon}",IF(${cell}>=${lv[2].min},"${lv[2].icon}","${lv[3].icon}")))`;
  return PRODUCTS.map((p, i) => {
    const r = i + 2;
    return [`=${S}!A${r}`, `=${S}!F${r}`, STOCK_LEVELS.codes.includes(p.code) ? levelFormula(`B${8 + i}`) : '', `=${S}!G${r}`, `=${S}!H${r}`];
  });
}

/**
 * Met en page le récapitulatif sur « Feuille 1 », une seule fois (version notée dans Config).
 * Si la feuille contenait déjà quelque chose, elle est d'abord copiée dans « Feuille 1 (ancienne) ».
 * Les cases de saisie (trésorerie, pourcentages) ne sont plus jamais réécrites ensuite.
 */
async function setupRecap() {
  await loadSettings();
  const version = getSetting('recap_version');
  if (version === RECAP_VERSION) return false;
  if (version === '1' || version === '2') {
    // Versions 1 et 2 : on réécrit seulement le calcul de la semaine (v1 : semaine choisie en B3 ;
    // v2 : semaines du lundi au dimanche), sans toucher au reste (trésorerie, pourcentages).
    await gs.writeMany(RECAP_WEEK, false);
    await setSetting('recap_version', RECAP_VERSION);
    return true;
  }

  const props = await gs.sheetProps(SHEETS.RECAP);
  const existing = await gs.read(`${R}!A1:Z100`);
  if (existing.some((row) => row.some((v) => v !== ''))) {
    const backup = `${SHEETS.RECAP} (ancienne)`;
    if (!(await gs.getMeta(true)).sheets.has(backup)) {
      await gs.batchUpdate([{ duplicateSheet: { sourceSheetId: props.sheetId, newSheetName: backup, insertSheetIndex: 1 } }]);
    }
    await gs.batchUpdate([{ updateCells: { range: { sheetId: props.sheetId }, fields: 'userEnteredValue,userEnteredFormat' } }]);
  }

  const stockRows = recapStockRows();
  const sumWeek = (sheet, col) => `=SUMIFS(${sheet}!${col}2:${col},${WEEK_RANGE(`${sheet}!A2:A`)})`;

  await gs.writeMany([
    { range: `${R}!A1`, values: [['📊 Récapitulatif de la CCC']] },
    ...RECAP_WEEK,

    { range: `${R}!A6:E11`, values: [['📦 Stock'], ['Produit', 'Stock', 'Niveau', 'Reste à livrer', 'À produire'], ...stockRows] },
    { range: `${R}!A13:B13`, values: [[`Septimes (trésorerie)`, '']] },

    { range: `${R}!G6:K18`, values: [
      ['💰 Finances de la semaine', `Montant (${env.currency})`, 'Paramètre', '', ''],
      ['Chiffre d\'affaires (livraisons)', sumWeek(L, 'G'), '', '', ''],
      ['Rachat aux charbonniers', 0, '', '', ''],
      ['Achats extérieurs', sumWeek(A, 'G'), '', '', ''],
      ['Coût matériaux', '=H8+H9', '', '', ''],
      ['Bénéfice', '=H7-H10', '', '', ''],
      ['Salaire gestion', '=ROUND(MAX(0,H11)*I12,2)', 0.4, '', '← % du bénéfice'],
      ['Salaire clan', '=ROUND(MAX(0,H11)*I13,2)', 0.1, '', '← % du bénéfice'],
      ['Citoyenneté', '=I14*J14', 50, 0, '← septimes × charbonniers ayant fourni cette semaine'],
      ['Contrat nourriture', sumWeek(N, 'B'), '', '', '← onglet Nourriture (ou /nourriture)'],
      ['Bénéfice final', '=H11-H12-H13-H14-H15', '', '', ''],
      ['Taxe', '=ROUND(MAX(0,H16)*I17,2)', 0.2, '', '← % du bénéfice final'],
      ['Bénéfice après taxe (BAT)', '=H16-H17', '', '', ''],
    ] },
  ], false);

  const bold = (r1, r2, c1, c2) => ({
    repeatCell: { range: { sheetId: props.sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' },
  });
  const fmt = (r1, r2, c1, c2, numberFormat) => ({
    repeatCell: { range: { sheetId: props.sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 }, cell: { userEnteredFormat: { numberFormat } }, fields: 'userEnteredFormat.numberFormat' },
  });
  await gs.batchUpdate([
    { updateSheetProperties: { properties: { sheetId: props.sheetId, title: SHEETS.RECAP, index: 0, gridProperties: { frozenRowCount: 4 } }, fields: 'index,gridProperties.frozenRowCount' } },
    bold(0, 1, 0, 1), bold(2, 3, 0, 2), bold(5, 7, 0, 5), bold(5, 6, 6, 9), bold(12, 13, 0, 1),
    bold(10, 11, 6, 8), bold(15, 16, 6, 8), bold(17, 18, 6, 8),
    fmt(6, 18, 7, 8, { type: 'NUMBER', pattern: '#,##0.00' }),
    fmt(11, 13, 8, 9, { type: 'PERCENT', pattern: '0%' }),
    fmt(16, 17, 8, 9, { type: 'PERCENT', pattern: '0%' }),
    fmt(0, 2, 25, 26, { type: 'DATE', pattern: 'dd/mm/yyyy' }),
  ]);
  await setSetting('recap_version', RECAP_VERSION);
  return true;
}

/**
 * Crée les onglets manquants puis met à jour les en-têtes et formules automatiques.
 * Les données et les cases de saisie existantes ne sont jamais écrasées. Renvoie la liste des onglets créés.
 */
export async function ensureStructure({ force = false } = {}) {
  const meta = await gs.getMeta(true);
  const order = [
    SHEETS.PRIX, SHEETS.CHARBONNIERS, SHEETS.SALAIRES, SHEETS.STOCK, SHEETS.CONTRATS, SHEETS.LIVRAISONS,
    SHEETS.CONFIG, SHEETS.ACHATS, SHEETS.NOURRITURE, SHEETS.RECAP, SHEETS.HISTORIQUE,
  ];
  const missing = order.filter((t) => !meta.sheets.has(t));

  const requests = [];
  if (meta.properties.timeZone !== env.tz) {
    requests.push({ updateSpreadsheetProperties: { properties: { timeZone: env.tz }, fields: 'timeZone' } });
  }
  for (const title of missing) {
    requests.push({ addSheet: { properties: { title, gridProperties: { frozenRowCount: title === SHEETS.SALAIRES ? 4 : 1 } } } });
  }
  if (requests.length) {
    await gs.batchUpdate(requests);
    const fresh = await gs.getMeta(true);
    const formats = [];
    for (const title of missing) formats.push(...(await INIT[title](fresh.sheets.get(title).sheetId)));
    await gs.batchUpdate(formats);
  }

  // Mises à jour des formules automatiques (ajoutent les nouvelles colonnes aux Sheets existants).
  // Chaque réécriture force Google à recalculer de grosses formules : on ne le fait que si la structure a changé
  // depuis la dernière fois (empreinte gardée dans Config), si des onglets viennent d'être créés, ou sur demande (/setup).
  await loadSettings();
  const empreinte = createHash('sha1').update(JSON.stringify([
    contratsHeader(), livraisonsHeader(), achatsHeader(), HISTORIQUE_HEADER, NOURRITURE_HEADER, recapStockRows(),
    PRODUCTS, CONTRATS_COLUMNS, RECAP_VERSION,
  ])).digest('hex').slice(0, 16);
  if (!force && !missing.length && getSetting('structure_empreinte') === empreinte) return missing;

  await ensureContratsColumns();
  await ensurePrixRows();
  await gs.write(`${C}!A1:${CONTRATS_LAST}1`, [contratsHeader()], false);
  await gs.write(`${L}!A1:${LIVRAISONS_LAST}1`, [livraisonsHeader()], false);
  await gs.write(`${A}!A1:${ACHATS_LAST}1`, [achatsHeader()]);
  await gs.write(`${gs.q(SHEETS.HISTORIQUE)}!A1:${HISTORIQUE_LAST}1`, [HISTORIQUE_HEADER]);
  await gs.write(`${N}!A1:F1`, [NOURRITURE_HEADER]);
  await writeStockFormulas();
  await setupRecap();
  // Bloc stock du récap réécrit à chaque fois (pas de saisie dedans) : suit les paliers de STOCK_LEVELS
  await gs.write(`${R}!A8:E${7 + PRODUCTS.length}`, recapStockRows(), false);
  await setSetting('structure_empreinte', empreinte);
  return missing;
}
