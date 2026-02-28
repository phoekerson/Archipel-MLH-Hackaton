const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto_node = require('crypto');
const { queryGemini } = require('./gemini');

// Historique des messages : nodeId -> [messages]
const conversations = new Map();

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

// ── Gestion des conversations ─────────────────────────────────────────
function getConv(nodeId) {
  if (!conversations.has(nodeId)) conversations.set(nodeId, []);
  return conversations.get(nodeId);
}

function addMsg(nodeId, msg) {
  getConv(nodeId).push({ ...msg, id: Date.now() + Math.random() });
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

    // ── UI ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/') {
      const uiPath = path.join(__dirname, '..', 'public', 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(uiPath).pipe(res);
      return;
    }

    // ── Auth : vérification ────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/auth/check') {
      const profile = loadProfile();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ registered: !!profile, name: profile?.firstName }));
      return;
    }

    // ── Auth : inscription ─────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = JSON.parse(await readBody(req));
      const { firstName, lastName, password } = body;

      if (!firstName || !lastName || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Tous les champs sont requis' }));
        return;
      }

      await runKeygen();
      saveProfile({
        firstName, lastName,
        displayName: `${firstName} ${lastName}`,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString()
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, displayName: `${firstName} ${lastName}` }));
      return;
    }

    // ── Auth : connexion ───────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = JSON.parse(await readBody(req));
      const profile = loadProfile();

      if (!profile) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Aucun profil trouvé' }));
        return;
      }

      if (profile.passwordHash !== hashPassword(body.password)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Mot de passe incorrect' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, displayName: profile.displayName }));
      return;
    }

    // ── Réseau ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/network') {
      const profile = loadProfile();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        me: { displayName: profile?.displayName || 'Moi', online: true },
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

    // ── Chat : récupérer une conversation ──────────────────────────────
    if (req.method === 'GET' && url.pathname.startsWith('/api/chat/')) {
      const nodeId = url.pathname.split('/').pop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getConv(nodeId)));
      return;
    }

    // ── Chat : envoyer un message texte ────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/chat/send') {
      const body = JSON.parse(await readBody(req));
      const { targetNodeId, message } = body;
      const profile = loadProfile();

      addMsg(targetNodeId, {
        from: 'me',
        fromName: profile?.displayName || 'Moi',
        to: targetNodeId,
        type: 'text',
        text: message,
        ts: Date.now()
      });

      try {
        await sendEncryptedMessage(targetNodeId, JSON.stringify({ type: 'text', text: message }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Chat : envoyer un fichier ──────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/chat/send-file') {
      const body = JSON.parse(await readBody(req));
      const { targetNodeId, fileId, fileName, fileSize } = body;
      const profile = loadProfile();

      // Ajouter dans la conversation locale
      addMsg(targetNodeId, {
        from: 'me',
        fromName: profile?.displayName || 'Moi',
        to: targetNodeId,
        type: 'file',
        fileId,
        fileName,
        fileSize,
        ts: Date.now()
      });

      // Notifier le pair via un message chiffré spécial
      try {
        await sendEncryptedMessage(targetNodeId, JSON.stringify({
          type: 'file', fileId, fileName, fileSize
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Chat : sauvegarder une réponse Gemini dans la conv ─────────────
    if (req.method === 'POST' && url.pathname === '/api/chat/gemini-reply') {
      const body = JSON.parse(await readBody(req));
      const { targetNodeId, text } = body;

      addMsg(targetNodeId, {
        from: 'gemini',
        fromName: 'Gemini',
        to: targetNodeId,
        type: 'gemini',
        text,
        ts: Date.now()
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── Fichiers : partager (chemin serveur local) ───────────────────────
    if (req.method === 'POST' && url.pathname === '/api/files/share') {
      const body = JSON.parse(await readBody(req));
      try {
        const manifest = saveChunks(body.filePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          file: { name: manifest.file_name, size: manifest.total_size, fileId: manifest.file_id }
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Fichiers : partager depuis le navigateur (upload base64) ─────────
    if (req.method === 'POST' && url.pathname === '/api/files/share-upload') {
      const body = JSON.parse(await readBody(req));
      const { fileName, fileDataB64 } = body;
      if (!fileName || !fileDataB64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fileName et fileDataB64 requis' }));
        return;
      }
      try {
        // Écrire dans un répertoire temporaire
        const tmpDir = path.join('.archipel', 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpPath = path.join(tmpDir, fileName);
        // fileDataB64 peut être un data URL (data:...;base64,xxx) ou du base64 pur
        const base64Data = fileDataB64.includes(',') ? fileDataB64.split(',')[1] : fileDataB64;
        fs.writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));

        // Chunker le fichier
        const manifest = saveChunks(tmpPath);

        // Supprimer le fichier temporaire
        try { fs.unlinkSync(tmpPath); } catch (_) { }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          file: { name: manifest.file_name, size: manifest.total_size, fileId: manifest.file_id }
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Fichiers : télécharger (assembler les chunks depuis les pairs) ──
    if (req.method === 'POST' && url.pathname === '/api/files/download') {
      const body = JSON.parse(await readBody(req));
      const identityRaw = JSON.parse(fs.readFileSync('.archipel/identity.json'));
      try {
        await downloadFile(body.fileId, peerTable, identityRaw.publicKey, path.join('.archipel', 'ready'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, fileId: body.fileId }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Fichiers : servir le fichier au navigateur (vrai téléchargement) ─
    if (req.method === 'GET' && url.pathname.startsWith('/api/files/serve/')) {
      const fileId = url.pathname.split('/').pop();
      const manifestPath = path.join('.archipel', 'chunks', `${fileId}.manifest`);

      if (!fs.existsSync(manifestPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Fichier introuvable. Téléchargez-le d\'abord.' }));
        return;
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath));

      // Vérifier si le fichier assemblé existe déjà dans .archipel/ready/
      const readyPath = path.join('.archipel', 'ready', manifest.file_name);
      let fileBuf;
      if (fs.existsSync(readyPath)) {
        fileBuf = fs.readFileSync(readyPath);
      } else {
        // Assembler depuis les chunks en mémoire
        const { readChunk } = require('./chunker');
        const parts = [];
        for (const chunk of manifest.chunks) {
          const data = readChunk(fileId, chunk.index);
          if (!data) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Chunk ${chunk.index} manquant – téléchargez le fichier d'abord.` }));
            return;
          }
          parts.push(data);
        }
        fileBuf = Buffer.concat(parts);
      }

      const encodedName = encodeURIComponent(manifest.file_name);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${manifest.file_name}"; filename*=UTF-8''${encodedName}`,
        'Content-Length': fileBuf.length
      });
      res.end(fileBuf);
      return;
    }

    // ── Gemini ─────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/ai/ask') {
      const body = JSON.parse(await readBody(req));
      const { query, conversationNodeId } = body;

      // Passer le contexte de la conversation en cours
      const context = conversationNodeId
        ? getConv(conversationNodeId).slice(-10).map(m => ({ from: m.fromName, text: m.text }))
        : [];

      const result = await queryGemini(context, query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404); res.end('Not found');
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

// ── Appelé depuis node.js quand un message est reçu ──────────────────
function addIncomingMessage(fromNodeId, fromName, payload) {
  try {
    // Le payload peut être JSON (text, file) ou texte brut
    let parsed;
    try { parsed = JSON.parse(payload); } catch { parsed = { type: 'text', text: payload }; }

    addMsg(fromNodeId, {
      from: fromNodeId,
      fromName,
      to: 'me',
      type: parsed.type || 'text',
      text: parsed.text || payload,
      fileId: parsed.fileId,
      fileName: parsed.fileName,
      fileSize: parsed.fileSize,
      ts: Date.now()
    });
  } catch (e) {
    console.error('addIncomingMessage error:', e);
  }
}

module.exports = { startWebServer, addIncomingMessage, loadProfile };