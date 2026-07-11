'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ReverseProxy, Backend } = require('../src/proxy/reverseProxy');
const { RoundRobinStrategy } = require('../src/loadBalancer/strategies');
const { HealthChecker } = require('../src/loadBalancer/healthCheck');
const { MockBackend } = require('../src/backend/mockServer');

function get(port, path = '/') {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
      })
      .on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

test('proxy distributes requests across backends round robin', async t => {
  const mocks = [new MockBackend({ id: 'A' }), new MockBackend({ id: 'B' })];
  const addrs = await Promise.all(mocks.map(m => m.listen(0)));
  const backends = addrs.map((addr, i) => new Backend({ id: mocks[i].id, host: '127.0.0.1', port: addr.port }));
  const proxy = new ReverseProxy({ backends, strategy: new RoundRobinStrategy() });
  const { port } = await proxy.listen(0);

  t.after(async () => {
    await proxy.close();
    await Promise.all(mocks.map(m => m.close()));
  });

  const served = [];
  for (let i = 0; i < 4; i++) {
    const res = await get(port, '/ping');
    served.push(JSON.parse(res.body).servedBy);
  }
  assert.deepEqual(served, ['A', 'B', 'A', 'B']);
});

test('proxy fails over to a healthy backend when one goes down', async t => {
  const mocks = [new MockBackend({ id: 'A' }), new MockBackend({ id: 'B' })];
  const addrs = await Promise.all(mocks.map(m => m.listen(0)));
  const backends = addrs.map((addr, i) => new Backend({ id: mocks[i].id, host: '127.0.0.1', port: addr.port }));
  const proxy = new ReverseProxy({ backends, strategy: new RoundRobinStrategy() });
  const health = new HealthChecker(backends, { intervalMs: 100 });
  health.start();
  const { port } = await proxy.listen(0);

  t.after(async () => {
    health.stop();
    await proxy.close();
    await Promise.all(mocks.map(m => m.close()));
  });

  mocks[1].breakFor(Infinity);
  await sleep(400); // give the health checker a couple of cycles

  const served = new Set();
  for (let i = 0; i < 6; i++) {
    const res = await get(port, '/ping');
    served.add(JSON.parse(res.body).servedBy);
  }
  assert.deepEqual([...served], ['A']);
});

test('returns 502 when the only backend is unreachable', async t => {
  const backends = [new Backend({ id: 'ghost', host: '127.0.0.1', port: 1 })];
  const proxy = new ReverseProxy({ backends, strategy: new RoundRobinStrategy(), requestTimeoutMs: 1000 });
  const { port } = await proxy.listen(0);
  t.after(() => proxy.close());

  const res = await get(port, '/ping');
  assert.equal(res.statusCode, 502);
});
