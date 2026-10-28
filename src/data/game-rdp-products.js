const { dedicatedRatePerHour } = require('../utils/game-hosting');
function withDesktop(product, typicalPodCost) {
  const image = String(process.env.GAME_RDP_IMAGE || '').trim();
  if (!image) return product;
  const diskGb = 20;
  return {
    ...product,
    name: product.name + ' + Linux RDP',
    tagline: product.tagline + ' Desktop Linux riêng, kết nối bằng Remote Desktop.',
    description: product.description + '\n\nBao gồm desktop Linux XFCE riêng qua RDP. Bạn dùng Remote Desktop Connection trên Windows để quản lý thư mục game và terminal. Trang phiên thuê hiển thị địa chỉ RDP, tài khoản và mật khẩu riêng; có nút tải file .rdp. Đây là Linux, không phải Windows. Chỉ tính phí khi cả game và RDP sẵn sàng. Giữ tab phiên thuê mở trong lúc sử dụng; dừng phiên sẽ xóa máy và dữ liệu.',
    pricing: { ...product.pricing, usageRate: Math.round(dedicatedRatePerHour(typicalPodCost, diskGb) / 60 * 1e6) / 1e6 },
    tags: [...product.tags, 'linux-desktop', 'rdp'],
    gameServer: { ...product.gameServer, image, diskGb, rdpPort: 3389, dockerStartCmd: undefined,
      env: { ...product.gameServer.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '0' } },
    apiDocsMarkdown: product.apiDocsMarkdown + '\n\n### Linux Remote Desktop\n\nKhi phiên sẵn sàng, mở thẻ Remote Desktop trong trang phiên thuê để xem IP:cổng, tài khoản và mật khẩu riêng. Tải file .rdp rồi mở bằng Remote Desktop Connection. Máy chạy Linux XFCE; không phải máy Windows. Giữ tab thuê mở khi dùng RDP. Dừng phiên sẽ tắt cả game và desktop.\n',
  };
}
module.exports = { withDesktop };
