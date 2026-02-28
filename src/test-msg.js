const { sendEncryptedMessage, peerTable } = require('./node');

// Attendre 15 secondes que les pairs soient découverts, puis envoyer
setTimeout(() => {
  const peers = Array.from(peerTable.keys());
  if (peers.length === 0) {
    console.log('Aucun pair trouvé');
    return;
  }
  const targetId = peers[0];
  console.log(`Envoi d'un message à ${targetId.slice(0, 16)}...`);
  sendEncryptedMessage(targetId, 'Hello depuis Archipel ! ');
}, 15000);