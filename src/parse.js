import { emptyQty, hasQty } from './utils.js';

const ALIASES = [
  [/CHARBONS?\s+PAUVRES?/g, ' CP '],
  [/\bBRIQUETTES?\b/g, ' BC '],
  [/\bCO(?:KE|CK|QUE)S?\b/g, ' CO '],
  [/\bCHARBONS?\b/g, ' C '],
];

const TOKEN = /(\d+)|(?<![A-Z])(CP|BC|CO|C)(?![A-Z'’])/g;

/**
 * Extrait les quantités d'un message libre.
 * Ex : "300 CP", "CP 300", "300 charbon pauvre et 50 briquettes", "120cp 40 co".
 * Renvoie null si aucune quantité n'est trouvée.
 */
export function parseQuantities(text) {
  let t = ` ${String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()} `;
  for (const [re, rep] of ALIASES) t = t.replace(re, rep);

  const tokens = [...t.matchAll(TOKEN)].map((m) => (m[1] ? { n: parseInt(m[1], 10) } : { code: m[2] }));
  // On essaie "300 CP" puis "CP 300" en priorité, et on garde le sens qui forme le plus de paires
  // ("CP 120 BC 40" ne doit pas devenir "120 BC, 40 ...").
  const numFirst = pairUp(tokens, ['num', 'code']);
  const codeFirst = pairUp(tokens, ['code', 'num']);
  const best = codeFirst.count > numFirst.count ? codeFirst : numFirst;
  return hasQty(best.qty) ? best.qty : null;
}

function pairUp(tokens, order) {
  const used = new Set();
  const qty = emptyQty();
  let count = 0;
  const isNum = (t) => t.n !== undefined;
  for (const [first, second] of [order, [...order].reverse()]) {
    for (let i = 0; i < tokens.length - 1; i++) {
      if (used.has(i) || used.has(i + 1)) continue;
      const [a, b] = [tokens[i], tokens[i + 1]];
      if ((first === 'num') !== isNum(a) || (second === 'num') !== isNum(b)) continue;
      const [n, code] = isNum(a) ? [a.n, b.code] : [b.n, a.code];
      qty[code] += n;
      used.add(i).add(i + 1);
      count++;
    }
  }
  return { qty, count };
}
