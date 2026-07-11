'use strict';

const net = require('net');
const { HttpMessageParser, serializeRequest } = require('../http/parser');

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

/**
 * Standard three-state circuit breaker (CLOSED -> OPEN -> HALF_OPEN).
 * A backend accumulates failures while CLOSED; once it crosses
 * failureThreshold the breaker OPENs and the backend is skipped
 * entirely for cooldownMs. After the cooldown a single probe is let
 * through (HALF_OPEN); success closes the breaker, failure re-opens it.
 */
class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 5000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this._openedAt = null;
  }

  /** Whether a request should currently be allowed through to this backend. */
  get isAvailable() {
    if (this.state === STATE.OPEN) {
      if (Date.now() - this._openedAt >= this.cooldownMs) {
        this.state = STATE.HALF_OPEN;
        return true;
      }
      return false;
    }
    return true;
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = STATE.CLOSED;
  }

  onFailure() {
    this.failureCount += 1;
    if (this.state === STATE.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this._openedAt = Date.now();
    }
  }
}

/**
 * Periodically probes each backend with a real application-level HTTP
 * request (GET /health by default) rather than a bare TCP connect, since
 * a backend can accept connections while its request handling is wedged
 * or dropping sockets. The result is fed into that backend's circuit
 * breaker, which in turn drives backend.healthy.
 */
class HealthChecker {
  constructor(backends, { intervalMs = 1000, timeoutMs = 500, path = '/health' } = {}) {
    this.backends = backends;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.path = path;
    this._timer = null;
  }

  start() {
    this._timer = setInterval(() => this._checkAll(), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    this._checkAll();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  _checkAll() {
    for (const backend of this.backends) this._checkOne(backend);
  }

  _checkOne(backend) {
    const socket = net.connect({ host: backend.host, port: backend.port });
    const parser = new HttpMessageParser('response');
    let settled = false;

    const timer = setTimeout(() => finish(false), this.timeoutMs);

    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (ok) backend.breaker.onSuccess();
      else backend.breaker.onFailure();
      backend.healthy = backend.breaker.isAvailable;
    };

    socket.once('connect', () => {
      socket.write(
        serializeRequest({
          method: 'GET',
          url: this.path,
          headers: { host: `${backend.host}:${backend.port}`, connection: 'close' },
        })
      );
    });

    socket.on('data', chunk => {
      let msg;
      try {
        msg = parser.feed(chunk);
      } catch (_) {
        finish(false);
        return;
      }
      if (msg) finish(msg.statusCode < 500);
    });

    socket.once('error', () => finish(false));
  }
}

module.exports = { CircuitBreaker, HealthChecker, STATE };
