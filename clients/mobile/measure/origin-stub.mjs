#!/usr/bin/env node
/**
 * A zero-dependency WebSocket stub whose only job is to report the `Origin`
 * header React Native's WebSocket sent it.
 *
 * Spike #837 gate 3 discovered — against the pre-spike assumption — that React
 * Native's WebSocket DOES send `Origin`, and that its value is the socket URL's
 * own origin. Against this repo's `infra/centrifugo.json` `allowed_origins`
 * that means:
 *
 *   wss://app.oor7.com/...          Origin https://app.oor7.com          ACCEPTED
 *   ws://<machine>.local:28001/...  Origin http://<machine>.local:28001  REJECTED
 *   ws://127.0.0.1:<port>/...       Origin http://127.0.0.1:<port>       REJECTED
 *
 * A rejected handshake looks like `{"code":2,"message":"transport closed"}`
 * repeating forever with the socket never once open, which is indistinguishable
 * from a dead network unless you already know. Self-hosting on a LAN is a
 * product property, so this is a real defect — and it is a SERVER configuration
 * and security decision, explicitly outside this batch.
 *
 * This stub reproduces the measurement instead of citing it. It speaks just
 * enough of RFC 6455 to complete a handshake and push one text frame back
 * (the Origin it received), which is all the probe needs — it is deliberately
 * not a Centrifugo, because the question here is about a header, not a protocol.
 *
 * Run:  node measure/origin-stub.mjs
 */
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';

const PORT = 18991;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One unmasked text frame. Payloads here are tiny, so only the short form. */
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > 125) throw new Error('probe payload is meant to be short');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

const server = createServer((_req, res) => {
  res.writeHead(426);
  res.end('websocket only');
});

server.on('upgrade', (req, socket) => {
  const origin = req.headers.origin ?? '(none)';
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1')
    .update(`${key}${GUID}`)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  console.log(`[origin-stub] Origin header received: ${origin}`);
  console.log(
    origin === '(none)'
      ? '[origin-stub] no Origin — the spike finding would NOT reproduce'
      : '[origin-stub] Origin present — this is the header Centrifugo checks',
  );
  socket.write(textFrame(origin));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[origin-stub] listening on ws://127.0.0.1:${PORT}`);
});
