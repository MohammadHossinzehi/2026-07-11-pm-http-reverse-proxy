'use strict';

const net = require('net');
const { HttpMessageParser, serializeRequest, serializeResponse } = require('../http/parser');
const { CircuitBreaker } = require('../loadBalancer/healthCheck');

class Backend {
  constructor({ id, host, port, weight = 1 }) {
    this.id = id;
    this.host = host;
    this.port = port;
    this.weight = weight;
    this.activeConnections = 0;
    this.healthy = true;
    this.breaker = new CircuitBreaker();
  }
}

/**
 * A reverse proxy / load balancer built directly on `net` sockets: it
 * parses incoming HTTP requests itself, picks a backend using a
 * pluggable strategy, forwards the request over a fresh backend
 * connection, and streams the parsed-and-reserialized response back to
 * the client. If a backend connection fails, it retries the remaining
 * healthy backends before giving up with a 502.
 */
class ReverseProxy {
  constructor({ backends, strategy, requestTimeoutMs = 5000 }) {
    this.backends = backends.map(b => (b instanceof Backend ? b : new Backend(b)));
    this.strategy = strategy;
    this.requestTimeoutMs = requestTimeoutMs;
    this.server = net.createServer(socket => this._handleClient(socket));
  }

  listen(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }

  close() {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  _pickBackend() {
    return this.strategy.pick(this.backends);
  }

  _handleClient(clientSocket) {
    let parser = new HttpMessageParser('request');

    const consume = chunk => {
      let msg;
      try {
        msg = parser.feed(chunk);
      } catch (err) {
        this._writeError(clientSocket, 400, `Bad Request: ${err.message}`);
        clientSocket.destroy();
        return;
      }
      if (!msg) return;
      const rest = msg.rest;
      delete msg.rest;
      this._forward(clientSocket, msg).catch(() => {
        /* already turned into an HTTP error response inside _forward */
      });
      if (rest && rest.length) consume(rest);
    };

    clientSocket.on('data', consume);
    clientSocket.on('error', () => {});
  }

  async _forward(clientSocket, requestMsg, attemptedBackendIds = new Set()) {
    if (attemptedBackendIds.size >= this.backends.length) {
      this._writeError(clientSocket, 502, 'Bad Gateway: no healthy backends');
      return;
    }

    const backend = this._pickBackend();
    if (!backend) {
      this._writeError(clientSocket, 502, 'Bad Gateway: no healthy backends');
      return;
    }

    backend.activeConnections += 1;
    const backendSocket = net.connect({ host: backend.host, port: backend.port });
    const responseParser = new HttpMessageParser('response');
    let settled = false;

    const cleanup = () => {
      backend.activeConnections = Math.max(0, backend.activeConnections - 1);
      backendSocket.destroy();
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        backend.breaker.onFailure();
        backend.healthy = backend.breaker.isAvailable;
        this._writeError(clientSocket, 504, 'Gateway Timeout');
        reject(new Error('backend timeout'));
      }, this.requestTimeoutMs);

      backendSocket.once('connect', () => {
        const payload = serializeRequest({
          method: requestMsg.method,
          url: requestMsg.url,
          httpVersion: requestMsg.httpVersion,
          headers: { ...requestMsg.headers, connection: 'close' },
          body: requestMsg.body,
        });
        backendSocket.write(payload);
      });

      backendSocket.on('data', chunk => {
        if (settled) return;
        let respMsg;
        try {
          respMsg = responseParser.feed(chunk);
        } catch (err) {
          settled = true;
          clearTimeout(timer);
          cleanup();
          this._writeError(clientSocket, 502, `Bad Gateway: ${err.message}`);
          reject(err);
          return;
        }
        if (!respMsg) return;
        settled = true;
        clearTimeout(timer);
        backend.breaker.onSuccess();
        backend.healthy = true;
        const out = serializeResponse({
          statusCode: respMsg.statusCode,
          statusMessage: respMsg.statusMessage,
          httpVersion: respMsg.httpVersion,
          headers: { ...respMsg.headers, 'x-served-by': backend.id },
          body: respMsg.body,
        });
        clientSocket.write(out);
        cleanup();
        resolve();
      });

      const retryOnFailure = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        backend.breaker.onFailure();
        backend.healthy = backend.breaker.isAvailable;
        attemptedBackendIds.add(backend.id);
        this._forward(clientSocket, requestMsg, attemptedBackendIds).then(resolve, reject);
      };

      backendSocket.once('error', retryOnFailure);
      // A backend can drop the connection (RST/FIN) without ever emitting
      // an 'error' event - guard against that so we don't wait out the
      // full request timeout for what is really an immediate failure.
      backendSocket.once('close', retryOnFailure);
    });
  }

  _writeError(clientSocket, statusCode, message) {
    const body = Buffer.from(message + '\n');
    clientSocket.write(
      serializeResponse({
        statusCode,
        statusMessage: 'Error',
        headers: { 'content-type': 'text/plain' },
        body,
      })
    );
  }
}

module.exports = { ReverseProxy, Backend };
