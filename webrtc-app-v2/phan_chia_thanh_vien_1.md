# PHÂN CÔNG CÔNG VIỆC: THÀNH VIÊN 1 (Backend & Signaling)

## Vai Trò Chính
**Chịu trách nhiệm về Server, Giao thức truyền tin (Signaling) và Cấu hình hệ thống (TURN).**

## Các Đầu Việc Cụ Thể

### 1. Phát triển Server (Node.js)
*   **File làm việc**: `server.js`
*   **Nhiệm vụ**:
    *   Chuyển đổi logic từ lưu danh sách Clients đơn lẻ sang **Quản lý theo Room** (`Map<RoomID, Set<Client>>`).
    *   Xử lý các sự kiện socket:
        *   `joinRoom`: Thêm người dùng vào phòng, kiểm tra trùng tên.
        *   `leaveRoom` / `disconnect`: Xóa người dùng, thông báo cho người còn lại.
    *   **Forwarding**: Đảm bảo tin nhắn (`offer`, `answer`, `candidate`) chỉ được chuyển tiếp giữa các thành viên **trong cùng một phòng**.

### 2. Định nghĩa Giao thức (Protocol)
*   **Nhiệm vụ**: Thống nhất cấu trúc tin nhắn JSON để gửi cho Member 2 code Client.
*   **Ví dụ chuẩn**:
    ```json
    // Tham gia phòng
    { "type": "joinRoom", "roomId": "123", "name": "UserA" }

    // Thông báo danh sách thành viên (Server gửi về)
    { "type": "roomMembers", "roomId": "123", "members": ["UserA", "UserB"] }

    // Người khác rời phòng (Server gửi về)
    { "type": "memberLeft", "roomId": "123", "name": "UserA" }
    ```

### 3. Cấu hình TURN Server
*   **Nhiệm vụ**:
    *   Tìm hiểu cách cài đặt **Coturn** (khuyên dùng Docker) hoặc tìm kiếm dịch vụ TURN miễn phí/trả phí để test.
    *   Cung cấp thông tin cấu hình (`iceServers` array) cho Member 2.
    *   *Lưu ý*: Nếu thiếu TURN, ứng dụng sẽ không chạy được khi dùng 4G.

### 4. Viết Báo Cáo (Phần Server)
*   Mô tả kiến trúc Server.
*   Giải thích lưu đồ các gói tin (Sequence Diagram nếu có).
*   Chụp ảnh log Server khi chạy đúng.
