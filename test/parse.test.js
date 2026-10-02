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

test('niveaux de stock (CP et C uniquement)', async () => {
  const { stockLevel } = await import('../src/config.js');
  const icon = (code, n) => stockLevel(code, n)?.icon ?? null;
  assert.equal(icon('C', 4000), '🔒');
  assert.equal(icon('C', 5200), '🔒');
  assert.equal(icon('CP', 3999), '🟢');
  assert.equal(icon('CP', 2000), '🟢');
  assert.equal(icon('C', 1999), '🟠');
  assert.equal(icon('C', 1000), '🟠');
  assert.equal(icon('C', 999), '🔴');
  assert.equal(icon('CP', 0), '🔴');
  assert.equal(icon('BC', 50), null);
  assert.equal(icon('CO', 5000), null);
});

test('stock plein : dépôts refusés une fois 4000 atteint (CP et C)', async () => {
  const { overCapacity } = await import('../src/config.js');
  const q = (CP = 0, C = 0, BC = 0, CO = 0) => ({ CP, C, BC, CO });
  assert.deepEqual(overCapacity(q(1000), { CP: 3900 }), []); // dépasse 4000 : accepté
  assert.deepEqual(overCapacity(q(10), { CP: 3999 }), []);
  assert.deepEqual(overCapacity(q(10), { CP: 4000 }), [{ code: 'CP', stock: 4000 }]); // déjà plein : refusé
  assert.deepEqual(overCapacity(q(0, 10), { C: 4200 }), [{ code: 'C', stock: 4200 }]);
  assert.deepEqual(overCapacity(q(0, 10), { CP: 5000, C: 100 }), []); // CP plein mais rien déposé en CP
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
  assert.equal(isStaff(null), false);
});

test('valeur de rachat avec bonus par unité', async () => {
  const { rachatValue } = await import('../src/prices.js');
  assert.equal(rachatValue({ CP: 300, C: 0, BC: 0, CO: 0 }), 180); // 300 × 0,6
  assert.equal(rachatValue({ CP: 300, C: 0, BC: 0, CO: 0 }, 0.1), 210); // 300 × 0,7
  assert.equal(rachatValue({ CP: 0, C: 100, BC: 10, CO: 1 }, 0.1), 152.3); // 100×1,3 + 10×1,9 + 1×3,3
});
