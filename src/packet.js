const MAGIC = Buffer.from('ARCH', 'ascii');

const TYPE = {
  HELLO: 0x01,
  PEER_LIST: 0x02,
  MSG: 0x03,
  CHUNK_REQ: 0x04,
  CHUNK_DATA: 0x05,
  MANIFEST: 0x06,
  ACK: 0x07,
  HANDSHAKE: 0x08  // nouveau : échange de clés éphémères
};

// hmacKey optionnel — si fourni, calcule un vrai HMAC
function buildPacket(type, nodeId, payload, hmacKey = null) {
  const nodeIdBuf = Buffer.isBuffer(nodeId) ? nodeId : Buffer.from(nodeId, 'hex');
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));

  const payloadLen = Buffer.allocUnsafe(4);
  payloadLen.writeUInt32BE(payloadBuf.length);

  const header = Buffer.concat([MAGIC, Buffer.from([type]), nodeIdBuf, payloadLen]);
  const body = Buffer.concat([header, payloadBuf]);

  let hmac;
  if (hmacKey) {
    const sodium = require('libsodium-wrappers');
    hmac = Buffer.from(sodium.crypto_auth(body, hmacKey));
  } else {
    hmac = Buffer.alloc(32, 0);
  }

  return Buffer.concat([body, hmac]);
}

function parsePacket(buf) {
  if (buf.length < 41) throw new Error('Paquet trop court');
  const magic = buf.slice(0, 4).toString('ascii');
  if (magic !== 'ARCH') throw new Error('Magic invalide');

  const type = buf[4];
  const nodeId = buf.slice(5, 37).toString('hex');
  const payloadLen = buf.readUInt32BE(37);

  if (buf.length < 41 + payloadLen + 32) throw new Error('Paquet incomplet');

  const payload = buf.slice(41, 41 + payloadLen);
  const hmac = buf.slice(41 + payloadLen, 41 + payloadLen + 32);

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(payload.toString());
  } catch {
    parsedPayload = payload;
  }

  return { magic, type, nodeId, payload: parsedPayload, rawPayload: payload, hmac };
}

module.exports = { TYPE, buildPacket, parsePacket };