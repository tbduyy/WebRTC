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

// name -> ws
const clients = new Map();

// name -> partnerName (2 chiều)
const activeCalls = new Map();

wss.on('connection', (ws) => {
  let clientName = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // ===== register =====
      if (data.type === 'register') {
        const name = String(data.name || '').trim();
        if (!name) return;

        // Nếu trùng tên: kick phiên cũ
        if (clients.has(name)) {
          try { clients.get(name).close(); } catch { }
          clients.delete(name);
          activeCalls.delete(name);
        }

        clientName = name;
        clients.set(clientName, ws);
        broadcastClients();
        return;
      }

      // Chưa register thì bỏ qua
      if (!clientName) return;

      // ===== offer =====
      if (data.type === 'offer') {
        const target = String(data.target || '').trim();
        const sender = String(data.sender || '').trim();

        if (!target || !sender) return;
        if (sender !== clientName) return; // chống giả mạo sender

        // Nếu target đang bận -> kết thúc cuộc gọi cũ của target
        if (activeCalls.has(target)) {
          const oldPartner = activeCalls.get(target);
          endCall(target); // dọn map + báo endCall cho oldPartner
        }

        // Thiết lập cuộc gọi mới (2 chiều)
        activeCalls.set(target, sender);
        activeCalls.set(sender, target);

        forwardMessage(data);
        return;
      }

      // ===== answer / candidate =====
      if (data.type === 'answer' || data.type === 'candidate') {
        const target = String(data.target || '').trim();
        const sender = String(data.sender || '').trim();

        if (!target || !sender) return;
        if (sender !== clientName) return;

        forwardMessage(data);
        return;
      }

      // ===== endCall =====
      if (data.type === 'endCall') {
        const sender = String(data.sender || '').trim();
        if (!sender) return;
        if (sender !== clientName) return;

        endCall(sender);
        return;
      }
    } catch (error) {
      console.error('Lỗi xử lý tin nhắn:', error);
    }
  });

  ws.on('close', () => {
    if (clientName) {
      endCall(clientName);
      clients.delete(clientName);
      broadcastClients();
    }
  });
});

function broadcastClients() {
  const clientList = Array.from(clients.keys());
  for (const [, client] of clients.entries()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'clientList', clients: clientList }));
    }
  }
}

function forwardMessage(data) {
  const targetClient = clients.get(data.target);
  if (targetClient && targetClient.readyState === WebSocket.OPEN) {
    targetClient.send(JSON.stringify(data));
  }
}

function endCall(client) {
  if (!activeCalls.has(client)) return;

  const partner = activeCalls.get(client);

  // dọn map 2 chiều
  activeCalls.delete(client);
  activeCalls.delete(partner);

  // báo cho partner (nếu còn online)
  const partnerWs = clients.get(partner);
  if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
    partnerWs.send(JSON.stringify({ type: 'endCall' }));
  }

  // (tùy chọn) báo lại cho chính client để đồng bộ UI
  const clientWs = clients.get(client);
  if (clientWs && clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({ type: 'endCall' }));
  }
}

server.listen(3000, () => console.log('Server running on port 3000'));
