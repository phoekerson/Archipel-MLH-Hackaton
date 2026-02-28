const fs = require('fs');
const path = require('path');

const TRUST_DB_PATH = path.join('.archipel', 'trust.json');

// Niveaux de confiance
const TRUST_LEVEL = {
  UNKNOWN: 0,    // pair jamais vu
  SEEN: 1,       // pair découvert automatiquement
  TRUSTED: 2,    // pair approuvé manuellement
  BLOCKED: -1    // pair bloqué
};

function loadTrustDB() {
  if (!fs.existsSync(TRUST_DB_PATH)) return {};
  return JSON.parse(fs.readFileSync(TRUST_DB_PATH));
}

function saveTrustDB(db) {
  fs.writeFileSync(TRUST_DB_PATH, JSON.stringify(db, null, 2));
}

function getTrust(nodeId) {
  const db = loadTrustDB();
  return db[nodeId]?.level ?? TRUST_LEVEL.UNKNOWN;
}

function setTrust(nodeId, level, label = '') {
  const db = loadTrustDB();
  db[nodeId] = { level, label, updatedAt: new Date().toISOString() };
  saveTrustDB(db);
  console.log(`🤝 Confiance mise à jour pour ${nodeId.slice(0, 16)}...: niveau ${level} (${label})`);
}

// Quand on voit un pair pour la première fois, on le marque SEEN
function markSeen(nodeId) {
  if (getTrust(nodeId) === TRUST_LEVEL.UNKNOWN) {
    setTrust(nodeId, TRUST_LEVEL.SEEN, 'auto-discovered');
  }
}

function isTrusted(nodeId) {
  return getTrust(nodeId) === TRUST_LEVEL.TRUSTED;
}

function isBlocked(nodeId) {
  return getTrust(nodeId) === TRUST_LEVEL.BLOCKED;
}

function listTrusted() {
  const db = loadTrustDB();
  return Object.entries(db)
    .filter(([, v]) => v.level === TRUST_LEVEL.TRUSTED)
    .map(([nodeId, v]) => ({ nodeId, ...v }));
}

function listAll() {
  return loadTrustDB();
}

module.exports = {
  TRUST_LEVEL,
  getTrust,
  setTrust,
  markSeen,
  isTrusted,
  isBlocked,
  listTrusted,
  listAll
};