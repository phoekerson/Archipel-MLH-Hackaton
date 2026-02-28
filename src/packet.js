// Format Archipel Packet v1
// [ MAGIC(4) | TYPE(1) | NODE_ID(32) | PAYLOAD_LEN(4) | PAYLOAD(var) | HMAC(32) ]

const MAGIC = Buffer.from('ARCH', 'ascii'); // 4 bytes

const TYPE = {
  HELLO: 0x01,
  PEER_LIST: 0x02,
  MSG: 0x03,
  CHUNK_REQ: 0x04,
  CHUNK_DATA: 0x05,
  MANIFEST: 0x06,
  ACK: 0x07
};

function buildPacket(type, nodeId, payload) {
  const nodeIdBuf = Buffer.isBuffer(nodeId) ? nodeId : Buffer.from(nodeId, 'hex');
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  
  const payloadLen = Buffer.allocUnsafe(4);
  payloadLen.writeUInt32BE(payloadBuf.length);
  
  // HMAC placeholder (32 bytes de zéros pour l'instant, Sprint 2 le remplira)
  const hmac = Buffer.alloc(32, 0);
  
  return Buffer.concat([MAGIC, Buffer.from([type]), nodeIdBuf, payloadLen, payloadBuf, hmac]);
}

function parsePacket(buf) {
  const magic = buf.slice(0, 4).toString('ascii');
  if (magic !== 'ARCH') throw new Error('Magic invalide');
  
  const type = buf[4];
  const nodeId = buf.slice(5, 37).toString('hex');
  const payloadLen = buf.readUInt32BE(37);
  const payload = buf.slice(41, 41 + payloadLen);
  const hmac = buf.slice(41 + payloadLen, 41 + payloadLen + 32);
  
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(payload.toString());
  } catch {
    parsedPayload = payload;
  }
  
  return { magic, type, nodeId, payload: parsedPayload, hmac };
}

module.exports = { TYPE, buildPacket, parsePacket };