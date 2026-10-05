import { env, PRODUCTS, SHEETS, TARIFS, STOCK_LEVELS } from './config.js';
import * as gs from './sheets.js';
import { loadSettings, getSetting, setSetting } from './settings.js';

const P = gs.q(SHEETS.PRIX);
const C = gs.q(SHEETS.CONTRATS);
const L = gs.q(SHEETS.LIVRAISONS);
const A = gs.q(SHEETS.ACHATS);
const N = gs.q(SHEETS.NOURRITURE);
const R = gs.q(SHEETS.RECAP);

// Colonnes des quantités (CP, C, BC, CO) dans chaque onglet
export const COLS = {
  depot: ['C', 'D', 'E', 'F'], // onglets charbonniers
  livraison: ['C', 'D', 'E', 'F'], // Livraisons
  commande: ['E', 'F', 'G', 'H'], // Contrats
  livre: ['I', 'J', 'K', 'L'], // Contrats
  reste: ['M', 'N', 'O', 'P'], // Contrats
  prixPerso: ['X', 'Y', 'Z', 'AA'], // Contrats : prix de vente personnalisé par unité (vide = tarif)
  achat: ['C', 'D', 'E', 'F'], // Achats extérieurs
};

// Nombre de colonnes de l'onglet Contrats (A → AA)
const CONTRATS_COLUMNS = 27;

// Ligne de début des données dans "Salaires"
export const SALAIRES_FIRST_ROW = 5;

/** Formule donnant la semaine (lundi → dimanche) contenant la date `d` : "28/09/2026 au 04/10/2026". */
export const weekFormula = (d) =>
  `TEXT(INT(${d})-WEEKDAY(${d},2)+1,"dd/mm/yyyy")&" au "&TEXT(INT(${d})-WEEKDAY(${d},2)+7,"dd/mm/yyyy")`;

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
  return [
    'ID', 'Date', 'Client', `Tarif (${TARIFS.normal}/${TARIFS.chatelerie})`,
    ...PRODUCTS.map((p) => `${p.code} commandé`),
    ...PRODUCTS.map((p, i) => arr(`${p.code} livré`, `SUMIF(${L}!B2:B,A2:A,${L}!${COLS.livraison[i]}2:${COLS.livraison[i]})`)),
    ...PRODUCTS.map((p, i) => arr(`${p.code} reste`, `${cmd(i)}-${COLS.livre[i]}2:${COLS.livre[i]}`)),
    arr(`Prix client (${env.currency})`, `ROUND(${PRODUCTS.map((_, i) => `${cmd(i)}*${sellPrice(i, 'D2:D', contractCustom(i))}`).join('+')},2)`),
    arr(`Montant livré (${env.currency})`, `ROUND(${PRODUCTS.map((_, i) => `${COLS.livre[i]}2:${COLS.livre[i]}*${sellPrice(i, 'D2:D', contractCustom(i))}`).join('+')},2)`),
    arr('Statut', `IF(UPPER(T2:T)="OUI","Annulé",IF(${COLS.reste.map((c) => `(${c}2:${c}<=0)`).join('*')},"Livré",IF(${COLS.livre.map((c) => `${c}2:${c}`).join('+')}>0,"Partiel","En attente")))`),
    'Annulé (OUI)', 'Note',
    // Coût matériaux = achats extérieurs rattachés au contrat (prix payé)
    //                 + le reste des quantités commandées au prix de rachat des charbonniers
    arr(`Coût matériaux (${env.currency})`, `ROUND(${PRODUCTS.map((_, i) => {
      const bought = `SUMIF(${A}!H2:H,A2:A,${A}!${COLS.achat[i]}2:${COLS.achat[i]})`;
      return `IF(${cmd(i)}-${bought}>0,${cmd(i)}-${bought},0)*${P}!$C$${i + 2}`;
    }).join('+')}+SUMIF(${A}!H2:H,A2:A,${A}!G2:G),2)`),
    arr(`Bénéfice (${env.currency})`, 'Q2:Q-V2:V'),
    ...PRODUCTS.map((p) => `Prix perso ${p.code} (${env.currency}/unité)`),
  ];
}

/** En-tête de l'onglet Livraisons : montant au prix du contrat (prix perso ou tarif). */
function livraisonsHeader() {
  const look = (col) => `IFERROR(VLOOKUP(B2:B,${C}!A:AA,${col},FALSE),"")`;
  const montant = `={"Montant (${env.currency})";ARRAYFORMULA(IF(B2:B="","",IFERROR(ROUND(${PRODUCTS.map((_, i) => `${COLS.livraison[i]}2:${COLS.livraison[i]}*${sellPrice(i, look(4), look(24 + i))}`).join('+')},2),"?")))}`;
  return ['Date', 'Contrat', ...PRODUCTS.map((p) => p.code), montant, 'Par', 'Note'];
}

/** Ajoute les colonnes manquantes de l'onglet Contrats (prix perso jusqu'à AA). */
async function ensureContratsColumns() {
  const p = await gs.sheetProps(SHEETS.CONTRATS);
  if (p.gridProperties.columnCount >= CONTRATS_COLUMNS) return;
  await gs.batchUpdate([{ appendDimension: { sheetId: p.sheetId, dimension: 'COLUMNS', length: CONTRATS_COLUMNS - p.gridProperties.columnCount } }]);
  await gs.getMeta(true);
}

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
    await gs.write(`${S}!A4:G4`, [['Charbonnier', ...PRODUCTS.map((p) => p.code), `Salaire dû (${env.currency})`, 'Statut']]);
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
    await gs.write(`${A}!A1:J1`, [[
      'Date', 'Fournisseur', ...PRODUCTS.map((p) => p.code), `Prix payé (${env.currency})`, 'Contrat (optionnel)', 'Par', 'Note',
    ]]);
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 0, gs.DATE_TIME)];
  },

  async [SHEETS.NOURRITURE](sheetId) {
    await gs.write(`${N}!A1:D1`, [['Date', `Montant (${env.currency})`, 'Note', 'Par']]);
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 0, gs.DATE_TIME)];
  },

  async [SHEETS.RECAP]() {
    return []; // mise en page faite par setupRecap()
  },

  async [SHEETS.CONTRATS](sheetId) {
    await ensureContratsColumns();
    await gs.write(`${C}!A1:AA1`, [contratsHeader()], false);
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
    await gs.write(`${L}!A1:I1`, [livraisonsHeader()], false);
    return [gs.headerFormat(sheetId), gs.columnFormat(sheetId, 0, gs.DATE_TIME)];
  },
};

/**
 * Formules automatiques de l'onglet Stock (colonnes E à I). Les colonnes C (reconstruite par le bot)
 * et D (ajustement manuel) ne sont jamais touchées.
 * Stock actuel = déposé par les charbonniers + ajustement manuel + acheté à l'extérieur − livré.
 */
async function writeStockFormulas() {
  const S = gs.q(SHEETS.STOCK);
  await gs.writeMany([
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

const RECAP_VERSION = '1';
const WEEK_RANGE = (col) => `${col},">="&$Z$1,${col},"<"&$Z$2`; // critères SUMIFS « dans la semaine affichée »

/**
 * Formules du récap qui dépendent de la liste des charbonniers (réécrites par rebuildFormulas) :
 * H8 = rachat payé aux charbonniers sur la semaine, J14 = nombre de charbonniers ayant fourni du charbon.
 */
export function recapDynamicWrites(list) {
  const tabs = list.map((c) => gs.q(c.tab));
  const rachat = tabs.length ? `=${tabs.map((t) => `SUMIFS(${t}!G2:G,${WEEK_RANGE(`${t}!A2:A`)})`).join('+')}` : 0;
  const count = tabs.length ? `=${tabs.map((t) => `(COUNTIFS(${WEEK_RANGE(`${t}!A2:A`)},${t}!G2:G,">0")>0)*1`).join('+')}` : 0;
  return [
    { range: `${R}!H8`, values: [[rachat]] },
    { range: `${R}!J14`, values: [[count]] },
  ];
}

/**
 * Met en page le récapitulatif sur « Feuille 1 », une seule fois (version notée dans Config).
 * Si la feuille contenait déjà quelque chose, elle est d'abord copiée dans « Feuille 1 (ancienne) ».
 * Les cases de saisie (semaine, trésorerie, pourcentages) ne sont plus jamais réécrites ensuite.
 */
async function setupRecap() {
  await loadSettings();
  if (getSetting('recap_version') === RECAP_VERSION) return false;

  const props = await gs.sheetProps(SHEETS.RECAP);
  const existing = await gs.read(`${R}!A1:Z100`);
  if (existing.some((row) => row.some((v) => v !== ''))) {
    const backup = `${SHEETS.RECAP} (ancienne)`;
    if (!(await gs.getMeta(true)).sheets.has(backup)) {
      await gs.batchUpdate([{ duplicateSheet: { sourceSheetId: props.sheetId, newSheetName: backup, insertSheetIndex: 1 } }]);
    }
    await gs.batchUpdate([{ updateCells: { range: { sheetId: props.sheetId }, fields: 'userEnteredValue,userEnteredFormat' } }]);
  }

  const S = gs.q(SHEETS.STOCK);
  const lv = STOCK_LEVELS.levels;
  const levelFormula = (cell) =>
    `=IF(${cell}>=${lv[0].min},"${lv[0].icon}",IF(${cell}>=${lv[1].min},"${lv[1].icon}",IF(${cell}>=${lv[2].min},"${lv[2].icon}","${lv[3].icon}")))`;
  const stockRows = PRODUCTS.map((p, i) => {
    const r = i + 2;
    return [`=${S}!A${r}`, `=${S}!F${r}`, STOCK_LEVELS.codes.includes(p.code) ? levelFormula(`B${8 + i}`) : '', `=${S}!G${r}`, `=${S}!H${r}`];
  });
  const sumWeek = (sheet, col) => `=SUMIFS(${sheet}!${col}2:${col},${WEEK_RANGE(`${sheet}!A2:A`)})`;

  await gs.writeMany([
    { range: `${R}!A1`, values: [['📊 Récapitulatif de la CCC']] },
    { range: `${R}!A3:C4`, values: [
      ['Semaine à afficher', '', '← une date de la semaine voulue (vide = semaine en cours)'],
      ['Semaine affichée', '=TEXT($Z$1,"dd/mm/yyyy")&" au "&TEXT($Z$1+6,"dd/mm/yyyy")', ''],
    ] },
    { range: `${R}!Z1:Z2`, values: [['=INT(IF($B$3="",TODAY(),$B$3))-WEEKDAY(IF($B$3="",TODAY(),$B$3),2)+1'], ['=$Z$1+7']] },

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
    bold(0, 1, 0, 1), bold(2, 4, 0, 1), bold(5, 7, 0, 5), bold(5, 6, 6, 9), bold(12, 13, 0, 1),
    bold(10, 11, 6, 8), bold(15, 16, 6, 8), bold(17, 18, 6, 8),
    fmt(2, 3, 1, 2, { type: 'DATE', pattern: 'dd/mm/yyyy' }),
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
export async function ensureStructure() {
  const meta = await gs.getMeta(true);
  const order = [
    SHEETS.PRIX, SHEETS.CHARBONNIERS, SHEETS.SALAIRES, SHEETS.STOCK, SHEETS.CONTRATS, SHEETS.LIVRAISONS,
    SHEETS.CONFIG, SHEETS.ACHATS, SHEETS.NOURRITURE, SHEETS.RECAP,
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

  // Mises à jour des formules automatiques (ajoutent les nouvelles colonnes aux Sheets existants)
  await ensureContratsColumns();
  await gs.write(`${C}!A1:AA1`, [contratsHeader()], false);
  await gs.write(`${L}!A1:I1`, [livraisonsHeader()], false);
  await writeStockFormulas();
  await setupRecap();
  return missing;
}
