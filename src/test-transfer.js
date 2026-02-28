const { saveChunks } = require('./chunker');
const { downloadFile } = require('./transfer');
const { peerTable } = require('./node');

const args = process.argv.slice(2);
const mode = args[0]; // 'seed' ou 'download'

if (mode === 'seed') {
  // ── Mode seed : découper le fichier et attendre les requêtes ──────────
  const filePath = args[1];
  if (!filePath) {
    console.error('Usage: node src/test-transfer.js seed <filepath>');
    process.exit(1);
  }

  const manifest = saveChunks(filePath);
  console.log('\n Fichier disponible pour téléchargement :');
  console.log(`   File ID : ${manifest.file_id}`);
  console.log(`   Chunks  : ${manifest.total_chunks}`);
  console.log(`   Taille  : ${(manifest.total_size / 1024 / 1024).toFixed(2)} Mo`);
  console.log('\n En attente de requêtes des autres nœuds...\n');
  console.log(' Sur PC2, lance :');
  console.log(`   node src/test-transfer.js download ${manifest.file_id}\n`);

} else if (mode === 'download') {
  // ── Mode download : récupérer manifest + chunks automatiquement ───────
  const fileId = args[1];
  if (!fileId) {
    console.error('Usage: node src/test-transfer.js download <file_id>');
    process.exit(1);
  }

  console.log(`\n Attente de la découverte des pairs (15 secondes)...`);

  setTimeout(async () => {
    if (peerTable.size === 0) {
      console.error(' Aucun pair découvert. Vérifie que PC1 tourne bien sur le même réseau.');
      process.exit(1);
    }

    console.log(` ${peerTable.size} pair(s) trouvé(s)`);

    const identity = require('fs').readFileSync('.archipel/identity.json');
    const myNodeId = JSON.parse(identity).publicKey;

    try {
      // downloadFile récupère le manifest automatiquement puis télécharge les chunks
      const outputPath = await downloadFile(fileId, peerTable, myNodeId, './downloads');
      console.log(`\n Téléchargement terminé : ${outputPath}`);
    } catch (err) {
      console.error(' Erreur:', err.message);
    }
  }, 15000);

} else {
  console.log('Usage:');
  console.log('  node src/test-transfer.js seed <filepath>     → partager un fichier');
  console.log('  node src/test-transfer.js download <file_id>  → télécharger un fichier');
}