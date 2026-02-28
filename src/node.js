require('dotenv').config();
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { TYPE, buildPacket, parsePacket } = require('./packet');

// ── Chargement de l'identité ──────────────────────────────────────────
const identityPath = path.join('.archipel', 'identity.json');
if (!fs.existsSync(identityPath)) {
  console.error('❌ Aucune clé trouvée. Lance d\'abord : node src/keygen.js');
  process.exit(1);
}
const identity = JSON.parse(fs.readFileSync(identityPath));
const MY_NODE_ID = identity.publicKey;

const UDP_PORT = parseInt(process.env.UDP_PORT) || 6000;
const TCP_PORT = parseInt(process.env.TCP_PORT) || 7777;
const MULTICAST_ADDR = process.env.UDP_MULTICAST_ADDR || '239.255.42.99';
const HELLO_INTERVAL = 30000; // 30 secondes
const PEER_TIMEOUT = 90000;   // 90 secondes

// ── Table des pairs ───────────────────────────────────────────────────
const peerTable = new Map();

function upsertPeer(nodeId, info) {
  peerTable.set(nodeId, { ...info, lastSeen: Date.now() });
  console.log(`📡 Pair connu: ${nodeId.slice(0, 16)}... @ ${info.ip}:${info.tcpPort}`);
}

function cleanStalePeers() {
  const now = Date.now();
  for (const [id, peer] of peerTable.entries()) {
    if (now - peer.lastSeen > PEER_TIMEOUT) {
      console.log(`💀 Pair mort (timeout): ${id.slice(0, 16)}...`);
      peerTable.delete(id);
    }
  }
}

function displayPeerTable() {
  console.log('\n══ PEER TABLE ══════════════════════════════');
  if (peerTable.size === 0) {
    console.log('  (aucun pair)');
  }
  for (const [id, peer] of peerTable.entries()) {
    const age = Math.round((Date.now() - peer.lastSeen) / 1000);
    console.log(`  ${id.slice(0, 16)}... | ${peer.ip}:${peer.tcpPort} | vu il y a ${age}s`);
  }
  console.log('═══════════════════════════════════════════\n');
}

// ── UDP Multicast — Découverte ────────────────────────────────────────
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('listening', () => {
  udpSocket.addMembership(MULTICAST_ADDR);
  udpSocket.setMulticastTTL(128);
  console.log(`📻 UDP Multicast en écoute sur ${MULTICAST_ADDR}:${UDP_PORT}`);
  sendHello(); // HELLO immédiat au démarrage
});

udpSocket.on('message', (msg, rinfo) => {
  try {
    const pkt = parsePacket(msg);
    if (pkt.type === TYPE.HELLO && pkt.nodeId !== MY_NODE_ID) {
      console.log(`👋 HELLO reçu de ${rinfo.address} (node: ${pkt.nodeId.slice(0, 16)}...)`);
      upsertPeer(pkt.nodeId, {
        ip: rinfo.address,
        tcpPort: pkt.payload.tcpPort
      });
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
  } catch (e) {
    // paquet invalide, on ignore
  }
});

udpSocket.on('error', (err) => console.error('UDP error:', err));

function sendHello() {
  const payload = { tcpPort: TCP_PORT, timestamp: Date.now() };
  const pkt = buildPacket(TYPE.HELLO, MY_NODE_ID, payload);
  udpSocket.send(pkt, UDP_PORT, MULTICAST_ADDR, (err) => {
    if (err) console.error('Erreur envoi HELLO:', err);
    else console.log(`📢 HELLO envoyé sur le multicast`);
  });
}

function sendPeerList(targetIp, targetPort) {
  const peers = Array.from(peerTable.entries()).map(([nodeId, info]) => ({
    nodeId, ip: info.ip, tcpPort: info.tcpPort
  }));
  const payload = { peers };
  const pkt = buildPacket(TYPE.PEER_LIST, MY_NODE_ID, payload);
  udpSocket.send(pkt, targetPort, targetIp);
}

// ── TCP Server ────────────────────────────────────────────────────────
const tcpServer = net.createServer((socket) => {
  console.log(`🔌 Connexion TCP entrante: ${socket.remoteAddress}:${socket.remotePort}`);
  
  let buffer = Buffer.alloc(0);
  
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    try {
      const pkt = parsePacket(buffer);
      console.log(`📨 Paquet TCP reçu, type: 0x${pkt.type.toString(16)}`);
      buffer = Buffer.alloc(0);
    } catch (e) {
      // paquet incomplet, on attend plus de données
    }
  });
  
  // Keep-alive ping/pong toutes les 15 secondes
  const pingInterval = setInterval(() => {
    if (!socket.destroyed) {
      const ping = buildPacket(TYPE.ACK, MY_NODE_ID, { ping: true });
      socket.write(ping);
    }
  }, 15000);
  
  socket.on('close', () => clearInterval(pingInterval));
  socket.on('error', (err) => { clearInterval(pingInterval); });
});

// ── Démarrage ─────────────────────────────────────────────────────────
udpSocket.bind(UDP_PORT);

tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  console.log(`\n🏝️  Nœud Archipel démarré`);
  console.log(`🔑 Node ID: ${MY_NODE_ID.slice(0, 32)}...`);
  console.log(`📡 TCP sur port ${TCP_PORT}`);
  console.log(`📻 UDP Multicast: ${MULTICAST_ADDR}:${UDP_PORT}\n`);
});

// ── Boucles périodiques ───────────────────────────────────────────────
setInterval(sendHello, HELLO_INTERVAL);
setInterval(cleanStalePeers, 30000);
setInterval(displayPeerTable, 60000);

// Affichage immédiat de la peer table après 10s
setTimeout(displayPeerTable, 10000);