const sodium = require('libsodium-wrappers');
const fs = require('fs');
const path = require('path');

let _sodium;

async function init() {
  await sodium.ready;
  _sodium = sodium;
}

// ── Chargement de l'identité ──────────────────────────────────────────
function loadIdentity() {
  const identityPath = path.join('.archipel', 'identity.json');
  const raw = JSON.parse(fs.readFileSync(identityPath));
  return {
    publicKey: Buffer.from(raw.publicKey, 'hex'),
    privateKey: Buffer.from(raw.privateKey, 'hex')
  };
}

// ── Signature Ed25519 ─────────────────────────────────────────────────
function sign(message, privateKey) {
  const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(message);
  return Buffer.from(_sodium.crypto_sign_detached(msgBuf, privateKey));
}

function verify(message, signature, publicKey) {
  try {
    const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(message);
    return _sodium.crypto_sign_verify_detached(signature, msgBuf, publicKey);
  } catch {
    return false;
  }
}

// ── Échange de clés Diffie-Hellman (X25519) ───────────────────────────
// Génère une paire de clés éphémères pour une session
function generateEphemeralKeypair() {
  const kp = _sodium.crypto_kx_keypair();
  return {
    publicKey: Buffer.from(kp.publicKey),
    privateKey: Buffer.from(kp.privateKey)
  };
}

// Côté client : dérive les clés de session à partir de la clé publique du serveur
function deriveSessionKeysClient(clientEphKeypair, serverEphPublicKey) {
  const result = _sodium.crypto_kx_client_session_keys(
    clientEphKeypair.publicKey,
    clientEphKeypair.privateKey,
    serverEphPublicKey
  );
  return {
    rxKey: Buffer.from(result.sharedRx), // pour déchiffrer les messages reçus
    txKey: Buffer.from(result.sharedTx)  // pour chiffrer les messages envoyés
  };
}

// Côté serveur
function deriveSessionKeysServer(serverEphKeypair, clientEphPublicKey) {
  const result = _sodium.crypto_kx_server_session_keys(
    serverEphKeypair.publicKey,
    serverEphKeypair.privateKey,
    clientEphPublicKey
  );
  return {
    rxKey: Buffer.from(result.sharedRx),
    txKey: Buffer.from(result.sharedTx)
  };
}

// ── Chiffrement/Déchiffrement XChaCha20-Poly1305 ──────────────────────
// Chaque message = nouveau nonce aléatoire (anti-pattern 3 évité)
function encrypt(plaintext, key) {
  const nonce = _sodium.randombytes_buf(_sodium.crypto_secretbox_NONCEBYTES);
  const msgBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const ciphertext = _sodium.crypto_secretbox_easy(msgBuf, nonce, key);
  // On préfixe le nonce au ciphertext pour pouvoir déchiffrer
  return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);
}

function decrypt(ciphertextWithNonce, key) {
  const nonceLen = _sodium.crypto_secretbox_NONCEBYTES;
  const nonce = ciphertextWithNonce.slice(0, nonceLen);
  const ciphertext = ciphertextWithNonce.slice(nonceLen);
  const plaintext = _sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  if (!plaintext) throw new Error('Déchiffrement échoué — paquet corrompu ou clé invalide');
  return Buffer.from(plaintext);
}

// ── HMAC-SHA256 pour les paquets ──────────────────────────────────────
function computeHMAC(data, key) {
  return Buffer.from(_sodium.crypto_auth(data, key));
}

function verifyHMAC(data, hmac, key) {
  try {
    return _sodium.crypto_auth_verify(hmac, data, key);
  } catch {
    return false;
  }
}

module.exports = {
  init,
  loadIdentity,
  sign,
  verify,
  generateEphemeralKeypair,
  deriveSessionKeysClient,
  deriveSessionKeysServer,
  encrypt,
  decrypt,
  computeHMAC,
  verifyHMAC
};