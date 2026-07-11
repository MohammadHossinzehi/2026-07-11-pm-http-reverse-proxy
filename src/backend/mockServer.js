'use strict';

const net = require('net');
const { HttpMessageParser, serializeResponse } = require('../http/parser');

/**
 * A minimal raw-socket HTTP server used to stand in for a real backend
 * in tests and the demo script. It exists so the whole request/response
 * path (including failures) can be exercised without any external
 * dependency or a real upstream service.
 */
class MockBackend {
  constructor({ id, latencyMs = 0 } = {}) {
    this.id = id;
    this.latencyMs = latencyMs;
    this.failCount = 0;
    this.requestCount = 0;
    this.server = net.createServer(socket => this._handle(socket));
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }

  close() {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  /** Simulate an outage: the next `n` requests (or all, by default) get the connection dropped. */
  breakFor(n = Infinity) {
    this.failCount = n;
  }

  _handle(socket) {
    const parser = new HttpMessageParser('request');
    socket.on('data', chunk => {
      let msg;
      try {
        msg = parser.feed(chunk);
      } catch (_) {
        socket.destroy();
        return;
      }
      if (!msg) return;
      this.requestCount += 1;

      if (this.failCount > 0) {
        this.failCount -= 1;
        socket.destroy();
        return;
      }

      const respond = () => {
        const body = JSON.stringify({ servedBy: this.id, url: msg.url, method: msg.method });
        socket.write(
          serializeResponse({
            statusCode: 200,
            statusMessage: 'OK',
            headers: { 'content-type': 'application/json' },
            body,
          })
        );
      };

      if (this.latencyMs > 0) setTimeout(respond, this.latencyMs);
      else respond();
    });
    socket.on('error', () => {});
  }
}

module.exports = { MockBackend };
