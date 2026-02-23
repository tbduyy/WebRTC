const fs = require('fs');
const https = require('https');
const express = require('express');
const WebSocket = require('ws');
const path = require('path');

// Load environment variables from .env file
require('dotenv').config();

// ============================================================
// Configuration
// ============================================================
const PORT = process.env.PORT || 3000;

// Metered.ca TURN configuration
const METERED_APP_NAME = process.env.METERED_APP_NAME || '';
const METERED_API_KEY = process.env.METERED_API_KEY || '';

// Cache for TURN credentials (refresh every 20 minutes)
let cachedTurnCredentials = null;
let lastTurnFetch = 0;
const TURN_CACHE_DURATION = 20 * 60 * 1000; // 20 minutes

// Fetch TURN credentials from Metered.ca
async function fetchMeteredTurnCredentials() {
  if (!METERED_APP_NAME || !METERED_API_KEY) {
    console.log('⚠️  Metered TURN not configured. Using STUN only.');
    return null;
  }

  // Use cached credentials if still valid
  if (cachedTurnCredentials && (Date.now() - lastTurnFetch) < TURN_CACHE_DURATION) {
    return cachedTurnCredentials;
  }

  try {
    const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    cachedTurnCredentials = await response.json();
    lastTurnFetch = Date.now();
    
    console.log(`✅ Fetched ${cachedTurnCredentials.length} TURN servers from Metered.ca`);
    cachedTurnCredentials.forEach((server, i) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      urls.forEach(url => console.log(`   TURN[${i}]: ${url}`));
    });
    
    return cachedTurnCredentials;
  } catch (error) {
    console.error('❌ Failed to fetch Metered TURN credentials:', error.message);
    return null;
  }
}

// Build ICE servers config
async function getIceServers() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const turnCredentials = await fetchMeteredTurnCredentials();
  if (turnCredentials) {
    iceServers.push(...turnCredentials);
  }

  return iceServers;
}

const app = express();
let options;

try {
  options = {
    key: fs.readFileSync('./certs/key.pem'),
    cert: fs.readFileSync('./certs/cert.pem')
  };
} catch (error) {
  console.error('❌ Lỗi tải chứng chỉ SSL:', error.message);
  console.error('   Hãy tạo cert theo hướng dẫn trong README.md');
  process.exit(1);
}

const server = https.createServer(options, app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Data Structures
// ============================================================

// name → { ws, roomId }
const clients = new Map();

// roomId → { members: Set<name>, callActive: boolean }
const rooms = new Map();

// ============================================================
// Helper Functions
// ============================================================

function sendTo(name, message) {
  const client = clients.get(name);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message));
  }
}

function broadcastToRoom(roomId, message, excludeName = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const memberName of room.members) {
    if (memberName !== excludeName) {
      sendTo(memberName, message);
    }
  }
}

function sendRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const members = Array.from(room.members);
  broadcastToRoom(roomId, {
    type: 'roomMembers',
    roomId,
    members,
    callActive: room.callActive || false
  });
}

function leaveRoom(name) {
  const client = clients.get(name);
  if (!client || !client.roomId) return;

  const roomId = client.roomId;
  const room = rooms.get(roomId);
  if (!room) return;

  room.members.delete(name);
  client.roomId = null;

  // Notify remaining members
  broadcastToRoom(roomId, {
    type: 'memberLeft',
    roomId,
    name
  });

  // Update member list
  sendRoomMembers(roomId);

  // Clean up empty room
  if (room.members.size === 0) {
    rooms.delete(roomId);
    console.log(`🗑️  Room "${roomId}" deleted (empty)`);
  } else if (room.members.size < 2) {
    room.callActive = false;
  }

  console.log(`👋 "${name}" left room "${roomId}"`);
}

function getRoomList() {
  const list = [];
  for (const [roomId, room] of rooms.entries()) {
    list.push({
      roomId,
      memberCount: room.members.size,
      members: Array.from(room.members),
      callActive: room.callActive || false
    });
  }
  return list;
}

function broadcastRoomList() {
  const roomList = getRoomList();
  for (const [, client] of clients.entries()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: 'roomList', rooms: roomList }));
    }
  }
}

// ============================================================
// WebSocket Handler
// ============================================================

wss.on('connection', (ws) => {
  let clientName = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // ───────── register ─────────
      if (data.type === 'register') {
        const name = String(data.name || '').trim();
        if (!name) {
          sendError(ws, 'Tên không được để trống');
          return;
        }

        // Kick old session if same name
        if (clients.has(name)) {
          const oldClient = clients.get(name);
          if (oldClient.roomId) {
            leaveRoom(name);
          }
          try { oldClient.ws.close(); } catch {}
          clients.delete(name);
        }

        clientName = name;
        clients.set(clientName, { ws, roomId: null });
        console.log(`✅ "${clientName}" registered`);

        // Get ICE servers with TURN credentials and send to client
        getIceServers().then(iceServers => {
          sendTo(clientName, { 
            type: 'registered', 
            name: clientName,
            iceServers: iceServers
          });
        });
        
        broadcastRoomList();
        return;
      }

      // Not registered yet → ignore
      if (!clientName) return;

      // ───────── createRoom ─────────
      if (data.type === 'createRoom') {
        const roomId = String(data.roomId || '').trim();
        if (!roomId) {
          sendTo(clientName, { type: 'error', message: 'Room ID không được để trống' });
          return;
        }

        // Leave current room first
        if (clients.get(clientName).roomId) {
          leaveRoom(clientName);
        }

        if (rooms.has(roomId)) {
          sendTo(clientName, { type: 'error', message: `Room "${roomId}" đã tồn tại. Hãy dùng Join.` });
          return;
        }

        rooms.set(roomId, { members: new Set([clientName]), callActive: false });
        clients.get(clientName).roomId = roomId;

        console.log(`🏠 Room "${roomId}" created by "${clientName}"`);

        sendTo(clientName, { type: 'roomJoined', roomId });
        sendRoomMembers(roomId);
        broadcastRoomList();
        return;
      }

      // ───────── joinRoom ─────────
      if (data.type === 'joinRoom') {
        const roomId = String(data.roomId || '').trim();
        if (!roomId) {
          sendTo(clientName, { type: 'error', message: 'Room ID không được để trống' });
          return;
        }

        // Leave current room first
        if (clients.get(clientName).roomId) {
          leaveRoom(clientName);
        }

        // Auto-create room if not exist
        if (!rooms.has(roomId)) {
          rooms.set(roomId, { members: new Set(), callActive: false });
          console.log(`🏠 Room "${roomId}" auto-created by "${clientName}"`);
        }

        const room = rooms.get(roomId);
        room.members.add(clientName);
        clients.get(clientName).roomId = roomId;

        console.log(`➡️  "${clientName}" joined room "${roomId}" (${room.members.size} members)`);

        sendTo(clientName, { type: 'roomJoined', roomId, callActive: room.callActive || false });
        sendRoomMembers(roomId);
        broadcastRoomList();
        return;
      }

      // ───────── leaveRoom ─────────
      if (data.type === 'leaveRoom') {
        leaveRoom(clientName);

        sendTo(clientName, { type: 'roomLeft' });
        broadcastRoomList();
        return;
      }

      // ───────── startGroupCall ─────────
      if (data.type === 'startGroupCall') {
        const client = clients.get(clientName);
        if (!client || !client.roomId) return;

        const roomId = client.roomId;
        const room = rooms.get(roomId);
        if (!room) return;

        const wasActive = room.callActive;
        room.callActive = true;

        if (wasActive) {
          console.log(`📞 "${clientName}" rejoined call in room "${roomId}"`);
        } else {
          console.log(`📞 Group call started in room "${roomId}" by "${clientName}"`);
        }

        // Notify all members to start mesh connections
        // This allows reconnection when someone rejoins
        broadcastToRoom(roomId, {
          type: 'startGroupCall',
          roomId,
          initiator: clientName,
          members: Array.from(room.members),
          isRejoin: wasActive
        });
        return;
      }

      // ───────── offer (with roomId) ─────────
      if (data.type === 'offer') {
        const target = String(data.target || '').trim();
        const sender = String(data.sender || '').trim();

        if (!target || !sender) return;
        if (sender !== clientName) return;

        // Forward offer to target
        sendTo(target, {
          type: 'offer',
          roomId: data.roomId || '',
          sender,
          target,
          offer: data.offer
        });
        return;
      }

      // ───────── answer ─────────
      if (data.type === 'answer') {
        const target = String(data.target || '').trim();
        const sender = String(data.sender || '').trim();

        if (!target || !sender) return;
        if (sender !== clientName) return;

        sendTo(target, {
          type: 'answer',
          roomId: data.roomId || '',
          sender,
          target,
          answer: data.answer
        });
        return;
      }

      // ───────── candidate ─────────
      if (data.type === 'candidate') {
        const target = String(data.target || '').trim();
        const sender = String(data.sender || '').trim();

        if (!target || !sender) return;
        if (sender !== clientName) return;

        sendTo(target, {
          type: 'candidate',
          roomId: data.roomId || '',
          sender,
          target,
          candidate: data.candidate
        });
        return;
      }

      // ───────── endCall ─────────
      if (data.type === 'endCall') {
        const client = clients.get(clientName);
        if (!client || !client.roomId) return;

        const roomId = client.roomId;
        const room = rooms.get(roomId);
        if (!room) return;

        console.log(`📴 "${clientName}" ended call in room "${roomId}"`);

        // Notify others that this person hung up (they close PC to this peer)
        broadcastToRoom(roomId, {
          type: 'peerEndedCall',
          roomId,
          name: clientName
        }, clientName);

        // Check if anyone else is still in the call → if only 1, end call
        // The call status remains until everyone leaves or explicitly ends
        return;
      }

      // ───────── endGroupCall (ends for all) ─────────
      if (data.type === 'endGroupCall') {
        const client = clients.get(clientName);
        if (!client || !client.roomId) return;

        const roomId = client.roomId;
        const room = rooms.get(roomId);
        if (!room) return;

        room.callActive = false;

        console.log(`🔴 Group call ended in room "${roomId}" by "${clientName}"`);

        broadcastToRoom(roomId, {
          type: 'groupCallEnded',
          roomId,
          endedBy: clientName
        });
        return;
      }

    } catch (error) {
      console.error('❌ Lỗi xử lý tin nhắn:', error);
    }
  });

  ws.on('close', () => {
    if (clientName) {
      console.log(`❌ "${clientName}" disconnected`);
      leaveRoom(clientName);
      clients.delete(clientName);
      broadcastRoomList();
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for "${clientName}":`, err.message);
  });
});

function sendError(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }));
  }
}

// ============================================================
// Start Server
// ============================================================

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════');
  console.log(`🚀 WebRTC Signaling Server running`);
  console.log(`   https://localhost:${PORT}`);
  console.log('═══════════════════════════════════════════════');
});
