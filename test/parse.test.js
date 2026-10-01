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
