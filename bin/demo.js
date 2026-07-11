'use strict';

const http = require('http');
const { ReverseProxy, Backend } = require('../src/proxy/reverseProxy');
const { RoundRobinStrategy } = require('../src/loadBalancer/strategies');
const { HealthChecker } = require('../src/loadBalancer/healthCheck');
const { MockBackend } = require('../src/backend/mockServer');

function get(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/hello' }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const mocks = [new MockBackend({ id: 'A' }), new MockBackend({ id: 'B' }), new MockBackend({ id: 'C' })];
  const addrs = await Promise.all(mocks.map(m => m.listen(0)));

  const backends = addrs.map((addr, i) => new Backend({ id: mocks[i].id, host: '127.0.0.1', port: addr.port }));
  const proxy = new ReverseProxy({ backends, strategy: new RoundRobinStrategy() });
  const health = new HealthChecker(backends, { intervalMs: 500 });
  health.start();

  const { port } = await proxy.listen(0);
  console.log(`Reverse proxy listening on 127.0.0.1:${port}, backends: ${backends.map(b => b.id).join(', ')}`);

  const counts = {};
  for (let i = 0; i < 9; i++) {
    const body = await get(port);
    const servedBy = JSON.parse(body).servedBy;
    counts[servedBy] = (counts[servedBy] || 0) + 1;
  }
  console.log('Request distribution over 9 requests:', counts);

  console.log('\nKilling backend B to demonstrate failover...');
  mocks[1].breakFor(Infinity);
  await sleep(1200); // let the health checker mark it unhealthy

  const counts2 = {};
  for (let i = 0; i < 6; i++) {
    const body = await get(port);
    const servedBy = JSON.parse(body).servedBy;
    counts2[servedBy] = (counts2[servedBy] || 0) + 1;
  }
  console.log('Request distribution after failover (B excluded):', counts2);

  health.stop();
  await proxy.close();
  await Promise.all(mocks.map(m => m.close()));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
