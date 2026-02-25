# PHÂN CÔNG CÔNG VIỆC: THÀNH VIÊN 2 (Frontend & WebRTC)

## Vai Trò Chính
**Chịu trách nhiệm về Giao diện (UI), Logic WebRTC (Mesh Topology) và Hiển thị Video.**

## Các Đầu Việc Cụ Thể

### 1. Xây dựng Giao diện (HTML/CSS)
*   **File làm việc**: `public/index.html` (hoặc tạo thêm `style.css`).
*   **Nhiệm vụ**:
    *   Thay đổi màn hình đăng nhập: Thêm ô nhập **Room ID** bên cạnh Tên.
    *   Tạo khu vực **Video Grid**:
        *   Sử dụng CSS Grid/Flexbox để hiển thị 2, 3, hoặc 4 video tự động chia đều màn hình.
        *   Video của bản thân (`localVideo`) nên có viền hoặc tắt tiếng (`muted`).

### 2. Lập trình WebRTC (Client Logic)
*   **File làm việc**: `public/index.html` (phần `<script>`).
*   **Nhiệm vụ quan trọng (Mesh Topology)**:
    *   Thay vì dùng `1 biến peerConnection`, phải dùng **Một Danh Sách** (Object hoặc Map).
        *   Ví dụ: `peers = { "UserB": pc1, "UserC": pc2 }`.
    *   **Xử lý Logic**:
        *   Khi nhận `roomMembers`: Tự động lặp qua danh sách và gọi (`createOffer`) cho tất cả người cũ.
        *   Khi nhận `offer` từ người mới: Tạo `pc` mới và trả lời (`createAnswer`).
        *   Khi nhận `memberLeft`: Tìm `pc` tương ứng trong danh sách `peers` để `close()` và xóa thẻ `<video>` khỏi giao diện.

### 3. Hiển thị Thông số & Debug
*   **Nhiệm vụ**:
    *   Thêm logic kiểm tra `iceConnectionState` (đang kết nối, đã kết nối, mất kết nối...).
    *   Sử dụng `getStats()` để in ra log xem đang dùng candidate loại gì (`host` = mạng LAN, `relay` = qua TURN server).
    *   Cần thông tin này để chứng minh trong báo cáo.

### 4. Viết Báo Cáo (Phần Client)
*   Mô tả giải thuật Mesh (kết nối đa điểm).
*   Chụp ảnh màn hình Grid View (3-4 người).
*   Kết quả test khi tắt mạng/dùng 4G (kết hợp với cấu hình TURN của Member 1).
