# WebRTC Group Call - Room + Mesh Topology

Hệ thống gọi video nhóm (Group Call) sử dụng WebRTC với kiến trúc Mesh, TURN server Metered.ca cho kết nối qua Internet, quản lý phòng (Room) và nhiều người tham gia cùng lúc.

## Kiến trúc tổng quan

```
┌──────────┐     WSS (Signaling)    ┌──────────────┐     WSS (Signaling)    ┌──────────┐
│ Client A │◄──────────────────────►│  Node.js     │◄──────────────────────►│ Client B │
│ (Browser)│                        │  HTTPS +     │                        │ (Browser)│
└────┬─────┘                        │  WebSocket   │                        └────┬─────┘
     │                              │  Server      │                             │
     │         WebRTC (P2P/Relay)   └──────────────┘    WebRTC (P2P/Relay)       │
     │◄─────────────────────────────────────────────────────────────────────────►│
     │                                                                           │
     │                              ┌──────────────┐                             │
     │         ICE Candidates       │ TURN Server  │       ICE Candidates        │
     │◄────────────────────────────►│ (Metered.ca) │◄───────────────────────────►│
     │                              └──────────────┘                             │
     │                                                                           │
     │         WebRTC (P2P/Relay)   ┌──────────┐    WebRTC (P2P/Relay)           │
     │◄────────────────────────────►│ Client C │◄───────────────────────────────►│
                                    │ (Browser)│
                                    └──────────┘
```

**Mesh Topology**: Mỗi client tạo n-1 RTCPeerConnection đến các thành viên khác trong phòng.

## Cấu trúc thư mục

```
webrtc-app-v2/
├── server.js          # Server HTTPS + WebSocket signaling
├── public/
│   └── index.html     # Client HTML/CSS/JS (single file)
├── certs/
│   ├── key.pem        # SSL private key (tự tạo)
│   └── cert.pem       # SSL certificate (tự tạo)
├── package.json       # Dependencies
├── .env               # Cấu hình (không commit)
├── .env.example       # Cấu hình mẫu
├── README.md          # Hướng dẫn này
└── report.md          # Báo cáo kiến trúc & test
```

## Hướng dẫn cài đặt & chạy

### 1. Cài dependencies

```bash
cd webrtc-app-v2
npm install
```

### 2. Tạo chứng chỉ SSL (self-signed)

WebRTC yêu cầu HTTPS. Tạo self-signed cert:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj '/CN=localhost'
```

> **Lưu ý**: Khi mở trên trình duyệt, bạn sẽ cần accept self-signed certificate.

### 3. Cấu hình TURN Server (Metered.ca)

Dự án dùng **Metered.ca** làm TURN server duy nhất (kết nối qua NAT/Firewall khi khác mạng).

1. Đăng ký tại [dashboard.metered.ca](https://dashboard.metered.ca/signup?tool=turnserver)
2. Tạo app mới, lấy **App Name** và **API Key**
3. Tạo file `.env` từ mẫu và điền thông tin:

```bash
cp .env.example .env
```

Sửa `.env`:

```env
PORT=3000
METERED_APP_NAME=your_app_name
METERED_API_KEY=your_api_key_here
```

### 4. Chạy Signaling Server

```bash
npm start
# hoặc
node server.js
```

Server sẽ chạy tại: `https://localhost:3000`

### 5. Test qua Internet (Cloudflare Tunnel)

Để test với người ở mạng khác, dùng Cloudflare Tunnel:

```bash
# Cài cloudflared (macOS)
brew install cloudflare/cloudflare/cloudflared

# Chạy tunnel
cloudflared tunnel --url https://localhost:3000 --no-tls-verify
```

Bạn sẽ nhận được URL dạng `https://xxx.trycloudflare.com` để chia sẻ.

## Hướng dẫn test

### Test 2 người (cùng LAN)

1. Mở 2 tab trình duyệt đến `https://localhost:3000`
2. Tab 1: Nhập tên "User1" → Kết nối
3. Tab 2: Nhập tên "User2" → Kết nối
4. Cả 2 tab: Nhập Room ID "test-room"
5. Tab 1: Nhấn "Tạo phòng"
6. Tab 2: Nhấn "Tham gia"
7. Tab 1: Nhấn nút 📞 (Bắt đầu gọi nhóm)
8. Cả 2 sẽ thấy video của nhau

### Test nhóm 3-4 người

1. Mở 3-4 tab (hoặc 3-4 máy tính khác nhau cùng mạng)
2. Mỗi tab nhập tên khác nhau → Kết nối
3. Tất cả vào cùng Room ID
4. Một người nhấn "Bắt đầu gọi nhóm"
5. Tất cả sẽ thấy video grid của nhau

### Test khác mạng (TURN Metered.ca)

1. Cấu hình Metered.ca trong `.env`
2. Chạy Cloudflare Tunnel để expose server
3. Máy A: WiFi, Máy B: 4G/hotspot (mạng khác)
4. Cả 2 truy cập URL tunnel, vào cùng phòng, bắt đầu gọi
5. Log sẽ hiện: `Candidate: local=relay, remote=relay → relay (TURN)`

### Test Hangup & Gọi lại

1. Trong cuộc gọi, nhấn nút 📴 (Dừng)
2. Tất cả peer connections được đóng sạch
3. Nhấn nút 📞 (Bắt đầu gọi nhóm) lần nữa
4. Cuộc gọi mới bắt đầu bình thường, không lỗi

## Signaling Protocol

Các message JSON qua WebSocket:

| Message | Hướng | Mô tả |
|---------|-------|-------|
| `register` | C→S | `{type, name}` Đăng ký nickname |
| `registered` | S→C | `{type, name, iceServers[]}` Xác nhận + ICE servers (Metered.ca) |
| `createRoom` | C→S | `{type, roomId, name}` Tạo phòng mới |
| `joinRoom` | C→S | `{type, roomId, name}` Tham gia phòng |
| `roomJoined` | S→C | `{type, roomId, callActive}` Đã vào phòng |
| `roomMembers` | S→C | `{type, roomId, members[], callActive}` Danh sách thành viên |
| `roomList` | S→C | `{type, rooms[]}` Danh sách tất cả phòng |
| `leaveRoom` | C→S | `{type, roomId, sender}` Rời phòng |
| `roomLeft` | S→C | `{type}` Đã rời phòng |
| `memberLeft` | S→C | `{type, roomId, name}` Thành viên rời phòng |
| `startGroupCall` | C→S / S→C | `{type, roomId, initiator, members[]}` Bắt đầu gọi nhóm |
| `offer` | C→S→C | `{type, roomId, sender, target, offer}` SDP Offer |
| `answer` | C→S→C | `{type, roomId, sender, target, answer}` SDP Answer |
| `candidate` | C→S→C | `{type, roomId, sender, target, candidate}` ICE Candidate |
| `endCall` | C→S | `{type, roomId, sender}` Dừng cuộc gọi (cá nhân) |
| `peerEndedCall` | S→C | `{type, roomId, name}` Một peer rời cuộc gọi |
| `endGroupCall` | C→S | `{type, roomId, sender}` Kết thúc cuộc gọi nhóm |
| `groupCallEnded` | S→C | `{type, roomId, endedBy}` Cuộc gọi đã kết thúc |
| `error` | S→C | `{type, message}` Thông báo lỗi |

## Tính năng

- [x] Đăng nhập bằng nickname (không cần tài khoản)
- [x] Tạo/Tham gia phòng (Room)
- [x] Danh sách phòng realtime
- [x] Danh sách thành viên realtime
- [x] Gọi video nhóm (Mesh topology)
- [x] Grid video tự động điều chỉnh theo số người
- [x] TURN server tự động từ Metered.ca
- [x] Auto-fallback TURN khi P2P thất bại
- [x] ICE restart khi mạng thay đổi
- [x] WebSocket auto-reconnect
- [x] Hiển thị trạng thái kết nối
- [x] Hiển thị loại candidate (host/srflx/relay)
- [x] Thống kê RTT, FPS, packets lost
- [x] Bật/tắt mic, camera
- [x] Đồng hồ thời gian cuộc gọi
- [x] Log realtime
- [x] Hangup và gọi lại không lỗi
- [x] Xử lý member rời phòng / disconnect
- [x] Xử lý offer collision (glare)
- [x] Toast notifications
