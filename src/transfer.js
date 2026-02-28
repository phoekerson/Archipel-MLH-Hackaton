const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TYPE, buildPacket, parsePacket } = require('./packet');
const { readChunk, verifyChunk, assembleFile } = require('./chunker');

const PARALLEL_DOWNLOADS = 3;

// ── Récupérer le manifest depuis un pair via le protocole ─────────────
// Plus besoin de copier le manifest manuellement !
function fetchManifest(fileId, peer, myNodeId) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Timeout lors de la récupération du manifest'));
    }, 10000);

    client.connect(peer.tcpPort, peer.ip, () => {
      // Demander le manifest via le protocole Archipel
      client.write(buildPacket(TYPE.MANIFEST, myNodeId, { file_id: fileId }));
    });

    let buffer = Buffer.alloc(0);

    client.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        const pkt = parsePacket(buffer);
        buffer = Buffer.alloc(0);

        if (pkt.type === TYPE.MANIFEST) {
          clearTimeout(timeout);
          client.destroy();

          if (pkt.payload.error) {
            return reject(new Error(`Manifest non trouvé chez ce pair: ${pkt.payload.error}`));
          }

          const manifest = pkt.payload.manifest;

          // Sauvegarder le manifest localement pour les prochaines fois
          const chunksDir = path.join('.archipel', 'chunks');
          fs.mkdirSync(chunksDir, { recursive: true });
          fs.writeFileSync(
            path.join(chunksDir, `${fileId}.manifest`),
            JSON.stringify(manifest, null, 2)
          );

          console.log(`📋 Manifest reçu : ${manifest.file_name} (${manifest.total_chunks} chunks, ${(manifest.total_size / 1024 / 1024).toFixed(2)} Mo)`);
          resolve(manifest);
        }
      } catch (e) {
        // paquet incomplet, attendre
      }
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Télécharger un fichier depuis les pairs ───────────────────────────
async function downloadFile(fileId, peers, myNodeId, outputDir = './downloads') {
  const peerList = Array.from(peers.values());
  if (peerList.length === 0) throw new Error('Aucun pair disponible');

  // Étape 1 : récupérer le manifest automatiquement depuis le premier pair
  console.log(`\n Récupération du manifest depuis les pairs...`);
  let manifest = null;

  for (const peer of peerList) {
    try {
      manifest = await fetchManifest(fileId, peer, myNodeId);
      break; // manifest trouvé, on arrête
    } catch (err) {
      console.log(`  Pair ${peer.ip} n'a pas le manifest, essai suivant...`);
    }
  }

  if (!manifest) throw new Error('Aucun pair ne possède ce manifest');

  // Étape 2 : télécharger les chunks en parallèle
  const { total_chunks, chunks, file_name } = manifest;
  const downloaded = new Set();
  const failed = new Set();

  const chunksDir = path.join('.archipel', 'chunks', fileId);
  fs.mkdirSync(chunksDir, { recursive: true });

  console.log(`\n📥 Début du téléchargement : ${file_name}`);
  console.log(` ${total_chunks} chunks à télécharger\n`);

  const pendingChunks = chunks.map(c => c.index);

  while (pendingChunks.length > 0 || failed.size > 0) {
    const retries = Array.from(failed);
    failed.clear();
    const batch = [...retries, ...pendingChunks.splice(0, PARALLEL_DOWNLOADS - retries.length)];

    await Promise.all(batch.map(chunkIndex =>
      downloadChunk(fileId, chunkIndex, chunks[chunkIndex].hash, peers, myNodeId)
        .then(() => {
          downloaded.add(chunkIndex);
          const progress = Math.round((downloaded.size / total_chunks) * 100);
          process.stdout.write(`\r📦 Progression : ${downloaded.size}/${total_chunks} chunks (${progress}%)`);
        })
        .catch(() => {
          failed.add(chunkIndex);
        })
    ));
  }

  // Étape 3 : assembler et vérifier le fichier
  console.log('\n\n🔧 Assemblage et vérification SHA-256...');
  return assembleFile(fileId, outputDir);
}

// ── Télécharger un chunk depuis un pair ───────────────────────────────
function downloadChunk(fileId, chunkIndex, expectedHash, peers, myNodeId) {
  return new Promise((resolve, reject) => {
    const peerList = Array.from(peers.values());
    if (peerList.length === 0) return reject(new Error('Aucun pair'));

    const peer = peerList[Math.floor(Math.random() * peerList.length)];
    const client = new net.Socket();

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error(`Timeout chunk ${chunkIndex}`));
    }, 10000);

    client.connect(peer.tcpPort, peer.ip, () => {
      const reqPayload = Buffer.allocUnsafe(68);
      Buffer.from(fileId, 'hex').copy(reqPayload, 0);
      reqPayload.writeUInt32BE(chunkIndex, 32);
      Buffer.from(myNodeId, 'hex').copy(reqPayload, 36);
      client.write(buildPacket(TYPE.CHUNK_REQ, myNodeId, reqPayload));
    });

    let buffer = Buffer.alloc(0);

    client.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        const pkt = parsePacket(buffer);
        buffer = Buffer.alloc(0);

        if (pkt.type === TYPE.CHUNK_DATA) {
          const chunkData = pkt.rawPayload.slice(0, pkt.rawPayload.length - 32);

          if (!verifyChunk(chunkData, expectedHash)) {
            clearTimeout(timeout);
            client.destroy();
            return reject(new Error(`Hash invalide chunk ${chunkIndex}`));
          }

          const chunkPath = path.join('.archipel', 'chunks', fileId, `${chunkIndex}.chunk`);
          fs.writeFileSync(chunkPath, chunkData);

          clearTimeout(timeout);
          client.destroy();
          resolve();
        }

        if (pkt.type === TYPE.ACK && pkt.payload?.status === 0x02) {
          clearTimeout(timeout);
          client.destroy();
          reject(new Error(`Chunk ${chunkIndex} non trouvé chez ce pair`));
        }
      } catch (e) {
        // paquet incomplet
      }
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

module.exports = { downloadFile, fetchManifest };