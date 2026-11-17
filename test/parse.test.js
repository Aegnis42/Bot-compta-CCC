import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantities } from '../src/parse.js';
import { normalizeWeek } from '../src/time.js';

const q = (CP = 0, C = 0, BC = 0, CO = 0, BO = 0) => ({ CP, C, BC, CO, BO });

test('formats courts', () => {
  assert.deepEqual(parseQuantities('300 CP'), q(300));
  assert.deepEqual(parseQuantities('CP 300'), q(300));
  assert.deepEqual(parseQuantities('300cp 50 c'), q(300, 50));
  assert.deepEqual(parseQuantities('CP: 120, BC: 40, CO 10'), q(120, 0, 40, 10));
});

test('noms complets', () => {
  assert.deepEqual(parseQuantities('300 charbons pauvres et 50 briquettes'), q(300, 0, 50));
  assert.deepEqual(parseQuantities('20 charbon, 5 coke'), q(0, 20, 0, 5));
  assert.deepEqual(parseQuantities('5 cock'), q(0, 0, 0, 5));
});

test("pièges", () => {
  assert.deepEqual(parseQuantities("c'est 300 CP"), q(300));
  assert.equal(parseQuantities('bonjour'), null);
  assert.equal(parseQuantities('300'), null);
  assert.equal(parseQuantities('0 CP'), null);
});

test('semaines', () => {
  assert.equal(normalizeWeek('01/10/2026'), '28/09/2026 au 04/10/2026');
  assert.equal(normalizeWeek('28/09/26'), '28/09/2026 au 04/10/2026');
  assert.equal(normalizeWeek('04/10/2026'), '28/09/2026 au 04/10/2026');
  assert.equal(normalizeWeek('05/10/2026'), '05/10/2026 au 11/10/2026');
  // Avant le 16/11/2026 : du lundi au dimanche (inchangé)
  assert.equal(normalizeWeek('15/11/2026'), '09/11/2026 au 15/11/2026');
  // Semaine de transition : du lundi 16 au samedi 21/11/2026
  assert.equal(normalizeWeek('16/11/2026'), '16/11/2026 au 21/11/2026');
  assert.equal(normalizeWeek('21/11/2026'), '16/11/2026 au 21/11/2026');
  // Ensuite : du dimanche au samedi
  assert.equal(normalizeWeek('22/11/2026'), '22/11/2026 au 28/11/2026');
  assert.equal(normalizeWeek('28/11/2026'), '22/11/2026 au 28/11/2026');
  assert.equal(normalizeWeek('29/11/2026'), '29/11/2026 au 05/12/2026');
  assert.equal(normalizeWeek('01/01/2027'), '27/12/2026 au 02/01/2027');
  assert.equal(normalizeWeek('31/02/2026'), null);
  assert.equal(normalizeWeek('abc'), null);
});

test("semaine d'un numéro de série Sheets", async () => {
  const { weekOfSerial } = await import('../src/time.js');
  assert.equal(weekOfSerial(46296.6), '28/09/2026 au 04/10/2026'); // jeudi 01/10/2026 14h24
});

test('formules en paramètres régionaux français', async () => {
  const { localizeFormula } = await import('../src/sheets.js');
  assert.equal(localizeFormula('=IF(A1="a,b",SUM(B1,B2),0)', true), '=IF(A1="a,b";SUM(B1;B2);0)');
  assert.equal(localizeFormula('=SUM(B1,B2)', false), '=SUM(B1,B2)');
  assert.equal(localizeFormula('texte, simple', true), 'texte, simple');
});

test('heure de la paie : samedi (dernier jour de la semaine) à partir de 17h', async () => {
  const { isPayTime } = await import('../src/sync.js');
  assert.equal(isPayTime({ weekday: 6, hour: 17 }), true);
  assert.equal(isPayTime({ weekday: 6, hour: 23 }), true);
  assert.equal(isPayTime({ weekday: 6, hour: 16 }), false);
  assert.equal(isPayTime({ weekday: 0, hour: 17 }), false); // dimanche : nouvelle semaine
  assert.equal(isPayTime({ weekday: 5, hour: 17 }), false);
});

test('bornes de semaine pour l\'historique (semaine de transition de 6 jours)', async () => {
  const { weekBoundsSerial } = await import('../src/time.js');
  const s = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000 + 25569;
  assert.deepEqual(weekBoundsSerial(s(2026, 11, 12)), { start: s(2026, 11, 9), next: s(2026, 11, 16) });
  assert.deepEqual(weekBoundsSerial(s(2026, 11, 18) + 0.6), { start: s(2026, 11, 16), next: s(2026, 11, 22) });
  assert.deepEqual(weekBoundsSerial(s(2026, 11, 25)), { start: s(2026, 11, 22), next: s(2026, 11, 29) });
});

// Les tests lisent la limite et les prix dans la configuration : ils suivent les réglages de src/config.js.

test('niveaux de stock (CP et C uniquement)', async () => {
  const { stockLevel, STOCK_MAX, STOCK_LEVELS } = await import('../src/config.js');
  const [, vert, orange] = STOCK_LEVELS.levels.map((l) => l.min);
  const icon = (code, n) => stockLevel(code, n)?.icon ?? null;
  assert.equal(icon('C', STOCK_MAX), '🔒');
  assert.equal(icon('C', STOCK_MAX - 1), '🟢');
  assert.equal(icon('C', STOCK_MAX + 1200), '🔒');
  assert.equal(icon('CP', vert), '🟢');
  assert.equal(icon('C', vert - 1), '🟠');
  assert.equal(icon('C', orange), '🟠');
  assert.equal(icon('C', orange - 1), '🔴');
  assert.equal(icon('CP', 0), '🔴');
  assert.equal(icon('BC', 50), null);
  assert.equal(icon('CO', 5000), null);
});

test('stock plein : dépôts refusés une fois la limite atteinte (CP et C)', async () => {
  const { overCapacity, STOCK_MAX: M } = await import('../src/config.js');
  const q = (CP = 0, C = 0, BC = 0, CO = 0, BO = 0) => ({ CP, C, BC, CO, BO });
  assert.deepEqual(overCapacity(q(1000), { CP: M - 100 }), []); // dépasse la limite : accepté
  assert.deepEqual(overCapacity(q(10), { CP: M - 1 }), []);
  assert.deepEqual(overCapacity(q(10), { CP: M }), [{ code: 'CP', stock: M }]); // déjà plein : refusé
  assert.deepEqual(overCapacity(q(0, 10), { C: M + 200 }), [{ code: 'C', stock: M + 200 }]);
  assert.deepEqual(overCapacity(q(0, 10), { CP: M + 1, C: 100 }), []); // CP plein mais rien déposé en CP
  assert.deepEqual(overCapacity(q(0, 0, 9999, 9999), { BC: 9000, CO: 9000 }), []); // BC/CO sans plafond
});

test('accès staff : compte autorisé, admins, rôle staff', async () => {
  const { isStaff } = await import('../src/commands.js');
  const member = (id, { admin = false, roles = [] } = {}) => ({
    id, permissions: { has: () => admin }, roles: { cache: { has: (r) => roles.includes(r) } },
  });
  assert.equal(isStaff(member('1222839727934279692')), true);
  assert.equal(isStaff(member('42', { admin: true })), true);
  assert.equal(isStaff(member('42')), false);
  assert.equal(isStaff(member('42', { roles: ['1551416821998161990'] })), true); // rôle autorisé
  assert.equal(isStaff(member('42', { roles: ['999'] })), false);
  assert.equal(isStaff(null), false);
});

test('valeur de rachat avec bonus par unité', async () => {
  const { rachatValue } = await import('../src/prices.js');
  const { PRODUCTS } = await import('../src/config.js');
  const r = Object.fromEntries(PRODUCTS.map((p) => [p.code, p.rachat]));
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} ≠ ${b}`);
  near(rachatValue({ CP: 300, C: 0, BC: 0, CO: 0 }), 300 * r.CP);
  near(rachatValue({ CP: 300, C: 0, BC: 0, CO: 0 }, 0.1), 300 * (r.CP + 0.1));
  near(rachatValue({ CP: 0, C: 100, BC: 10, CO: 1 }, 0.1), 100 * (r.C + 0.1) + 10 * (r.BC + 0.1) + (r.CO + 0.1));
});

test('prix de vente d\'un contrat : prix perso sinon tarif', async () => {
  const { contractUnitPrice, contractValue } = await import('../src/prices.js');
  const { PRODUCTS } = await import('../src/config.js');
  const p = Object.fromEntries(PRODUCTS.map((x) => [x.code, x]));
  const ct = { tarif: 'Chatelerie', prixPerso: { CP: 0.9, C: null, BC: null, CO: null } };
  assert.equal(contractUnitPrice(ct, 'CP'), 0.9); // prix perso
  assert.equal(contractUnitPrice(ct, 'C'), p.C.chatelerie); // tarif Chatelerie
  assert.equal(contractUnitPrice({ tarif: 'Normal', prixPerso: {} }, 'CO'), p.CO.normal);
  assert.ok(Math.abs(contractValue({ CP: 100, C: 10, BC: 0, CO: 0 }, ct) - (100 * 0.9 + 10 * p.C.chatelerie)) < 0.005);
});

test('historique : chiffres d\'une semaine (mêmes règles que le récap)', async () => {
  const { weekFigures } = await import('../src/historique.js');
  const lundi = 46293; // 28/09/2026
  const data = {
    livraisons: [[lundi + 1.5, 'CT-1', '', '', '', '', 5000], [lundi + 8, 'CT-2', '', '', '', '', 999]], // 2e : semaine suivante
    achats: [[lundi + 2, 'X', '', '', '', '', 1000]],
    nourriture: [[lundi + 3, 350]],
    tabs: [
      { rows: [[lundi + 1, '', 100, '', '', '', 2000]] },
      { rows: [[lundi + 6.9, '', 10, '', '', '', 6]] },
      { rows: [[lundi - 1, '', 10, '', '', '', 6]] }, // semaine précédente : ne compte pas
    ],
  };
  const f = weekFigures(lundi, data, { gestion: 0.4, clan: 0.1, citoyen: 50, taxe: 0.2 });
  assert.equal(f.ca, 5000);
  assert.equal(f.rachat, 2006);
  assert.equal(f.cout, 3006);
  assert.equal(f.benefice, 1994);
  assert.equal(f.gestion, 797.6);
  assert.equal(f.clan, 199.4);
  assert.equal(f.fournisseurs, 2);
  assert.equal(f.citoyennete, 100);
  assert.equal(f.final, 547); // 1994 − 797,6 − 199,4 − 100 − 350
  assert.equal(f.taxe, 109.4);
  assert.equal(f.bat, 437.6);
});

test('citoyenneté : seuls les charbonniers marqués OUI comptent', async () => {
  const { weekFigures } = await import('../src/historique.js');
  const lundi = 46293;
  const data = {
    livraisons: [], achats: [], nourriture: [],
    tabs: [
      { c: { citoyennete: true }, rows: [[lundi + 1, '', 10, '', '', '', 6]] },
      { c: { citoyennete: false }, rows: [[lundi + 1, '', 10, '', '', '', 6]] },
    ],
  };
  const f = weekFigures(lundi, data, { gestion: 0.4, clan: 0.1, citoyen: 50, taxe: 0.2 });
  assert.equal(f.fournisseurs, 1);
  assert.equal(f.citoyennete, 50);
  assert.equal(f.rachat, 12); // le rachat reste payé à tous
});

test('plafond hebdomadaire : salaire plafonné, surplus = don', async () => {
  const { withPlafond, plafondNotice } = await import('../src/charbonniers.js');
  const c = { plafond: 600 };
  const s = (montant) => withPlafond({ montant, count: 1 }, c);
  assert.deepEqual([s(500).montant, s(500).don], [500, 0]);
  assert.deepEqual([s(720).montant, s(720).don], [600, 120]);
  assert.equal(plafondNotice(s(500), 100), null); // sous le plafond
  assert.equal(plafondNotice(s(600), 100), null); // pile au plafond
  assert.match(plafondNotice(s(720), 200), /dépassé.*120 septimes/s); // 520 → 720 : 120 dépassent
  assert.match(plafondNotice(s(800), 100), /déjà atteint.*don à l'entreprise/s); // 700 → 800 : tout le dépôt est un don
  assert.equal(withPlafond({ montant: 5000 }, { plafond: 1000 }).montant, 1000);
});

test('accès staff : comptes admin ajoutés', async () => {
  const { isStaff } = await import('../src/access.js');
  const member = (id) => ({ id, permissions: { has: () => false }, roles: { cache: { has: () => false } } });
  for (const id of ['1548025252146053201', '386606897236672533', '825110608860676177']) assert.equal(isStaff(member(id)), true);
});

test('rachat bloquable : seulement la Briquette et le Coke', async () => {
  const { lockIcon, blockedIn, blockedMessage, BLOCKABLE } = await import('../src/rachat.js');
  assert.deepEqual(BLOCKABLE, ['BC', 'CO']);
  assert.equal(lockIcon('BC'), '🔓'); // rien de bloqué par défaut
  assert.equal(lockIcon('CP'), ''); // pas de cadenas pour le charbon
  assert.deepEqual(blockedIn({ CP: 10, C: 0, BC: 5, CO: 0 }), []);
  assert.match(blockedMessage(['CO']), /🔒 \*\*Rachat bloqué.*Coke \(CO\)/s);
});

test('bois : lu dans les messages, au prix de rachat 0,1', async () => {
  const { parseQuantities } = await import('../src/parse.js');
  const { rachatValue, contractUnitPrice } = await import('../src/prices.js');
  assert.deepEqual(parseQuantities('300 CP 200 bois'), q(300, 0, 0, 0, 200));
  assert.deepEqual(parseQuantities('BO 50'), q(0, 0, 0, 0, 50));
  assert.equal(parseQuantities('bonjour, boisson'), null);
  assert.equal(rachatValue(q(0, 0, 0, 0, 1000)), 100);
  assert.equal(contractUnitPrice({ tarif: 'Chatelerie', prixPerso: {} }, 'BO'), 0.1); // membre de la CCC
  assert.equal(contractUnitPrice({ tarif: 'Normal', prixPerso: {} }, 'BO'), 0.2); // autres
});

test('colonnes : le bois après les colonnes existantes, sans rien décaler', async () => {
  const { COLMAP, colIndex, colLetter, qtyAt } = await import('../src/columns.js');
  assert.deepEqual([COLMAP.depot.CO, COLMAP.depot.BO, COLMAP.commande.BO, COLMAP.prixPerso.BO], ['F', 'L', 'AE', 'AH']);
  assert.equal(colIndex('AH'), 33);
  assert.equal(colLetter(33), 'AH');
  const row = []; row[2] = 5; row[11] = 40; // C = 5 CP, L = 40 bois
  assert.deepEqual(qtyAt(row, 'depot'), q(5, 0, 0, 0, 40));
});

test('même semaine : comparaison par date de début (passage au dimanche)', async () => {
  const { sameWeek } = await import('../src/time.js');
  assert.equal(sameWeek('16/11/2026 au 22/11/2026', '16/11/2026 au 21/11/2026'), true);
  assert.equal(sameWeek('09/11/2026 au 15/11/2026', '16/11/2026 au 21/11/2026'), false);
  assert.equal(sameWeek(null, '16/11/2026 au 21/11/2026'), false);
});
