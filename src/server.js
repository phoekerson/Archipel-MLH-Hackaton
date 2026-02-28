const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto_node = require('crypto');
const { queryGemini } = require('./gemini');

const messageHistory = [];
const incomingFiles = []; // fichiers reçus en attente

// ── Profil utilisateur ────────────────────────────────────────────────
function loadProfile() {
  const p = path.join('.archipel', 'profile.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p));
}

function saveProfile(data) {
  fs.mkdirSync('.archipel', { recursive: true });
  fs.writeFileSync(path.join('.archipel', 'profile.json'), JSON.stringify(data, null, 2));
}

function hashPassword(password) {
  return crypto_node.createHash('sha256').update(password + 'archipel_salt').digest('hex');
}

// ── Serveur HTTP ──────────────────────────────────────────────────────
function startWebServer(peerTable, getMyNodeId, sendEncryptedMessage, saveChunks, downloadFile, runKeygen) {
  const UI_PORT = parseInt(process.env.UI_PORT) || 8080;

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${UI_PORT}`);

    // ── Servir l'UI ────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/') {
      const uiPath = path.join(__dirname, '..', 'public', 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(uiPath).pipe(res);
      return;
    }

    // ── Vérifier si l'utilisateur est déjà inscrit ─────────────────────
    if (req.method === 'GET' && url.pathname === '/api/auth/check') {
      const profile = loadProfile();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ registered: !!profile, name: profile?.firstName }));
      return;
    }

    // ── Inscription (génère les clés automatiquement) ──────────────────
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = JSON.parse(await readBody(req));
      const { firstName, lastName, password } = body;

      if (!firstName || !lastName || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Tous les champs sont requis' }));
        return;
      }

      // Générer les clés automatiquement
      await runKeygen();

      // Sauvegarder le profil
      saveProfile({
        firstName,
        lastName,
        displayName: `${firstName} ${lastName}`,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString()
      });

      console.log(`✅ Utilisateur enregistré : ${firstName} ${lastName}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, displayName: `${firstName} ${lastName}` }));
      return;
    }

    // ── Connexion ──────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = JSON.parse(await readBody(req));
      const { password } = body;
      const profile = loadProfile();

      if (!profile) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Aucun profil trouvé' }));
        return;
      }

      if (profile.passwordHash !== hashPassword(password)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Mot de passe incorrect' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, displayName: profile.displayName }));
      return;
    }

    // ── Statut du réseau (pairs avec leurs noms) ───────────────────────
    if (req.method === 'GET' && url.pathname === '/api/network') {
      const profile = loadProfile();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        me: {
          displayName: profile?.displayName || 'Moi',
          nodeId: getMyNodeId().slice(0, 16) + '...',
          online: true
        },
        peers: Array.from(peerTable.entries()).map(([id, p]) => ({
          nodeId: id,
          displayName: p.displayName || `Nœud ${id.slice(0, 8)}`,
          ip: p.ip,
          lastSeen: p.lastSeen,
          online: (Date.now() - p.lastSeen) < 90000
        })),
        uptime: process.uptime()
      }));
      return;
    }

    // ── Envoyer un message (par nodeId, abstrait pour l'UI) ────────────
    if (req.method === 'POST' && url.pathname === '/api/chat/send') {
      const body = JSON.parse(await readBody(req));
      const { targetNodeId, message } = body;
      const profile = loadProfile();

      messageHistory.push({
        id: Date.now(),
        from: 'me',
        fromName: profile?.displayName || 'Moi',
        to: targetNodeId,
        text: message,
        ts: Date.now()
      });

      try {
        await sendEncryptedMessage(targetNodeId, message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Récupérer les messages d'une conversation ──────────────────────
    if (req.method === 'GET' && url.pathname.startsWith('/api/chat/')) {
      const nodeId = url.pathname.split('/').pop();
      const conv = messageHistory.filter(m => m.to === nodeId || m.from === nodeId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(conv));
      return;
    }

    // ── Partager un fichier (chemin local) ─────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/files/share') {
      const body = JSON.parse(await readBody(req));
      const { filePath } = body;

      try {
        const manifest = saveChunks(filePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          file: {
            name: manifest.file_name,
            size: manifest.total_size,
            fileId: manifest.file_id // caché de l'UI principale
          }
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Télécharger un fichier (par fileId, passé en interne) ──────────
    if (req.method === 'POST' && url.pathname === '/api/files/download') {
      const body = JSON.parse(await readBody(req));
      const { fileId } = body;
      const identityRaw = JSON.parse(fs.readFileSync('.archipel/identity.json'));

      try {
        const outputPath = await downloadFile(fileId, peerTable, identityRaw.publicKey, './downloads');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, outputPath }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Lister les fichiers disponibles sur le réseau ──────────────────
    if (req.method === 'GET' && url.pathname === '/api/files') {
      const { listAvailableFiles } = require('./chunker');
      const local = listAvailableFiles();

      // Fusionner fichiers locaux + fichiers annoncés par les pairs
      const networkFiles = [];
      for (const [nodeId, peer] of peerTable.entries()) {
        if (peer.sharedFiles) {
          peer.sharedFiles.forEach(f => {
            networkFiles.push({
              ...f,
              ownerName: peer.displayName || nodeId.slice(0, 8),
              ownerNodeId: nodeId,
              source: 'network'
            });
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        local: local.map(f => ({ ...f, source: 'local' })),
        network: networkFiles,
        incoming: incomingFiles
      }));
      return;
    }

    // ── Gemini AI ──────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/ai/ask') {
      const body = JSON.parse(await readBody(req));
      const { query } = body;
      const context = messageHistory.slice(-10).map(m => ({ from: m.fromName, text: m.text }));
      const result = await queryGemini(context, query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(UI_PORT, '0.0.0.0', () => {
    console.log(`\n🌐 Interface web : http://localhost:${UI_PORT}`);
  });

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Appelé depuis node.js quand un message est reçu
function addIncomingMessage(fromNodeId, fromName, text) {
  messageHistory.push({
    id: Date.now(),
    from: fromNodeId,
    fromName: fromName || fromNodeId.slice(0, 8),
    to: 'me',
    text,
    ts: Date.now()
  });
}

// Appelé depuis node.js quand un fichier est annoncé
function addIncomingFile(fromNodeId, fromName, fileInfo) {
  incomingFiles.push({ ...fileInfo, fromNodeId, fromName, ts: Date.now() });
}

module.exports = { startWebServer, addIncomingMessage, addIncomingFile, loadProfile };