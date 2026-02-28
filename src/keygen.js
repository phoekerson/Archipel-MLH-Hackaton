const sodium = require('libsodium-wrappers');
const fs = require('fs');
const path = require('path');

async function generateKeys() {
  await sodium.ready;
  
  const keypair = sodium.crypto_sign_keypair();
  
  const keys = {
    publicKey: Buffer.from(keypair.publicKey).toString('hex'),
    privateKey: Buffer.from(keypair.privateKey).toString('hex')
  };
  
  const keystorePath = path.join('.archipel', 'identity.json');
  fs.mkdirSync('.archipel', { recursive: true });
  
  if (fs.existsSync(keystorePath)) {
    console.log('  Clés déjà existantes. Supprime .archipel/identity.json pour régénérer.');
    const existing = JSON.parse(fs.readFileSync(keystorePath));
    console.log(' Node ID (clé publique):', existing.publicKey);
    return;
  }
  
  fs.writeFileSync(keystorePath, JSON.stringify(keys, null, 2));
  console.log(' Clés générées avec succès !');
  console.log(' Node ID (clé publique):', keys.publicKey);
  console.log(' Clé privée stockée dans .archipel/identity.json');
}

generateKeys().catch(console.error);