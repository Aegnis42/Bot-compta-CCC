import 'dotenv/config';

// Valeur nettoyée : espaces, retours à la ligne et guillemets collés par erreur (ex. dans Railway)
const clean = (v) => String(v ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

export const env = {
  token: clean(process.env.DISCORD_TOKEN),
  // Seul serveur sur lequel le bot fonctionne (volontairement fixé dans le code, pas de variable d'environnement)
  guildId: '1550407272247599175',
  appsScriptUrl: clean(process.env.APPS_SCRIPT_URL),
  appsScriptSecret: clean(process.env.APPS_SCRIPT_SECRET),
  categoryId: process.env.CHARBONNIER_CATEGORY_ID || null,
  staffRoleId: process.env.STAFF_ROLE_ID || null,
  // Comptes Discord autorisés à utiliser toutes les commandes, en plus des admins (« Gérer le serveur »)
  adminIds: [...new Set(['1222839727934279692', ...String(process.env.ADMIN_IDS ?? '').split(/[\s,;]+/)].filter(Boolean))],
  recapChannelId: process.env.RECAP_CHANNEL_ID || null,
  syncInterval: Math.max(15, Number(process.env.SYNC_INTERVAL_SECONDS) || 30),
  tz: process.env.TIMEZONE || 'Europe/Paris',
  currency: 'septimes',
};

// Ordre = ordre des colonnes partout dans le Google Sheet.
// Les prix ci-dessous ne servent qu'à initialiser l'onglet "Prix" : ensuite c'est le Sheet qui fait foi.
export const PRODUCTS = [
  { code: 'CP', name: 'Charbon Pauvre', rachat: 0.6, normal: 1, chatelerie: 0.8 },
  { code: 'C', name: 'Charbon', rachat: 1.2, normal: 2, chatelerie: 1.5 },
  { code: 'BC', name: 'Briquette', rachat: 1.8, normal: 3, chatelerie: 2.5 },
  { code: 'CO', name: 'Coke', rachat: 3.2, normal: 6, chatelerie: 5 },
];
export const CODES = PRODUCTS.map((p) => p.code);

// Avis de paie : jour (0 = dimanche) et heure (fuseau TIMEZONE) où chaque charbonnier est prévenu dans son salon
export const PAIE = { weekday: 0, hour: 17, lieu: 'aux locaux de la CCC' };

// Niveaux de stock affichés sur Discord (salons vocaux, tableau, /stock). Du plus haut au plus bas : le premier
// palier atteint l'emporte (ex : 2500 → 🟢). Produits non listés : pas d'indicateur.
export const STOCK_LEVELS = {
  codes: ['CP', 'C'],
  levels: [
    { min: 6000, icon: '🔒', label: 'stock plein' },
    { min: 2000, icon: '🟢', label: 'bon niveau' },
    { min: 1000, icon: '🟠', label: 'niveau moyen' },
    { min: -Infinity, icon: '🔴', label: 'stock bas' },
  ],
};

/** Palier de stock d'un produit, ou null s'il n'a pas d'indicateur. */
export const stockLevel = (code, qty) =>
  STOCK_LEVELS.codes.includes(code) ? STOCK_LEVELS.levels.find((l) => qty >= l.min) : null;

/** Stock maximum (palier 🔒) : une fois atteint, les dépôts de ces produits sont refusés. */
export const STOCK_MAX = STOCK_LEVELS.levels[0].min;

/**
 * Produits déposés alors que leur stock a déjà atteint le maximum (🔒).
 * Un dépôt qui fait dépasser le maximum reste accepté : seul le stock déjà plein bloque.
 * stock = { CP: 4100, ... } (stock actuel). Renvoie [{ code, stock }].
 */
export function overCapacity(qty, stock) {
  return STOCK_LEVELS.codes
    .filter((code) => qty[code] > 0 && (stock[code] ?? 0) >= STOCK_MAX)
    .map((code) => ({ code, stock: stock[code] ?? 0 }));
}

// Bonus de rachat par défaut (en septimes par unité, sur CP, C, BC et CO) pour certains comptes Discord.
// Il est recopié dans la colonne « Bonus rachat » de l'onglet Charbonniers, où il peut ensuite être modifié.
export const BONUS_RACHAT = {
  montant: 0.1,
  ids: ['1222839727934279692', '129187703173545984', '422140892212887553', '713178170534133862', '209679108861329408'],
};

export const TARIFS = { normal: 'Normal', chatelerie: 'Chatelerie' };

export const SHEETS = {
  PRIX: 'Prix',
  CHARBONNIERS: 'Charbonniers',
  SALAIRES: 'Salaires',
  STOCK: 'Stock',
  CONTRATS: 'Contrats',
  LIVRAISONS: 'Livraisons',
  CONFIG: 'Config',
  ACHATS: 'Achats',
  NOURRITURE: 'Nourriture',
  RECAP: 'Feuille 1',
  HISTORIQUE: 'Historique',
};
