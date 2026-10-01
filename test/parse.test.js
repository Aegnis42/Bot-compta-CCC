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
  assert.equal(normalizeWeek('2026-S40'), '2026-S40');
  assert.equal(normalizeWeek('2026-4'), '2026-S04');
  assert.match(normalizeWeek('7'), /^\d{4}-S07$/);
  assert.equal(normalizeWeek('abc'), null);
});
