import { env, PRODUCTS, SHEETS, TARIFS } from './config.js';
import * as gs from './sheets.js';

const P = gs.q(SHEETS.PRIX);
const C = gs.q(SHEETS.CONTRATS);
const L = gs.q(SHEETS.LIVRAISONS);

// Colonnes des quantités (CP, C, BC, CO) dans chaque onglet
export const COLS = {
  depot: ['C', 'D', 'E', 'F'], // onglets charbonniers
  livraison: ['C', 'D', 'E', 'F'], // Livraisons
  commande: ['E', 'F', 'G', 'H'], // Contrats
  livre: ['I', 'J', 'K', 'L'], // Contrats
  reste: ['M', 'N', 'O', 'P'], // Contrats
  prixPerso: ['X', 'Y', 'Z', 'AA'], // Contrats : prix de vente personnalisé par unité (vide = tarif)
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
    arr(`Coût matériaux (${env.currency})`, `ROUND(${PRODUCTS.map((_, i) => `${cmd(i)}*${P}!$C$${i + 2}`).join('+')},2)`),
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
    await gs.write(`${S}!A1:H${PRODUCTS.length + 1}`, [
      ['Produit', 'Code', 'Déposé (charbonniers)', 'Ajustement manuel', 'Livré (contrats)', 'Stock actuel', 'Reste à livrer (contrats)', 'À produire'],
      ...PRODUCTS.map((p, i) => {
        const r = i + 2;
        const lc = COLS.livraison[i];
        const rc = COLS.reste[i];
        return [
          p.name, p.code,
          0, // reconstruit par le bot (somme des onglets charbonniers)
          0,
          `=SUM(${L}!${lc}2:${lc})`,
          `=C${r}+D${r}-E${r}`,
          `=SUMIFS(${C}!${rc}2:${rc},${C}!S2:S,"<>Annulé",${C}!${rc}2:${rc},">0")`,
          `=MAX(0,G${r}-F${r})`,
        ];
      }),
    ], false);
    await gs.write(`${S}!A${PRODUCTS.length + 3}`, [['Colonne D : à remplir à la main pour corriger le stock (achat, perte, inventaire...). Les autres colonnes sont automatiques.']]);
    return [gs.headerFormat(sheetId)];
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
 * Crée les onglets manquants (Prix, Charbonniers, Salaires, Stock, Contrats, Livraisons).
 * N'écrase jamais un onglet existant. Renvoie la liste des onglets créés.
 */
export async function ensureStructure() {
  const meta = await gs.getMeta(true);
  const order = [SHEETS.PRIX, SHEETS.CHARBONNIERS, SHEETS.SALAIRES, SHEETS.STOCK, SHEETS.CONTRATS, SHEETS.LIVRAISONS, SHEETS.CONFIG];
  const missing = order.filter((t) => !meta.sheets.has(t));

  const requests = [];
  if (meta.properties.timeZone !== env.tz) {
    requests.push({ updateSpreadsheetProperties: { properties: { timeZone: env.tz }, fields: 'timeZone' } });
  }
  for (const title of missing) {
    requests.push({ addSheet: { properties: { title, gridProperties: { frozenRowCount: title === SHEETS.SALAIRES ? 4 : 1 } } } });
  }
  // En-têtes des contrats et livraisons toujours remis à jour (ajoute les nouvelles colonnes aux anciens Sheets)
  if (meta.sheets.has(SHEETS.CONTRATS)) {
    await ensureContratsColumns();
    await gs.write(`${C}!A1:AA1`, [contratsHeader()], false);
  }
  if (meta.sheets.has(SHEETS.LIVRAISONS)) await gs.write(`${L}!A1:I1`, [livraisonsHeader()], false);
  if (!requests.length) return [];
  await gs.batchUpdate(requests);
  const fresh = await gs.getMeta(true);

  const formats = [];
  for (const title of missing) formats.push(...(await INIT[title](fresh.sheets.get(title).sheetId)));
  await gs.batchUpdate(formats);
  return missing;
}
