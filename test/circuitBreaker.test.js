'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker, STATE } = require('../src/loadBalancer/healthCheck');

test('circuit breaker opens after reaching the failure threshold', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 50 });
  assert.equal(cb.isAvailable, true);
  cb.onFailure();
  cb.onFailure();
  assert.equal(cb.state, STATE.CLOSED);
  cb.onFailure();
  assert.equal(cb.state, STATE.OPEN);
  assert.equal(cb.isAvailable, false);
});

test('circuit breaker moves to half-open after cooldown and closes on success', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
  cb.onFailure();
  assert.equal(cb.state, STATE.OPEN);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(cb.isAvailable, true);
  assert.equal(cb.state, STATE.HALF_OPEN);
  cb.onSuccess();
  assert.equal(cb.state, STATE.CLOSED);
});

test('a failure while half-open re-opens the breaker', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 20 });
  cb.onFailure();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(cb.isAvailable, true); // transitions to HALF_OPEN
  cb.onFailure();
  assert.equal(cb.state, STATE.OPEN);
});
