const fs = require('fs');
const https = require('https');
const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
let options;

try {
  options = {
    key: fs.readFileSync('./certs/key.pem'),
    cert: fs.readFileSync('./certs/cert.pem')
  };
} catch (error) {
  console.error('Lỗi tải chứng chỉ SSL:', error);
  process.exit(1);
}

const server = https.createServer(options, app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// STATE MANAGEMENT (ROOMS)
// ==========================================

// Global map: socketId (ws) -> { name, roomId }
// We use the WS object itself as key in WeakMap mostly, or just attach props to ws
// But here we need to look up easily.
// Let's attach data to ws directly for simplicity: ws.x_name, ws.x_roomId

// roomId -> Set<ws>
const rooms = new Map();

wss.on('connection', (ws) => {
  ws.x_name = null;
  ws.x_roomId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (error) {
      console.error('Invalid JSON:', error);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

function handleMessage(ws, data) {
  const { type } = data;

  switch (type) {
    case 'joinRoom':
      handleJoinRoom(ws, data);
      break;
    case 'offer':
    case 'answer':
    case 'candidate':
      forwardSignal(ws, data);
      break;
    case 'leaveRoom':
    case 'endCall':
      // endCall logic might need refinement for Groups, but basic forwarding is needed
      // For group mesh, usually we just leave or send specific disconnects
      if (type === 'leaveRoom') handleDisconnect(ws);
      else forwardSignal(ws, data);
      break;
    default:
      console.warn('Unknown message type:', type);
  }
}

function handleJoinRoom(ws, params) {
  const { roomId, name } = params;
  if (!roomId || !name) return;

  // Cleanup if already in a room?
  if (ws.x_roomId) {
    handleDisconnect(ws);
  }

  ws.x_id = name; // Using name as ID for now (simple requirements)
  ws.x_name = name;
  ws.x_roomId = roomId;

  // Create room if not exists
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const room = rooms.get(roomId);

  // Check for duplicate name in room?
  // Simple check:
  for (let member of room) {
    if (member.x_name === name) {
      // Reject or kick old?
      // Requirement says "kick old" or similar implied by simple login.
      // Let's kick the old one to be safe
      member.close();
      room.delete(member);
    }
  }

  room.add(ws);

  // 1. Acknowledge join (optional, but good for UI)
  // 2. Broadcast 'roomMembers' to everyone in room (including self)
  broadcastRoomMembers(roomId);
}

function handleDisconnect(ws) {
  const roomId = ws.x_roomId;
  const name = ws.x_name;

  if (roomId && rooms.has(roomId)) {
    const room = rooms.get(roomId);
    room.delete(ws);

    // Broadcast memberLeft
    const msg = { type: 'memberLeft', roomId, name };

    for (let client of room) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    }

    // Update member list ensures client states are consistent
    broadcastRoomMembers(roomId);

    if (room.size === 0) {
      rooms.delete(roomId);
    }
  }

  ws.x_roomId = null;
  ws.x_name = null;
}

function broadcastRoomMembers(roomId) {
  if (!rooms.has(roomId)) return;

  const room = rooms.get(roomId);
  const members = [];
  for (let client of room) {
    members.push(client.x_name);
  }

  const msg = JSON.stringify({
    type: 'roomMembers',
    roomId,
    members
  });

  for (let client of room) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function forwardSignal(ws, data) {
  // Security: Only forward if in same room
  const roomId = ws.x_roomId;
  const target = data.target;

  if (!roomId || !target) return;
  // Verify sender matches
  if (data.sender !== ws.x_name) return;

  const room = rooms.get(roomId);
  if (!room) return;

  let targetWs = null;
  for (let client of room) {
    if (client.x_name === target) {
      targetWs = client;
      break;
    }
  }

  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify(data));
  }
}

server.listen(3000, () => console.log('Server running on port 3000'));
