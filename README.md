# http-reverse-proxy-lb

A from-scratch HTTP/1.1 reverse proxy and load balancer in Node.js. No
Express, no `http` module, no dependencies at all - the request parser,
the response serializer, and the proxying logic are all built directly
on raw `net` sockets.

## Why

Every real load balancer (nginx, HAProxy, Envoy) is doing the same handful
of things under the hood: parse HTTP off the wire, pick a backend, forward
the request, stream the response back, and stop sending traffic to
backends that are unhealthy. Those pieces are usually hidden behind a
library. This project builds each one explicitly, as a way of actually
understanding the mechanics rather than configuring around them:

- an incremental HTTP/1.1 message parser (headers, `Content-Length`
  bodies, chunked transfer encoding, pipelined requests on a keep-alive
  connection)
- three interchangeable load balancing strategies (round robin, least
  connections, smooth weighted round robin)
- a per-backend circuit breaker (closed / open / half-open) driven by
  both passive failures (a real client request fails) and an active
  health checker that polls `GET /health` on an interval
- automatic failover: if a chosen backend's connection dies mid-request,
  the proxy retries the remaining healthy backends before giving up with
  a 502

## Project layout

```
src/
  http/parser.js          incremental request/response parser + serializers
  loadBalancer/
    strategies.js          round robin, least connections, weighted round robin
    healthCheck.js          circuit breaker + active health checker
  proxy/reverseProxy.js     ties it together: accepts clients, forwards to backends
  backend/mockServer.js     a tiny raw-socket HTTP server, used by tests/demo
bin/demo.js                 end-to-end demo: 3 backends, kill one, watch failover
test/                       unit + integration tests (node's built-in test runner)
```

## Running it

Requires Node.js 18+. No install step - there are no dependencies.

```bash
npm test     # runs the full test suite (node --test)
npm run demo # spins up 3 mock backends + the proxy, sends traffic, kills one backend
```

Sample demo output:

```
Reverse proxy listening on 127.0.0.1:PORT, backends: A, B, C
Request distribution over 9 requests: { A: 3, B: 3, C: 3 }

Killing backend B to demonstrate failover...
Request distribution after failover (B excluded): { A: 4, C: 2 }
```

To point the proxy at real backends instead of the mock ones:

```js
const { ReverseProxy, Backend } = require('./src/proxy/reverseProxy');
const { RoundRobinStrategy } = require('./src/loadBalancer/strategies');
const { HealthChecker } = require('./src/loadBalancer/healthCheck');

const backends = [
  new Backend({ id: 'api-1', host: '10.0.0.1', port: 8080 }),
  new Backend({ id: 'api-2', host: '10.0.0.2', port: 8080 }),
];

const proxy = new ReverseProxy({ backends, strategy: new RoundRobinStrategy() });
new HealthChecker(backends, { intervalMs: 2000 }).start();
await proxy.listen(80);
```

## Design decisions

**Why hand-roll the HTTP parser instead of using Node's `http` module?**
Using `http.createServer` + `http.request` would hide exactly the part
that makes a reverse proxy interesting: you have to parse the request
once (as a server), and reserialize/parse the response again (as a
client), while preserving semantics like `Content-Length` vs. chunked
encoding and connection reuse. Building it on `net` sockets directly
keeps that whole path visible and testable in isolation (see
`test/parser.test.js`, which feeds bytes into the parser one at a time to
prove it handles arbitrary TCP fragmentation correctly).

**Why an active health check on top of passive failure tracking?**
Passive tracking (marking a backend unhealthy when a live request to it
fails) reacts to real traffic, but during a quiet period a dead backend
would keep receiving requests until traffic picked back up. The active
`HealthChecker` closes that gap by polling every backend on a fixed
interval. Both paths feed the same `CircuitBreaker`, so a flaky backend
doesn't need two separate failure counters.

**Why a real HTTP GET for the health check instead of a bare TCP connect?**
An earlier version just did a TCP connect-and-close. That passes even
when a backend's process is wedged and dropping every request, because
the OS still accepts the connection at the socket level. Sending an
actual `GET /health` and requiring a non-5xx status catches that class of
failure; `test/integration.test.js`'s failover test specifically exercises
a backend that accepts connections but resets them mid-request.

**Why smooth weighted round robin instead of naive weighted round robin?**
Naive weighted round robin (repeat backend A `weight` times, then move on)
bursts all of a heavy backend's traffic together. The smooth variant
(same algorithm nginx uses) spreads it out evenly - see
`test/strategies.test.js` for the distribution check.

## Testing

`npm test` runs 19 tests via Node's built-in test runner (`node:test`,
no Jest/Mocha needed): parser correctness under fragmentation and
malformed input, each load balancing strategy's selection logic, circuit
breaker state transitions (including the half-open re-open case), and
full integration tests that boot real mock backends behind the proxy and
assert on request distribution, failover, and 502 behavior when nothing
is healthy.
