const fs = require('fs');
const https = require('https');
const express = require('express');
const WebSocket = require('ws');
const path = require('path');

// Load environment variables from .env file
require('dotenv').config();

// ============================================================
// Configuration & TURN
// ============================================================
const PORT = process.env.PORT || 3000;

// Metered.ca TURN configuration
const METERED_APP_NAME = process.env.METERED_APP_NAME || '';
const METERED_API_KEY = process.env.METERED_API_KEY || '';

let cachedTurnCredentials = null;
let lastTurnFetch = 0;
const TURN_CACHE_DURATION = 20 * 60 * 1000;

async function fetchMeteredTurnCredentials() {
  if (!METERED_APP_NAME || !METERED_API_KEY) {
    console.log('⚠️  Metered TURN không khả dụng. Chỉ dùng STUN.');
    return null;
  }
  if (cachedTurnCredentials && (Date.now() - lastTurnFetch) < TURN_CACHE_DURATION) {
    return cachedTurnCredentials;
  }
  try {
    const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cachedTurnCredentials = await response.json();
    lastTurnFetch = Date.now();
    console.log(`✅ Lấy thành công TURN servers từ Metered.ca`);
    return cachedTurnCredentials;
  } catch (error) {
    console.error('❌ Lỗi lấy TURN credentials:', error.message);
    return null;
  }
}

async function getIceServers() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  const turnCredentials = await fetchMeteredTurnCredentials();
  if (turnCredentials) iceServers.push(...turnCredentials);
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
  process.exit(1);
}

const server = https.createServer(options, app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// STATE MANAGEMENT (ROOMS)
// ==========================================

// roomId -> object { id, members: Set of ws, callActive: boolean }
const rooms = new Map();
// name -> ws
const clients = new Map();

wss.on('connection', (ws) => {
  ws.name = null;
  ws.roomId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const { type, name, roomId, sender, target } = data;

      switch (type) {
        case 'register':
          handleRegister(ws, name);
          break;

        case 'createRoom':
        case 'joinRoom':
          handleJoinRoom(ws, roomId, name);
          break;

        case 'leaveRoom':
          handleLeaveRoom(ws, roomId);
          break;

        case 'startGroupCall':
          handleStartGroupCall(ws, roomId);
          break;

        case 'endCall':
          handleEndCall(ws, roomId, sender);
          break;

        case 'offer':
        case 'answer':
        case 'candidate':
          forwardSignal(ws, roomId, target, data);
          break;

        default:
          console.warn('Unknown message type:', type);
      }
    } catch (error) {
      console.error('Lỗi xử lý tin nhắn:', error);
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      handleLeaveRoom(ws, ws.roomId);
    }
    if (ws.name) {
      clients.delete(ws.name);
    }
  });
});

// ==========================================
// HANDLERS
// ==========================================

function handleRegister(ws, name) {
  if (!name) return;
  const safeName = String(name).trim();

  // Kick old session
  if (clients.has(safeName)) {
    try { clients.get(safeName).close(); } catch { }
    clients.delete(safeName);
  }

  ws.name = safeName;
  clients.set(safeName, ws);

  // Send initial ICE configuration
  getIceServers().then(iceServers => {
    wsSend(ws, {
      type: 'registered',
      name: safeName,
      iceServers: iceServers
    });
  });

  sendRoomListToAll();
}

function handleJoinRoom(ws, roomId, name) {
  if (!roomId || !name || !ws.name) return;
  const safeRoomId = String(roomId).trim();

  // Leave current room
  if (ws.roomId && ws.roomId !== safeRoomId) {
    handleLeaveRoom(ws, ws.roomId);
  }

  ws.roomId = safeRoomId;

  if (!rooms.has(safeRoomId)) {
    rooms.set(safeRoomId, {
      id: safeRoomId,
      members: new Set(),
      callActive: false
    });
  }

  const room = rooms.get(safeRoomId);
  room.members.add(ws);

  wsSend(ws, {
    type: 'roomJoined',
    roomId: safeRoomId,
    callActive: room.callActive
  });

  broadcastRoomMembers(safeRoomId);
  sendRoomListToAll();
}

function handleLeaveRoom(ws, roomId) {
  if (!roomId) return;

  // Actually they are just leaving their room
  // wait check if ws.roomId matches
  const actualRoomId = ws.roomId || roomId;
  const room = rooms.get(actualRoomId);
  if (!room) return;

  room.members.delete(ws);
  ws.roomId = null;

  broadcastToRoom(actualRoomId, {
    type: 'memberLeft',
    roomId: actualRoomId,
    name: ws.name
  });

  broadcastRoomMembers(actualRoomId);

  if (room.members.size === 0) {
    rooms.delete(actualRoomId);
  }

  sendRoomListToAll();
}

function handleStartGroupCall(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.callActive = true;

  broadcastToRoom(roomId, {
    type: 'startGroupCall',
    roomId: roomId,
    members: Array.from(room.members).map(c => c.name)
  });

  sendRoomListToAll();
}

function handleEndCall(ws, roomId, sender) {
  const room = rooms.get(roomId);
  if (!room) return;

  broadcastToRoom(roomId, {
    type: 'peerEndedCall',
    roomId: roomId,
    name: ws.name
  }, [ws.name]);
}

function forwardSignal(ws, roomId, targetName, data) {
  if (!roomId || !targetName) return;
  if (ws.roomId !== roomId) return;

  const targetWs = clients.get(targetName);
  if (targetWs && targetWs.roomId === roomId && targetWs.readyState === WebSocket.OPEN) {
    wsSend(targetWs, data);
  }
}

function wsSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToRoom(roomId, data, excludeNames = []) {
  const room = rooms.get(roomId);
  if (!room) return;

  const message = JSON.stringify(data);
  for (const client of room.members) {
    if (!excludeNames.includes(client.name) && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function broadcastRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const members = Array.from(room.members).map(c => c.name);
  broadcastToRoom(roomId, {
    type: 'roomMembers',
    roomId: roomId,
    members: members,
    callActive: room.callActive
  });
}

function sendRoomListToAll() {
  const roomList = [];
  for (const [id, room] of rooms.entries()) {
    roomList.push({
      roomId: id,
      memberCount: room.members.size,
      callActive: room.callActive
    });
  }

  const msg = JSON.stringify({
    type: 'roomList',
    rooms: roomList
  });

  for (const client of clients.values()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
