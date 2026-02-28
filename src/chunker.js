const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const CHUNK_SIZE = 524288; 

// ── Découpe un fichier en chunks et retourne le manifest ──────────────
function createManifest(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const fileName = path.basename(filePath);
  const totalSize = fileBuffer.length;
  const chunks = [];

  let index = 0;
  let offset = 0;

  while (offset < fileBuffer.length) {
    const chunkData = fileBuffer.slice(offset, offset + CHUNK_SIZE);
    const chunkHash = crypto.createHash('sha256').update(chunkData).digest('hex');
    chunks.push({
      index,
      hash: chunkHash,
      size: chunkData.length
    });
    index++;
    offset += CHUNK_SIZE;
  }

  return {
    file_id: fileHash,
    file_name: fileName,
    total_size: totalSize,
    chunk_size: CHUNK_SIZE,
    total_chunks: chunks.length,
    chunks
  };
}

// ── Sauvegarde les chunks d'un fichier dans .archipel/chunks/ ─────────
function saveChunks(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const manifest = createManifest(filePath);
  const chunksDir = path.join('.archipel', 'chunks', manifest.file_id);

  fs.mkdirSync(chunksDir, { recursive: true });

  let offset = 0;
  for (const chunk of manifest.chunks) {
    const chunkData = fileBuffer.slice(offset, offset + chunk.size);
    fs.writeFileSync(path.join(chunksDir, `${chunk.index}.chunk`), chunkData);
    offset += chunk.size;
  }

  // Sauvegarder le manifest
  fs.writeFileSync(
    path.join('.archipel', 'chunks', `${manifest.file_id}.manifest`),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`📦 Fichier découpé en ${manifest.total_chunks} chunks`);
  console.log(`🔑 File ID: ${manifest.file_id}`);
  return manifest;
}

// ── Lire un chunk depuis le stockage local ────────────────────────────
function readChunk(fileId, chunkIndex) {
  const chunkPath = path.join('.archipel', 'chunks', fileId, `${chunkIndex}.chunk`);
  if (!fs.existsSync(chunkPath)) return null;
  return fs.readFileSync(chunkPath);
}

// ── Vérifier l'intégrité d'un chunk ──────────────────────────────────
function verifyChunk(chunkData, expectedHash) {
  const actualHash = crypto.createHash('sha256').update(chunkData).digest('hex');
  return actualHash === expectedHash;
}

// ── Reassembler un fichier depuis ses chunks ──────────────────────────
function assembleFile(fileId, outputDir) {
  const manifestPath = path.join('.archipel', 'chunks', `${fileId}.manifest`);
  if (!fs.existsSync(manifestPath)) throw new Error('Manifest introuvable');

  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const chunks = [];

  for (const chunk of manifest.chunks) {
    const chunkData = readChunk(fileId, chunk.index);
    if (!chunkData) throw new Error(`Chunk manquant: ${chunk.index}`);

    if (!verifyChunk(chunkData, chunk.hash)) {
      throw new Error(`Chunk corrompu: ${chunk.index}`);
    }

    chunks.push(chunkData);
  }

  const finalBuffer = Buffer.concat(chunks);

  // Vérification SHA-256 finale du fichier complet
  const finalHash = crypto.createHash('sha256').update(finalBuffer).digest('hex');
  if (finalHash !== fileId) throw new Error('Hash fichier final invalide !');

  const outputPath = path.join(outputDir, manifest.file_name);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, finalBuffer);

  console.log(`✅ Fichier assemblé: ${outputPath}`);
  console.log(`🔒 SHA-256 vérifié: ${finalHash}`);
  return outputPath;
}

// ── Lister les fichiers disponibles localement ────────────────────────
function listAvailableFiles() {
  const chunksDir = path.join('.archipel', 'chunks');
  if (!fs.existsSync(chunksDir)) return [];

  return fs.readdirSync(chunksDir)
    .filter(f => f.endsWith('.manifest'))
    .map(f => {
      const manifest = JSON.parse(fs.readFileSync(path.join(chunksDir, f)));
      return {
        file_id: manifest.file_id,
        file_name: manifest.file_name,
        total_size: manifest.total_size,
        total_chunks: manifest.total_chunks
      };
    });
}

module.exports = { createManifest, saveChunks, readChunk, verifyChunk, assembleFile, listAvailableFiles, CHUNK_SIZE };