'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RoundRobinStrategy,
  LeastConnectionsStrategy,
  WeightedRoundRobinStrategy,
} = require('../src/loadBalancer/strategies');

function backend(id, extra = {}) {
  return { id, healthy: true, activeConnections: 0, weight: 1, ...extra };
}

test('round robin cycles through healthy backends in order', () => {
  const strat = new RoundRobinStrategy();
  const backends = [backend('a'), backend('b'), backend('c')];
  const picks = [0, 1, 2, 3, 4].map(() => strat.pick(backends).id);
  assert.deepEqual(picks, ['a', 'b', 'c', 'a', 'b']);
});

test('round robin skips unhealthy backends', () => {
  const strat = new RoundRobinStrategy();
  const backends = [backend('a'), backend('b', { healthy: false }), backend('c')];
  const picks = [0, 1, 2, 3].map(() => strat.pick(backends).id);
  assert.deepEqual(picks, ['a', 'c', 'a', 'c']);
});

test('round robin returns null when nothing is healthy', () => {
  const strat = new RoundRobinStrategy();
  assert.equal(strat.pick([backend('a', { healthy: false })]), null);
});

test('least connections picks the backend with fewest active connections', () => {
  const strat = new LeastConnectionsStrategy();
  const backends = [
    backend('a', { activeConnections: 3 }),
    backend('b', { activeConnections: 1 }),
    backend('c', { activeConnections: 2 }),
  ];
  assert.equal(strat.pick(backends).id, 'b');
});

test('weighted round robin distributes roughly proportional to weight', () => {
  const strat = new WeightedRoundRobinStrategy();
  const backends = [backend('a', { weight: 3 }), backend('b', { weight: 1 })];
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 40; i++) counts[strat.pick(backends).id]++;
  assert.ok(counts.a > counts.b * 2, `expected a >> b, got ${JSON.stringify(counts)}`);
});
