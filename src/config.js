import 'dotenv/config';

// Valeur nettoyée : espaces, retours à la ligne et guillemets collés par erreur (ex. dans Railway)
const clean = (v) => String(v ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

export const env = {
  token: clean(process.env.DISCORD_TOKEN),
  guildId: process.env.DISCORD_GUILD_ID || '1555109924265005087',
  appsScriptUrl: clean(process.env.APPS_SCRIPT_URL),
  appsScriptSecret: clean(process.env.APPS_SCRIPT_SECRET),
  categoryId: process.env.CHARBONNIER_CATEGORY_ID || null,
  staffRoleId: process.env.STAFF_ROLE_ID || null,
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

export const TARIFS = { normal: 'Normal', chatelerie: 'Chatelerie' };

export const SHEETS = {
  PRIX: 'Prix',
  CHARBONNIERS: 'Charbonniers',
  SALAIRES: 'Salaires',
  STOCK: 'Stock',
  CONTRATS: 'Contrats',
  LIVRAISONS: 'Livraisons',
  CONFIG: 'Config',
};
