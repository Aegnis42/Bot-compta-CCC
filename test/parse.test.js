import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantities } from '../src/parse.js';
import { normalizeWeek } from '../src/time.js';

const q = (CP = 0, C = 0, BC = 0, CO = 0) => ({ CP, C, BC, CO });

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
  assert.equal(normalizeWeek('01/01/2027'), '28/12/2026 au 03/01/2027');
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

test('heure de la paie : dimanche à partir de 17h', async () => {
  const { isPayTime } = await import('../src/sync.js');
  assert.equal(isPayTime({ weekday: 0, hour: 17 }), true);
  assert.equal(isPayTime({ weekday: 0, hour: 23 }), true);
  assert.equal(isPayTime({ weekday: 0, hour: 16 }), false);
  assert.equal(isPayTime({ weekday: 1, hour: 17 }), false);
  assert.equal(isPayTime({ weekday: 6, hour: 17 }), false);
});

// Les tests lisent la limite et les prix dans la configuration : ils suivent les réglages de src/config.js.

test('niveaux de stock (CP et C uniquement)', async () => {
  const { stockLevel, STOCK_MAX } = await import('../src/config.js');
  const icon = (code, n) => stockLevel(code, n)?.icon ?? null;
  assert.equal(icon('C', STOCK_MAX), '🔒');
  assert.equal(icon('C', STOCK_MAX - 1), '🟢');
  assert.equal(icon('C', STOCK_MAX + 1200), '🔒');
  assert.equal(icon('CP', 2000), '🟢');
  assert.equal(icon('C', 1999), '🟠');
  assert.equal(icon('C', 1000), '🟠');
  assert.equal(icon('C', 999), '🔴');
  assert.equal(icon('CP', 0), '🔴');
  assert.equal(icon('BC', 50), null);
  assert.equal(icon('CO', 5000), null);
});

test('stock plein : dépôts refusés une fois la limite atteinte (CP et C)', async () => {
  const { overCapacity, STOCK_MAX: M } = await import('../src/config.js');
  const q = (CP = 0, C = 0, BC = 0, CO = 0) => ({ CP, C, BC, CO });
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
