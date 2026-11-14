import { PRODUCTS } from './config.js';
import { num } from './utils.js';

// Colonne de chaque produit dans chaque onglet. Les 4 premiers produits (CP, C, BC, CO) gardent leurs
// colonnes d'origine ; les produits ajoutés ensuite (Bois…) sont placés APRÈS les colonnes existantes,
// pour ne jamais décaler les données déjà présentes dans le Sheet.
const ORIGINE = 4;
const place = (origine, ajouts) => Object.fromEntries(PRODUCTS.map((p, i) => [p.code, i < ORIGINE ? origine[i] : ajouts[i - ORIGINE]]));

export const COLMAP = {
  depot: place(['C', 'D', 'E', 'F'], ['L', 'M', 'N']), // onglets des charbonniers
  livraison: place(['C', 'D', 'E', 'F'], ['J', 'K', 'L']), // Livraisons
  achat: place(['C', 'D', 'E', 'F'], ['K', 'L', 'M']), // Achats
  commande: place(['E', 'F', 'G', 'H'], ['AE', 'AI', 'AM']), // Contrats : quantités commandées
  livre: place(['I', 'J', 'K', 'L'], ['AF', 'AJ', 'AN']), // Contrats : livré (formule)
  reste: place(['M', 'N', 'O', 'P'], ['AG', 'AK', 'AO']), // Contrats : reste (formule)
  prixPerso: place(['X', 'Y', 'Z', 'AA'], ['AH', 'AL', 'AP']), // Contrats : prix de vente perso par unité
};

/** Index (0 = A) d'une lettre de colonne : A → 0, Z → 25, AA → 26. */
export const colIndex = (letter) => [...letter].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Lettre d'une colonne à partir de son index (0 = A). */
export const colLetter = (index) => {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** Colonnes d'un onglet dans l'ordre des produits (comme l'ancien tableau COLS). */
export const colsOf = (sheet) => PRODUCTS.map((p) => COLMAP[sheet][p.code]);

/** Dernière colonne utilisée par les produits dans un onglet (pour dimensionner les plages lues). */
export const lastProductCol = (sheet) => Math.max(...colsOf(sheet).map(colIndex));

/** Quantités de chaque produit lues dans une ligne (tableau de valeurs) d'un onglet. */
export const qtyAt = (row, sheet) => Object.fromEntries(PRODUCTS.map((p) => [p.code, num(row?.[colIndex(COLMAP[sheet][p.code])])]));

/** Écritures (pour gs.writeMany) des quantités d'un produit à l'autre, cellule par cellule, sur une ligne. */
export const qtyWrites = (sheetTitle, sheet, row, qty) =>
  PRODUCTS.map((p) => ({ range: `${sheetTitle}!${COLMAP[sheet][p.code]}${row}`, values: [[qty[p.code] || '']] }));
