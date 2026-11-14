import { PRODUCTS } from './config.js';
import { getSetting, setSetting } from './settings.js';

// Blocage du rachat de certains produits (Briquette, Coke) : quand c'est bloqué, les charbonniers ne peuvent
// plus en déposer. État gardé dans l'onglet Config (rachat_bloque_BC / rachat_bloque_CO = OUI ou NON).

export const BLOCKABLE = ['BC', 'CO'];
const key = (code) => `rachat_bloque_${code}`;
const nameOf = (code) => PRODUCTS.find((p) => p.code === code)?.name ?? code;

export const isBlocked = (code) => BLOCKABLE.includes(code) && getSetting(key(code)) === 'OUI';

/** Cadenas à afficher : 🔒 bloqué, 🔓 débloqué, '' pour les produits sans blocage possible. */
export const lockIcon = (code) => (BLOCKABLE.includes(code) ? (isBlocked(code) ? '🔒' : '🔓') : '');

export async function setBlocked(code, blocked) {
  if (!BLOCKABLE.includes(code)) throw new Error(`Le rachat de ${code} ne peut pas être bloqué.`);
  await setSetting(key(code), blocked ? 'OUI' : 'NON');
}

/** Produits du dépôt dont le rachat est bloqué. */
export const blockedIn = (qty) => BLOCKABLE.filter((code) => qty[code] > 0 && isBlocked(code));

export const blockedMessage = (codes) => [
  `🔒 **Rachat bloqué pour le moment** : ${codes.map((c) => `${nameOf(c)} (${c})`).join(', ')}.`,
  `Rien n'a été enregistré. Retire ${codes.length > 1 ? 'ces produits' : 'ce produit'} de ton dépôt, ou attends le déblocage 🔓.`,
].join('\n');

/** Résumé de l'état, ex : « Briquette 🔓 · Coke 🔒 ». */
export const blockSummary = () => BLOCKABLE.map((c) => `${nameOf(c)} ${lockIcon(c)}`).join(' · ');
