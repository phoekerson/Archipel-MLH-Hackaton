require('dotenv').config();
const cryptoModule = require('./crypto');
const trust = require('./trust');
const { startWebServer, addIncomingMessage, loadProfile } = require('./server');
const { saveChunks } = require('./chunker');
const { downloadFile } = require('./transfer');

const sessions = new Map();
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { TYPE, buildPacket, parsePacket } = require('./packet');

const identityPath = path.join('.archipel', 'identity.json');
let MY_NODE_ID = null;

// Chargement différé de l'identité (peut ne pas exister au 1er lancement)
function getMyNodeId() {
  if (!MY_NODE_ID && fs.existsSync(identityPath)) {
    MY_NODE_ID = JSON.parse(fs.readFileSync(identityPath)).publicKey;
  }
  return MY_NODE_ID || 'pending';
}

const UDP_PORT = parseInt(process.env.UDP_PORT) || 6000;
const TCP_PORT = parseInt(process.env.TCP_PORT) || 7777;
const MULTICAST_ADDR = process.env.UDP_MULTICAST_ADDR || '239.255.42.99';
const HELLO_INTERVAL = 30000;
const PEER_TIMEOUT = 90000;

const peerTable = new Map();

function upsertPeer(nodeId, info) {
  peerTable.set(nodeId, { ...info, lastSeen: Date.now() });
  const name = info.displayName || nodeId.slice(0, 12);
  console.log(`📡 Pair : ${name} @ ${info.ip}:${info.tcpPort}`);
}

function cleanStalePeers() {
  const now = Date.now();
  for (const [id, peer] of peerTable.entries()) {
    if (now - peer.lastSeen > PEER_TIMEOUT) {
      console.log(`💀 ${peer.displayName || id.slice(0, 12)} hors ligne`);
      peerTable.delete(id);
    }
  }
}

// ── UDP Multicast ──────────────────────────────────────────────────────
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('listening', () => {
  udpSocket.addMembership(MULTICAST_ADDR);
  udpSocket.setMulticastTTL(128);
  console.log(`📻 UDP Multicast actif sur ${MULTICAST_ADDR}:${UDP_PORT}`);
  if (getMyNodeId() !== 'pending') sendHello();
});

udpSocket.on('message', (msg, rinfo) => {
  try {
    const pkt = parsePacket(msg);
    const myId = getMyNodeId();

    if (pkt.type === TYPE.HELLO && pkt.nodeId !== myId) {
      upsertPeer(pkt.nodeId, {
        ip: rinfo.address,
        tcpPort: pkt.payload.tcpPort,
        displayName: pkt.payload.displayName || null
      });
      sendPeerList(rinfo.address, pkt.payload.replyPort || UDP_PORT);
    }

    if (pkt.type === TYPE.PEER_LIST && pkt.nodeId !== myId) {
      const peers = pkt.payload.peers || [];
      peers.forEach(p => {
        if (p.nodeId !== myId) {
          upsertPeer(p.nodeId, {
            ip: p.ip,
            tcpPort: p.tcpPort,
            displayName: p.displayName || null
          });
        }
      });
    }
  } catch (e) {}
});

udpSocket.on('error', (err) => console.error('UDP error:', err));

function sendHello() {
  const myId = getMyNodeId();
  if (myId === 'pending') return;

  const profile = loadProfile();
  const payload = {
    tcpPort: TCP_PORT,
    timestamp: Date.now(),
    displayName: profile?.displayName || null
  };
  const pkt = buildPacket(TYPE.HELLO, myId, payload);
  udpSocket.send(pkt, UDP_PORT, MULTICAST_ADDR, (err) => {
    if (!err) console.log(`📢 HELLO envoyé (${profile?.displayName || myId.slice(0, 12)})`);
  });
}

function sendPeerList(targetIp, targetPort) {
  const myId = getMyNodeId();
  if (myId === 'pending') return;

  const peers = Array.from(peerTable.entries()).map(([nodeId, info]) => ({
    nodeId,
    ip: info.ip,
    tcpPort: info.tcpPort,
    displayName: info.displayName
  }));
  const pkt = buildPacket(TYPE.PEER_LIST, myId, { peers });
  udpSocket.send(pkt, targetPort, targetIp);
}

// ── TCP Server ──────────────────────────────────────────────────────────
const tcpServer = net.createServer(async (socket) => {
  let buffer = Buffer.alloc(0);
  let sessionKeys = null;
  let remoteNodeId = null;

  // Attendre que l'identité soit disponible
  const myId = getMyNodeId();
  if (myId === 'pending') { socket.destroy(); return; }

  const serverEphKeypair = cryptoModule.generateEphemeralKeypair();
  const identity = cryptoModule.loadIdentity();
  const handshakePayload = {
    ephPublicKey: serverEphKeypair.publicKey.toString('hex'),
    nodeId: myId,
    signature: cryptoModule.sign(serverEphKeypair.publicKey, identity.privateKey).toString('hex')
  };
  socket.write(buildPacket(TYPE.HANDSHAKE, myId, handshakePayload));

  socket.on('data', async (data) => {
    buffer = Buffer.concat([buffer, data]);
    try {
      const pkt = parsePacket(buffer);
      buffer = Buffer.alloc(0);

      // ── Handshake ──
      if (pkt.type === TYPE.HANDSHAKE && !sessionKeys) {
        const clientEphPub = Buffer.from(pkt.payload.ephPublicKey, 'hex');
        const clientNodeId = Buffer.from(pkt.payload.nodeId, 'hex');
        const sig = Buffer.from(pkt.payload.signature, 'hex');

        const valid = cryptoModule.verify(clientEphPub, sig, clientNodeId);
        if (!valid) { socket.destroy(); return; }

        remoteNodeId = pkt.nodeId;
        sessionKeys = cryptoModule.deriveSessionKeysServer(serverEphKeypair, clientEphPub);
        sessions.set(pkt.nodeId, sessionKeys);
        trust.markSeen(pkt.nodeId);

        const peer = peerTable.get(pkt.nodeId);
        console.log(`🔐 Session avec ${peer?.displayName || pkt.nodeId.slice(0, 12)}`);
        return;
      }

      // ── Message chiffré ──
      if (pkt.type === TYPE.MSG && sessionKeys) {
        const decrypted = cryptoModule.decrypt(pkt.rawPayload, sessionKeys.rxKey);
        const text = decrypted.toString();
        const peer = peerTable.get(pkt.nodeId);
        const fromName = peer?.displayName || pkt.nodeId.slice(0, 8);
        console.log(`💬 ${fromName}: ${text}`);
        addIncomingMessage(pkt.nodeId, fromName, text);
        return;
      }

      // ── Requête manifest ──
      if (pkt.type === TYPE.MANIFEST) {
        const fileId = pkt.payload.file_id;
        const manifestPath = path.join('.archipel', 'chunks', `${fileId}.manifest`);

        if (!fs.existsSync(manifestPath)) {
          socket.write(buildPacket(TYPE.MANIFEST, myId, { error: 'not_found', file_id: fileId }));
          return;
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath));
        socket.write(buildPacket(TYPE.MANIFEST, myId, { manifest }));
        return;
      }

      // ── Requête chunk ──
      if (pkt.type === TYPE.CHUNK_REQ) {
        const { readChunk } = require('./chunker');
        const crypto_node = require('crypto');
        const fileId = pkt.rawPayload.slice(0, 32).toString('hex');
        const chunkIndex = pkt.rawPayload.readUInt32BE(32);
        const chunkData = readChunk(fileId, chunkIndex);

        if (!chunkData) {
          socket.write(buildPacket(TYPE.ACK, myId, { status: 0x02, chunk_idx: chunkIndex }));
          return;
        }

        const hash = crypto_node.createHash('sha256').update(chunkData).digest();
        socket.write(buildPacket(TYPE.CHUNK_DATA, myId, Buffer.concat([chunkData, hash])));
        return;
      }

    } catch (e) {}
  });

  const pingInterval = setInterval(() => {
    if (!socket.destroyed) socket.write(buildPacket(TYPE.ACK, myId, { ping: true }));
  }, 15000);

  socket.on('close', () => clearInterval(pingInterval));
  socket.on('error', () => clearInterval(pingInterval));
});

// ── Envoyer un message chiffré ─────────────────────────────────────────
async function sendEncryptedMessage(targetNodeId, message) {
  const peer = peerTable.get(targetNodeId);
  if (!peer) throw new Error('Pair introuvable');

  const myId = getMyNodeId();
  const identity = cryptoModule.loadIdentity();
  const clientEphKeypair = cryptoModule.generateEphemeralKeypair();
  const tcpClient = new net.Socket();

  tcpClient.connect(peer.tcpPort, peer.ip, () => {
    const sig = cryptoModule.sign(clientEphKeypair.publicKey, identity.privateKey);
    tcpClient.write(buildPacket(TYPE.HANDSHAKE, myId, {
      ephPublicKey: clientEphKeypair.publicKey.toString('hex'),
      nodeId: myId,
      signature: sig.toString('hex')
    }));
  });

  return new Promise((resolve, reject) => {
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

          if (!cryptoModule.verify(serverEphPub, sig, serverNodeId)) {
            tcpClient.destroy();
            return reject(new Error('Signature serveur invalide'));
          }

          sessionKeys = cryptoModule.deriveSessionKeysClient(clientEphKeypair, serverEphPub);
          const encrypted = cryptoModule.encrypt(Buffer.from(message), sessionKeys.txKey);
          tcpClient.write(buildPacket(TYPE.MSG, myId, encrypted));
          setTimeout(() => { tcpClient.destroy(); resolve(); }, 500);
        }
      } catch (e) {}
    });

    tcpClient.on('error', reject);
    setTimeout(() => { tcpClient.destroy(); reject(new Error('Timeout')); }, 10000);
  });
}

// ── Générer les clés (appelé à l'inscription) ─────────────────────────
async function runKeygen() {
  const sodium = require('libsodium-wrappers');
  await sodium.ready;

  if (fs.existsSync(identityPath)) return; // déjà générées

  const keypair = sodium.crypto_sign_keypair();
  const keys = {
    publicKey: Buffer.from(keypair.publicKey).toString('hex'),
    privateKey: Buffer.from(keypair.privateKey).toString('hex')
  };

  fs.mkdirSync('.archipel', { recursive: true });
  fs.writeFileSync(identityPath, JSON.stringify(keys, null, 2));
  MY_NODE_ID = keys.publicKey;
  console.log('🔑 Clés générées automatiquement');

  // Démarrer les HELLO maintenant que l'identité existe
  sendHello();
}

// ── Démarrage ─────────────────────────────────────────────────────────
async function main() {
  await cryptoModule.init();
  console.log('✅ Cryptographie prête');

  // Charger l'identité si elle existe déjà
  if (fs.existsSync(identityPath)) {
    MY_NODE_ID = JSON.parse(fs.readFileSync(identityPath)).publicKey;
    console.log(`🔑 Identité chargée : ${MY_NODE_ID.slice(0, 16)}...`);
  }

  udpSocket.bind(UDP_PORT);
  tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
    console.log(`📡 TCP actif sur le port ${TCP_PORT}`);
  });

  startWebServer(peerTable, getMyNodeId, sendEncryptedMessage, saveChunks, downloadFile, runKeygen);

  setInterval(sendHello, HELLO_INTERVAL);
  setInterval(cleanStalePeers, 30000);
}

main().catch(console.error);

module.exports = { sendEncryptedMessage, peerTable };