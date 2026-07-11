'use strict';

const CRLF = '\r\n';

/**
 * Incremental HTTP/1.1 message parser (used for both requests and
 * responses) built directly on top of Buffers, with no dependency on
 * Node's `http` module. Feed it raw bytes as they arrive off a socket;
 * it returns the parsed message once it is complete, and hands back any
 * leftover bytes (`rest`) that belong to the *next* pipelined message on
 * the same keep-alive connection.
 *
 * Supports:
 *  - request-line / status-line parsing
 *  - header parsing (case-insensitive names, repeated headers joined
 *    with ", " per RFC 7230 section 3.2.2)
 *  - fixed-length bodies via Content-Length
 *  - streamed bodies via Transfer-Encoding: chunked (including trailers)
 *  - partial reads: a message may arrive split across arbitrarily many
 *    feed() calls, one byte at a time if need be
 */
class HttpMessageParser {
  /** @param {'request'|'response'} mode */
  constructor(mode) {
    if (mode !== 'request' && mode !== 'response') {
      throw new Error(`mode must be 'request' or 'response', got ${JSON.stringify(mode)}`);
    }
    this.mode = mode;
    this._reset();
  }

  _reset() {
    this.state = 'START_LINE';
    this._buf = Buffer.alloc(0);
    this.message = null;
    this._bodyChunks = [];
    this._contentLength = null;
    this._chunkState = null;
    this._remainingChunkBytes = 0;
  }

  /** Begin parsing a new message on the same connection (HTTP keep-alive). */
  reset() {
    this._reset();
  }

  /**
   * Feed newly received bytes. Returns the parsed message object once a
   * complete message has been read (with .rest holding any bytes past
   * the end of this message), or null if more data is needed.
   */
  feed(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    if (this.state === 'START_LINE') {
      const idx = this._buf.indexOf(CRLF);
      if (idx === -1) return null;
      const line = this._buf.slice(0, idx).toString('latin1');
      this._buf = this._buf.slice(idx + 2);
      this._parseStartLine(line);
      this.message.headers = {};
      this.state = 'HEADERS';
    }

    if (this.state === 'HEADERS') {
      for (;;) {
        const idx = this._buf.indexOf(CRLF);
        if (idx === -1) return null;
        const line = this._buf.slice(0, idx).toString('latin1');
        this._buf = this._buf.slice(idx + 2);
        if (line === '') {
          this._onHeadersComplete();
          break;
        }
        this._parseHeaderLine(line);
      }
    }

    if (this.state === 'BODY_CONTENT_LENGTH') {
      if (this._buf.length < this._contentLength) return null;
      this.message.body = this._buf.slice(0, this._contentLength);
      this._buf = this._buf.slice(this._contentLength);
      this.state = 'DONE';
    }

    if (this.state === 'BODY_CHUNKED') {
      if (!this._drainChunks()) return null;
    }

    if (this.state === 'NO_BODY') {
      this.state = 'DONE';
    }

    if (this.state === 'DONE') {
      const msg = this.message;
      msg.rest = this._buf;
      this._reset();
      return msg;
    }

    return null;
  }

  _parseStartLine(line) {
    if (this.mode === 'request') {
      const parts = line.split(' ');
      if (parts.length !== 3) throw new Error(`Malformed request line: ${JSON.stringify(line)}`);
      const [method, url, httpVersion] = parts;
      this.message = { method, url, httpVersion };
    } else {
      const parts = line.split(' ');
      if (parts.length < 2) throw new Error(`Malformed status line: ${JSON.stringify(line)}`);
      const [httpVersion, statusCode, ...rest] = parts;
      this.message = {
        httpVersion,
        statusCode: Number(statusCode),
        statusMessage: rest.join(' '),
      };
    }
  }

  _parseHeaderLine(line) {
    const idx = line.indexOf(':');
    if (idx === -1) throw new Error(`Malformed header line: ${JSON.stringify(line)}`);
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (this.message.headers[name] !== undefined) {
      this.message.headers[name] += ', ' + value;
    } else {
      this.message.headers[name] = value;
    }
  }

  _onHeadersComplete() {
    const headers = this.message.headers;
    const isChunked = (headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
    if (isChunked) {
      this.state = 'BODY_CHUNKED';
      this._chunkState = 'SIZE';
      this._bodyChunks = [];
      return;
    }
    if (headers['content-length'] !== undefined) {
      const len = parseInt(headers['content-length'], 10);
      if (Number.isNaN(len) || len < 0) {
        throw new Error(`Invalid Content-Length: ${JSON.stringify(headers['content-length'])}`);
      }
      this._contentLength = len;
      if (len === 0) {
        this.message.body = Buffer.alloc(0);
        this.state = 'DONE';
      } else {
        this.state = 'BODY_CONTENT_LENGTH';
      }
      return;
    }
    this.message.body = Buffer.alloc(0);
    this.state = 'NO_BODY';
  }

  /** Returns true once the terminating chunk + trailers have been consumed. */
  _drainChunks() {
    for (;;) {
      if (this._chunkState === 'SIZE') {
        const idx = this._buf.indexOf(CRLF);
        if (idx === -1) return false;
        const sizeLine = this._buf.slice(0, idx).toString('latin1').split(';')[0].trim();
        const size = parseInt(sizeLine, 16);
        if (Number.isNaN(size) || size < 0) {
          throw new Error(`Invalid chunk size: ${JSON.stringify(sizeLine)}`);
        }
        this._buf = this._buf.slice(idx + 2);
        this._remainingChunkBytes = size;
        this._chunkState = size === 0 ? 'TRAILER' : 'DATA';
      } else if (this._chunkState === 'DATA') {
        if (this._buf.length < this._remainingChunkBytes + 2) return false;
        this._bodyChunks.push(this._buf.slice(0, this._remainingChunkBytes));
        this._buf = this._buf.slice(this._remainingChunkBytes + 2); // trailing CRLF after chunk data
        this._chunkState = 'SIZE';
      } else if (this._chunkState === 'TRAILER') {
        const idx = this._buf.indexOf(CRLF);
        if (idx === -1) return false;
        const line = this._buf.slice(0, idx).toString('latin1');
        this._buf = this._buf.slice(idx + 2);
        if (line === '') {
          this.message.body = Buffer.concat(this._bodyChunks);
          this.state = 'DONE';
          return true;
        }
        // else: a trailer header; we don't surface trailers, just skip past them.
      }
    }
  }
}

function serializeRequest({ method, url, httpVersion = 'HTTP/1.1', headers = {}, body }) {
  return serializeStartAndHeaders(`${method} ${url} ${httpVersion}`, headers, body);
}

function serializeResponse({ statusCode, statusMessage = '', httpVersion = 'HTTP/1.1', headers = {}, body }) {
  return serializeStartAndHeaders(`${httpVersion} ${statusCode} ${statusMessage}`, headers, body);
}

function serializeStartAndHeaders(startLine, headers, body) {
  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
  const finalHeaders = { ...headers };
  if (finalHeaders['content-length'] === undefined && finalHeaders['transfer-encoding'] === undefined) {
    finalHeaders['content-length'] = String(bodyBuf.length);
  }
  const headerLines = Object.entries(finalHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join(CRLF);
  const head = Buffer.from(`${startLine}${CRLF}${headerLines}${CRLF}${CRLF}`, 'latin1');
  return Buffer.concat([head, bodyBuf]);
}

module.exports = { HttpMessageParser, serializeRequest, serializeResponse };
