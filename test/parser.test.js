'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpMessageParser, serializeRequest, serializeResponse } = require('../src/http/parser');

test('parses a simple GET request', () => {
  const parser = new HttpMessageParser('request');
  const raw = Buffer.from('GET /foo?x=1 HTTP/1.1\r\nHost: example.com\r\n\r\n');
  const msg = parser.feed(raw);
  assert.equal(msg.method, 'GET');
  assert.equal(msg.url, '/foo?x=1');
  assert.equal(msg.headers.host, 'example.com');
  assert.equal(msg.body.length, 0);
});

test('parses a POST request with a Content-Length body', () => {
  const parser = new HttpMessageParser('request');
  const raw = Buffer.from('POST /submit HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello');
  const msg = parser.feed(raw);
  assert.equal(msg.body.toString(), 'hello');
});

test('parses a request split across many feed() calls', () => {
  const parser = new HttpMessageParser('request');
  const raw = Buffer.from('POST /submit HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello');
  let msg = null;
  for (let i = 0; i < raw.length; i++) {
    msg = parser.feed(raw.slice(i, i + 1)) || msg;
  }
  assert.equal(msg.body.toString(), 'hello');
});

test('parses a chunked Transfer-Encoding body', () => {
  const parser = new HttpMessageParser('request');
  const raw = Buffer.from(
    'POST /chunked HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n' + '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'
  );
  const msg = parser.feed(raw);
  assert.equal(msg.body.toString(), 'hello world');
});

test('parses a response status line', () => {
  const parser = new HttpMessageParser('response');
  const raw = Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
  const msg = parser.feed(raw);
  assert.equal(msg.statusCode, 404);
  assert.equal(msg.statusMessage, 'Not Found');
});

test('rejects a malformed request line', () => {
  const parser = new HttpMessageParser('request');
  assert.throws(() => parser.feed(Buffer.from('GARBAGE\r\n\r\n')));
});

test('exposes pipelined bytes as .rest', () => {
  const parser = new HttpMessageParser('request');
  const raw = Buffer.from('GET /a HTTP/1.1\r\nHost: x\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n');
  const first = parser.feed(raw);
  assert.equal(first.url, '/a');
  assert.ok(first.rest.length > 0);
  const second = parser.feed(first.rest);
  assert.equal(second.url, '/b');
});

test('serializeRequest/serializeResponse round-trip through the parser', () => {
  const reqBuf = serializeRequest({ method: 'GET', url: '/x', headers: { host: 'a' } });
  const reqParser = new HttpMessageParser('request');
  const req = reqParser.feed(reqBuf);
  assert.equal(req.method, 'GET');
  assert.equal(req.headers['content-length'], '0');

  const resBuf = serializeResponse({ statusCode: 200, statusMessage: 'OK', body: 'hi' });
  const resParser = new HttpMessageParser('response');
  const res = resParser.feed(resBuf);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'hi');
});
