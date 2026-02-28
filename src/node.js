require('dotenv').config();
const crypto = require('./crypto');
const trust = require('./trust');

const sessions = new Map();
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { TYPE, buildPacket, parsePacket } = require('./packet');

const identityPath = path.join('.archipel', 'identity.json');
if (!fs.existsSync(identityPath)) {
  console.error(' Aucune clé trouvée. Lance d\'abord : node src/keygen.js');
  process.exit(1);
}
const identity = JSON.parse(fs.readFileSync(identityPath));
const MY_NODE_ID = identity.publicKey;

const UDP_PORT = parseInt(process.env.UDP_PORT) || 6000;
const TCP_PORT = parseInt(process.env.TCP_PORT) || 7777;
const MULTICAST_ADDR = process.env.UDP_MULTICAST_ADDR || '239.255.42.99';
const HELLO_INTERVAL = 30000;
const PEER_TIMEOUT = 90000;

const peerTable = new Map();

function upsertPeer(nodeId, info) {
  peerTable.set(nodeId, { ...info, lastSeen: Date.now() });
  console.log(`📡 Pair connu: ${nodeId.slice(0, 16)}... @ ${info.ip}:${info.tcpPort}`);
}

function cleanStalePeers() {
  const now = Date.now();
  for (const [id, peer] of peerTable.entries()) {
    if (now - peer.lastSeen > PEER_TIMEOUT) {
      console.log(` Pair mort (timeout): ${id.slice(0, 16)}...`);
      peerTable.delete(id);
    }
  }
}

function displayPeerTable() {
  console.log('\n══ PEER TABLE ══════════════════════════════');
  if (peerTable.size === 0) console.log('  (aucun pair)');
  for (const [id, peer] of peerTable.entries()) {
    const age = Math.round((Date.now() - peer.lastSeen) / 1000);
    console.log(`  ${id.slice(0, 16)}... | ${peer.ip}:${peer.tcpPort} | vu il y a ${age}s`);
  }
  console.log('═══════════════════════════════════════════\n');
}

const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('listening', () => {
  udpSocket.addMembership(MULTICAST_ADDR);
  udpSocket.setMulticastTTL(128);
  console.log(` UDP Multicast en écoute sur ${MULTICAST_ADDR}:${UDP_PORT}`);
  sendHello();
});

udpSocket.on('message', (msg, rinfo) => {
  try {
    const pkt = parsePacket(msg);
    if (pkt.type === TYPE.HELLO && pkt.nodeId !== MY_NODE_ID) {
      console.log(` HELLO reçu de ${rinfo.address} (node: ${pkt.nodeId.slice(0, 16)}...)`);
      upsertPeer(pkt.nodeId, { ip: rinfo.address, tcpPort: pkt.payload.tcpPort });
      sendPeerList(rinfo.address, pkt.payload.replyPort || UDP_PORT);
    }
    if (pkt.type === TYPE.PEER_LIST && pkt.nodeId !== MY_NODE_ID) {
      const peers = pkt.payload.peers || [];
      peers.forEach(p => {
        if (p.nodeId !== MY_NODE_ID) {
          upsertPeer(p.nodeId, { ip: p.ip, tcpPort: p.tcpPort });
        }
      });
    }
  } catch (e) {}
});

udpSocket.on('error', (err) => console.error('UDP error:', err));

function sendHello() {
  const payload = { tcpPort: TCP_PORT, timestamp: Date.now() };
  const pkt = buildPacket(TYPE.HELLO, MY_NODE_ID, payload);
  udpSocket.send(pkt, UDP_PORT, MULTICAST_ADDR, (err) => {
    if (err) console.error('Erreur envoi HELLO:', err);
    else console.log(` HELLO envoyé sur le multicast`);
  });
}

function sendPeerList(targetIp, targetPort) {
  const peers = Array.from(peerTable.entries()).map(([nodeId, info]) => ({
    nodeId, ip: info.ip, tcpPort: info.tcpPort
  }));
  const pkt = buildPacket(TYPE.PEER_LIST, MY_NODE_ID, { peers });
  udpSocket.send(pkt, targetPort, targetIp);
}

const tcpServer = net.createServer(async (socket) => {
  console.log(` Connexion TCP entrante: ${socket.remoteAddress}`);

  let buffer = Buffer.alloc(0);
  let sessionKeys = null;

  const serverEphKeypair = crypto.generateEphemeralKeypair();
  const identity = crypto.loadIdentity();
  const handshakePayload = {
    ephPublicKey: serverEphKeypair.publicKey.toString('hex'),
    nodeId: MY_NODE_ID,
    signature: crypto.sign(serverEphKeypair.publicKey, identity.privateKey).toString('hex')
  };
  socket.write(buildPacket(TYPE.HANDSHAKE, MY_NODE_ID, handshakePayload));

  socket.on('data', async (data) => {
    buffer = Buffer.concat([buffer, data]);
    try {
      const pkt = parsePacket(buffer);
      buffer = Buffer.alloc(0);

      if (pkt.type === TYPE.HANDSHAKE && !sessionKeys) {
        const clientEphPub = Buffer.from(pkt.payload.ephPublicKey, 'hex');
        const clientNodeId = Buffer.from(pkt.payload.nodeId, 'hex');
        const sig = Buffer.from(pkt.payload.signature, 'hex');

        const valid = crypto.verify(clientEphPub, sig, clientNodeId);
        if (!valid) {
          console.log(' Signature invalide — connexion rejetée');
          socket.destroy();
          return;
        }

        sessionKeys = crypto.deriveSessionKeysServer(serverEphKeypair, clientEphPub);
        sessions.set(pkt.nodeId, sessionKeys);
        trust.markSeen(pkt.nodeId);
        console.log(` Session établie avec ${pkt.nodeId.slice(0, 16)}...`);
        return;
      }

      if (pkt.type === TYPE.MSG && sessionKeys) {
        const decrypted = crypto.decrypt(pkt.rawPayload, sessionKeys.rxKey);
        console.log(` Message reçu de ${pkt.nodeId.slice(0, 16)}...: ${decrypted.toString()}`);
        return;
      }
    } catch (e) {}
  });

  const pingInterval = setInterval(() => {
    if (!socket.destroyed) {
      socket.write(buildPacket(TYPE.ACK, MY_NODE_ID, { ping: true }));
    }
  }, 15000);

  socket.on('close', () => clearInterval(pingInterval));
  socket.on('error', () => clearInterval(pingInterval));
});

async function sendEncryptedMessage(targetNodeId, message) {
  const peer = peerTable.get(targetNodeId);
  if (!peer) {
    console.log(' Pair inconnu:', targetNodeId.slice(0, 16));
    return;
  }

  const identity = crypto.loadIdentity();
  const clientEphKeypair = crypto.generateEphemeralKeypair();
  const tcpClient = new net.Socket();

  tcpClient.connect(peer.tcpPort, peer.ip, () => {
    const sig = crypto.sign(clientEphKeypair.publicKey, identity.privateKey);
    const handshakePayload = {
      ephPublicKey: clientEphKeypair.publicKey.toString('hex'),
      nodeId: MY_NODE_ID,
      signature: sig.toString('hex')
    };
    tcpClient.write(buildPacket(TYPE.HANDSHAKE, MY_NODE_ID, handshakePayload));
  });

  let buffer = Buffer.alloc(0);
  let sessionKeys = null;

  tcpClient.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    try {
      const pkt = parsePacket(buffer);
      buffer = Buffer.alloc(0);

      if (pkt.type === TYPE.HANDSHAKE && !sessionKeys) {
        const serverEphPub = Buffer.from(pkt.payload.ephPublicKey, 'hex');
        const serverNodeId = Buffer.from(pkt.payload.nodeId, 'hex');
        const sig = Buffer.from(pkt.payload.signature, 'hex');

        const valid = crypto.verify(serverEphPub, sig, serverNodeId);
        if (!valid) {
          console.log(' Signature serveur invalide');
          tcpClient.destroy();
          return;
        }

        sessionKeys = crypto.deriveSessionKeysClient(clientEphKeypair, serverEphPub);
        console.log(` Session client établie avec ${pkt.nodeId.slice(0, 16)}...`);

        const encrypted = crypto.encrypt(Buffer.from(message), sessionKeys.txKey);
        tcpClient.write(buildPacket(TYPE.MSG, MY_NODE_ID, encrypted));
        console.log(`📤 Message chiffré envoyé à ${targetNodeId.slice(0, 16)}...`);
      }
    } catch (e) {}
  });

  tcpClient.on('error', (err) => console.error('TCP client error:', err.message));
}

// ── DÉMARRAGE ── (remplace les anciens appels directs)  ───────────────
async function main() {
  await crypto.init(); // ← attend que libsodium soit prêt
  console.log(' Cryptographie initialisée');

  udpSocket.bind(UDP_PORT);

  tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
    console.log(`\n  Nœud Archipel démarré`);
    console.log(` Node ID: ${MY_NODE_ID.slice(0, 32)}...`);
    console.log(` TCP sur port ${TCP_PORT}`);
    console.log(` UDP Multicast: ${MULTICAST_ADDR}:${UDP_PORT}\n`);
  });

  setInterval(sendHello, HELLO_INTERVAL);
  setInterval(cleanStalePeers, 30000);
  setInterval(displayPeerTable, 60000);
  setTimeout(displayPeerTable, 10000);
}

main().catch(console.error);

module.exports = { sendEncryptedMessage, peerTable };