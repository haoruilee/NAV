import test from 'node:test';
import assert from 'node:assert/strict';
import { lookThrough, calendarRecords } from './research-math.mjs';
const funds = [
  { id: 'a', holdingsReport: { asOf: '2026-01-01', holdings: [{ name: 'Acme', weight: 50 }] } },
  { id: 'b', holdingsReport: { holdings: [{ name: 'Acme', weight: 20 }, { name: 'Other', weight: 30 }] } },
  { id: 'c', holdingsReport: { holdings: [] } },
];
test('look-through preserves overlapping issuer arithmetic and unmapped weights', () => {
  const result = lookThrough(funds, { a: 50, b: 50 }, 10000);
  assert(result.ok);
  assert.equal(result.issuers.find(x => x.name === 'Acme').weight, 35);
  assert.equal(result.issuers.find(x => x.name === 'Acme').dollars, 3500);
  assert.equal(result.known, 50); assert.equal(result.unmapped, 50);
  assert.equal(lookThrough(funds, { c: 100 }).unmapped, 100);
});
test('invalid allocations and illustrative amounts fail closed', () => {
  for (const input of [{ a: 90 }, { a: NaN }, { unknown: 100 }, { a: -1, b: 101 }]) assert.equal(lookThrough(funds, input).ok, false);
  assert.equal(lookThrough(funds, { a: 100 }, -1).ok, false);
});
test('source calendar excludes impossible and future dates', () => {
  assert.equal(calendarRecords({ retrievedAt: '2026-11-03', funds: [], announcements: [{ date: '2027-01-01', url: 'https://example.org/a' }, { date: '2026-02-30', url: 'https://example.org/b' }] }).length, 0);
});
