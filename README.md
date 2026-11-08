# Đọc Sách – web app

Đọc PDF như sách thật ngay trên trình duyệt: **lật giấy** (kéo góc trang), giả lập **màn hình e-ink** (16 mức xám, hạt mịn, vân giấy, chớp làm tươi, bóng mờ trang cũ), kiểu Giấy / Gốc / Đêm, xoay ngang 2 trang, mục lục, đánh dấu trang, mở PDF có mật khẩu.
Không cần cài app, không cần Apple ID. Sách lưu ngay trên máy (không gửi lên đâu cả).

**Dùng trên iPhone/iPad:** mở trang bằng **Safari** → **Chia sẻ** → **Thêm vào MH chính**. Mở từ biểu tượng ngoài màn hình chính: chạy toàn màn hình như app, đọc được khi không có mạng.

Thư viện đọc PDF: [pdf.js](https://github.com/mozilla/pdf.js) 6.2 (Mozilla, giấy phép Apache 2.0), nằm trong `vendor/pdfjs`.
Trang được đăng tự động bằng GitHub Pages mỗi khi có thay đổi (`.github/workflows/pages.yml`).
