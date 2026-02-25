# Báo cáo: WebRTC Group Call - STUN/TURN + Room + Mesh

## 1. Mô tả kiến trúc

### 1.1 Tổng quan hệ thống

Hệ thống gồm 3 thành phần chính:

1. **Signaling Server** (Node.js + HTTPS + WebSocket)
   - Quản lý đăng ký người dùng
   - Quản lý phòng (Room): tạo, tham gia, rời, xóa
   - Chuyển tiếp signaling messages: offer/answer/candidate
   - Broadcast danh sách phòng và thành viên realtime
   - Cung cấp TURN credentials từ Metered.ca cho client

2. **Client** (HTML/CSS/JS trên trình duyệt)
   - Giao diện đăng nhập (nickname)
   - Quản lý phòng: tạo/tham gia/rời
   - WebRTC: getUserMedia, RTCPeerConnection (mesh)
   - Grid video hiển thị nhiều người
   - Auto-reconnect WebSocket khi mất kết nối
   - Xử lý ICE restart khi mạng thay đổi
   - Thống kê kết nối (getStats)

3. **ICE Infrastructure** (STUN + TURN)
   - STUN: Google public STUN server
   - TURN: Metered.ca (dịch vụ miễn phí 20GB/tháng)

### 1.2 Luồng hoạt động

```
Client A                  Signaling Server              Client B
   |                            |                          |
   |--- register(name) ------->|                          |
   |<-- registered + iceServers |                          |
   |                            |                          |
   |--- createRoom(roomId) --->|                          |
   |<-- roomJoined ------------|                          |
   |<-- roomMembers -----------|                          |
   |                            |                          |
   |                            |<-- joinRoom(roomId) ----|
   |                            |--- roomJoined --------->|
   |<-- roomMembers -----------|--- roomMembers --------->|
   |                            |                          |
   |--- startGroupCall ------->|                          |
   |<-- startGroupCall --------|--- startGroupCall ------>|
   |                            |                          |
   |--- offer(target=B) ------>|--- offer(sender=A) ---->|
   |                            |                          |
   |<-- answer(sender=B) ------|<-- answer(target=A) ----|
   |                            |                          |
   |--- candidate(target=B) -->|--- candidate ---------->|
   |<-- candidate(sender=B) ---|<-- candidate(target=A) -|
   |                            |                          |
   | ◄══════════ WebRTC P2P / TURN Relay ═══════════════► |
   |                            |                          |
   |--- endCall -------------->|                          |
   |<-- peerEndedCall ---------|--- peerEndedCall ------>|
```

### 1.3 Mesh Topology

Trong Group Call, mỗi client tạo (n-1) RTCPeerConnection:

```
     A ◄──────► B
     ▲  ╲    ╱  ▲
     │    ╲╱    │
     │    ╱╲    │
     ▼  ╱    ╲  ▼
     C ◄──────► D

n = 4 người → mỗi người có 3 peer connections
Tổng connections = n(n-1)/2 = 6
```

**Ưu điểm**: Đơn giản, không cần media server
**Nhược điểm**: Băng thông tăng theo O(n²), phù hợp cho 3-6 người

### 1.4 ICE (Interactive Connectivity Establishment)

Quá trình thiết lập kết nối WebRTC:

1. **Gathering**: Thu thập ICE candidates
   - `host`: địa chỉ local (LAN)
   - `srflx` (Server Reflexive): qua STUN server
   - `relay`: qua TURN server
2. **Connectivity Check**: Kiểm tra kết nối từng cặp candidate
3. **Selection**: Chọn cặp tốt nhất (ưu tiên: host > srflx > relay)

```
┌─────────┐                    ┌──────────────┐
│ Client A │──── STUN Request ──►│ STUN Server  │
│          │◄── Public IP ──────│              │
└─────────┘                    └──────────────┘
     │
     │ (Nếu P2P thất bại)
     │
     ▼
┌─────────┐    Media Relay     ┌──────────────┐    Media Relay     ┌─────────┐
│ Client A │◄═════════════════►│ TURN Server  │◄═════════════════►│ Client B │
│          │                   │ (Metered.ca) │                   │          │
└─────────┘                    └──────────────┘                    └─────────┘
```

## 2. Định nghĩa Protocol Signaling

### 2.1 Bảng message

| # | Message Type | Direction | Payload |
|---|-------------|-----------|---------|
| 1 | `register` | C→S | `{type: "register", name: string}` |
| 2 | `registered` | S→C | `{type: "registered", name: string, iceServers: ICEServer[]}` |
| 3 | `createRoom` | C→S | `{type: "createRoom", roomId: string, name: string}` |
| 4 | `joinRoom` | C→S | `{type: "joinRoom", roomId: string, name: string}` |
| 5 | `roomJoined` | S→C | `{type: "roomJoined", roomId: string, callActive: bool}` |
| 6 | `roomMembers` | S→C | `{type: "roomMembers", roomId: string, members: string[], callActive: bool}` |
| 7 | `roomList` | S→C | `{type: "roomList", rooms: [{roomId, memberCount, members[], callActive}]}` |
| 8 | `leaveRoom` | C→S | `{type: "leaveRoom", roomId: string, sender: string}` |
| 9 | `roomLeft` | S→C | `{type: "roomLeft"}` |
| 10 | `memberLeft` | S→C | `{type: "memberLeft", roomId: string, name: string}` |
| 11 | `startGroupCall` | C↔S | `{type: "startGroupCall", roomId: string, initiator: string, members: string[]}` |
| 12 | `offer` | C→S→C | `{type: "offer", roomId: string, sender: string, target: string, offer: RTCSessionDescription}` |
| 13 | `answer` | C→S→C | `{type: "answer", roomId: string, sender: string, target: string, answer: RTCSessionDescription}` |
| 14 | `candidate` | C→S→C | `{type: "candidate", roomId: string, sender: string, target: string, candidate: RTCIceCandidate}` |
| 15 | `endCall` | C→S | `{type: "endCall", roomId: string, sender: string}` |
| 16 | `peerEndedCall` | S→C | `{type: "peerEndedCall", roomId: string, name: string}` |
| 17 | `endGroupCall` | C→S | `{type: "endGroupCall", roomId: string, sender: string}` |
| 18 | `groupCallEnded` | S→C | `{type: "groupCallEnded", roomId: string, endedBy: string}` |
| 19 | `error` | S→C | `{type: "error", message: string}` |

### 2.2 Luồng tạo cuộc gọi nhóm

1. Client gửi `startGroupCall` → Server broadcast `startGroupCall` đến tất cả thành viên trong phòng
2. Mỗi client nhận `startGroupCall` với danh sách `members`
3. Để tránh duplicate offer: client có tên alphabetically **lớn hơn** sẽ gửi offer (impolite peer)
4. Mỗi client tạo (n-1) RTCPeerConnection
5. Offer/Answer/Candidate được gửi kèm `roomId`, `sender`, `target`
6. Server forward message đến `target` cụ thể
7. Xử lý offer collision: polite peer (tên nhỏ hơn) rollback offer của mình

## 3. Thiết kế Room & Group Call

### 3.1 Quản lý phòng (Server)

```javascript
// Data structures trên server
const clients = new Map();  // name → { ws, roomId }
const rooms = new Map();    // roomId → { members: Set<name>, callActive: boolean }
```

- **Tạo phòng**: Kiểm tra roomId chưa tồn tại, tạo mới với 1 thành viên
- **Tham gia phòng**: Auto-create nếu chưa tồn tại, thêm thành viên
- **Rời phòng**: Xóa khỏi members, broadcast memberLeft, xóa room nếu trống
- **Broadcast**: roomMembers và roomList cập nhật realtime

### 3.2 Mesh Connections (Client)

```javascript
const peerConnections = {};  // peerName → RTCPeerConnection

// Khi startGroupCall:
members.forEach(name => {
  if (name !== myName) {
    // Impolite peer (alphabetically larger) sends offer
    if (myName > name) {
      createPeerConnectionAndOffer(name);
    } else {
      // Polite peer just sets up PC and waits
      setupPeerConnection(name);
    }
  }
});
```

### 3.3 Grid Video

- 1 người: grid 1 cột
- 2 người: grid 2 cột
- 3-4 người: grid 2 cột
- 5-6 người: grid 3 cột
- Video container có aspect ratio 16:9, object-fit: cover

## 4. Triển khai TURN Server (Metered.ca)

### 4.1 Cấu hình

TURN server được cấu hình qua Metered.ca - dịch vụ miễn phí 20GB/tháng:

1. Đăng ký tại: https://dashboard.metered.ca/signup?tool=turnserver
2. Tạo app và lấy App Name + API Key
3. Cấu hình trong file `.env`:

```env
METERED_APP_NAME=your_app_name
METERED_API_KEY=your_api_key
```

### 4.2 Cách hoạt động

1. Server đọc `METERED_APP_NAME` và `METERED_API_KEY` từ `.env`
2. Khi client đăng ký, server gọi Metered API:
   ```
   GET https://{APP_NAME}.metered.live/api/v1/turn/credentials?apiKey={API_KEY}
   ```
3. Server cache credentials 20 phút để tránh gọi API quá nhiều
4. TURN credentials được gửi cho client trong message `registered`

### 4.3 ICE Servers được cấu hình

```javascript
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Metered TURN servers (auto-fetched):
  { urls: 'turn:global.relay.metered.ca:80', username: '...', credential: '...' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', ... },
  { urls: 'turn:global.relay.metered.ca:443?transport=tcp', ... },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', ... }
]
```

## 5. Kết quả kiểm thử

### 5.1 Test cùng LAN (P2P)

**Điều kiện**: 3 tab Chrome trên cùng 1 máy, cùng mạng WiFi

**Kết quả**:
- Tạo phòng thành công, 3 người join
- Nhấn Start Group Call → tất cả thấy video nhau
- Candidate type: `host` (kết nối trực tiếp LAN)
- connectionState: `connected`
- iceConnectionState: `connected`
- Hangup → gọi lại thành công, không lỗi

**Log mẫu**:
```
[INFO] PC [User2] connectionState: connected
[SUCCESS] [User2] Candidate: local=host, remote=host → host (LAN)
[INFO] PC [User3] connectionState: connected
[SUCCESS] [User3] Candidate: local=host, remote=host → host (LAN)
```

### 5.2 Test khác mạng / 4G (TURN)

**Điều kiện**: 
- Máy A (MacBook Pro): kết nối qua WiFi tại nhà
- Máy B (Điện thoại): kết nối qua 4G mobile
- TURN server: Metered.ca (dịch vụ miễn phí)
- Signaling server: Deploy qua Cloudflare Tunnel

**Kết quả thực tế**:
- Kết nối thành công qua TURN relay
- connectionState: `connected`
- iceConnectionState: `connected`
- Candidate type: `relay (TURN)`

**Log thực tế**:
```
[15:17:24] WebSocket connected
[15:17:24] Đã kết nối với tên: mbp
[15:17:24] Đã đăng ký: mbp
[15:17:24] Server cung cấp 7 ICE servers (4 TURN)
[15:17:29] Đã vào phòng: abc123
[15:17:36] Gọi nhóm mesh: 1 peer(s)
[15:17:36] Tạo kết nối mới với Dt
[15:17:36] ICE gathering [Dt]: gathering
[15:17:36] PC [Dt] iceConnectionState: checking
[15:17:36] ICE candidate [Dt]: host
[15:17:36] ICE candidate [Dt]: srflx (STUN)
[15:17:37] ICE candidate [Dt]: relay (TURN)
[15:17:37] ICE candidate [Dt]: relay (TURN)
[15:17:37] ICE candidate [Dt]: relay (TURN)
[15:17:37] ICE candidate [Dt]: relay (TURN)
[15:17:37] PC [Dt] iceConnectionState: connected
[15:17:37] Kết nối với Dt đã phục hồi
[15:17:37] ICE gathering [Dt]: complete
[15:17:38] PC [Dt] connectionState: connected
[15:17:38] [Dt] Candidate: local=relay, remote=relay → relay (TURN)
```

**Phân tích**:
- ICE gathering thu thập đủ các loại candidate: host, srflx (STUN), relay (TURN)
- Do 2 máy ở khác mạng (WiFi vs 4G), P2P không thể thiết lập trực tiếp
- Kết nối cuối cùng đi qua TURN relay server của Metered.ca
- Thời gian thiết lập kết nối: ~2 giây (từ checking → connected)

### 5.3 Test Hangup & Gọi lại

**Kết quả**:
- Nhấn Hangup → tất cả PC đóng, video grid ẩn
- Nhấn Start Group Call lần 2 → PC mới tạo, kết nối OK
- Không xảy ra lỗi "Dừng xong không gọi lại được"
- `endCall` → server broadcast `peerEndedCall`
- `startGroupCall` → server set `callActive = true`, broadcast lại

### 5.4 Test thành viên rời phòng

**Kết quả**:
- User3 rời phòng → server gửi `memberLeft`
- User1 và User2 tự đóng PC đến User3, remove video element
- User1 và User2 vẫn giữ kết nối với nhau
- Grid tự cập nhật layout
- Video của user rời đi biến mất với animation fade-out (không bị đứng hình)

### 5.5 Test mất mạng / WS disconnect

**Kết quả**:
- Khi mất kết nối WebSocket, hệ thống tự động thử kết nối lại (tối đa 5 lần)
- Mỗi lần thử cách nhau 2s, 4s, 6s, 8s, 10s (exponential backoff)
- Khi kết nối lại thành công, tự động đăng ký lại và join lại phòng cũ
- Hiển thị thông báo toast cho người dùng biết trạng thái

### 5.6 Test ICE restart khi mạng thay đổi

**Kết quả**:
- Khi iceConnectionState chuyển sang `disconnected` hoặc `failed`
- Chỉ impolite peer (tên alphabetically lớn hơn) thực hiện ICE restart
- Gửi offer mới với `iceRestart: true`
- Polite peer nhận offer và tạo answer mới
- Xử lý offer collision (glare) bằng rollback
