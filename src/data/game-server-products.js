/**
 * Dedicated game servers sold by AI Markets: each buyer session launches its own RunPod pod
 * (utils/game-hosting.js), exposes one TCP port on a public IP and is billed per minute at the
 * real pod cost × (1 + GPU_RENTAL_MARKUP). Only TCP games: RunPod pods cannot expose UDP.
 */
const { inferProductType } = require('./marketplace-types');
const { taxCategoryFromProduct } = require('../finance/tax-category');
const { CREATOR } = require('./runpod-marketplace-products');
const { dedicatedRatePerHour } = require('../utils/game-hosting');

const CDN = 'https://cdn.aimarkets.vn/aimarkets/aimarkets/playground/game-servers';

/** CPU data centers whose public TCP mapping was verified reachable (EU-SE-1 was not). */
const DATA_CENTERS = ['EUR-IS-1', 'EUR-IS-2', 'EUR-IS-3', 'US-KS-2', 'US-TX-3', 'US-GA-2', 'CA-MTL-1', 'EU-CZ-1', 'US-IL-1'];

/** Sample sizes behind the "from" price; the session itself bills the pod's real cost. */
const TYPICAL_POD_COST_PER_HOUR = { cpu3g2: 0.08, cpu3c2: 0.06 };

/**
 * Listed per-minute rate for a pod: the exact rate a session on that pod bills
 * ((pod cost + running disk) × (1 + markup), see dedicatedRatePerHour), divided by 60 and
 * rounded the same way as the session's `ratePerMinute`, so the product page and the player agree.
 */
function perMinute(costPerHour, diskGb = 10) {
  return Math.round((dedicatedRatePerHour(costPerHour, diskGb) / 60) * 1e6) / 1e6;
}

function docs(p) {
  return `## ${p.name}

Máy chủ riêng (dedicated) chạy trên hạ tầng AI Markets. Mỗi lần bạn bấm **Chơi**, hệ thống khởi tạo một máy chủ mới chỉ dành cho bạn, trả về địa chỉ \`IP:port\` để nhập vào game, và tắt hẳn máy chủ khi bạn dừng.

**Cách dùng**
1. Nạp ví, mở \`https://aimarkets.vn/play/${p.slug}\` và bấm Chơi.
2. Chờ 1–5 phút tới khi trạng thái chuyển sang *Máy chủ đang chạy*.
3. ${p.gameServer.connectHint}
4. Giữ tab mở khi chơi. Bấm **Dừng** (hoặc đóng tab hơn 10 phút) để tắt máy chủ và ngừng tính phí.

**Tính phí**: theo phút kể từ khi máy chủ sẵn sàng = chi phí máy chủ thực tế × 1,3 (đã gồm lưu trữ). Khởi động lỗi thì không tính phí. Dữ liệu thế giới không được giữ lại sau khi dừng.

**API**
\`\`\`
POST https://api.aimarkets.vn/v1/game-sessions   { "productSlug": "${p.slug}" }
GET  https://api.aimarkets.vn/v1/game-sessions/:sessionId   → { status, connect: { host, port, address } }
DELETE https://api.aimarkets.vn/v1/game-sessions/:sessionId → dừng + chốt phí
\`\`\`
`;
}

function row(partial) {
  const productType = inferProductType('game-server', partial.tags);
  const p = {
    creatorSlug: CREATOR.creatorSlug,
    creatorName: CREATOR.name,
    ownershipType: 'PLATFORM_DIRECT',
    infraProvider: 'runpod',
    provider: 'runpod',
    complianceStatus: 'approved',
    category: 'game-server',
    productType,
    taxCategory: taxCategoryFromProduct({ category: 'game-server', productType }),
    streaming: { devices: ['pc', 'mobile'], rentalOfferId: '' },
    rating: 5,
    reviewCount: 0,
    ...partial,
  };
  p.apiDocsMarkdown = docs(p);
  return p;
}

function buildGameServerProducts() {
  return [
    row({
      slug: 'game-server-minecraft-java',
      name: 'Máy chủ Minecraft Java (Vanilla)',
      tagline: 'Server Minecraft Java riêng cho nhóm bạn — bật trong vài phút, tính phí theo phút.',
      description:
        'Máy chủ Minecraft: Java Edition bản gốc (Vanilla, phiên bản mới nhất) chạy riêng cho bạn trên CPU 2 nhân, 8 GB RAM. ' +
        'Bấm Chơi để khởi tạo, nhận địa chỉ IP:port rồi vào Multiplayer → Direct Connection. Yêu cầu tài khoản Minecraft Java bản quyền (online-mode). ' +
        'Tính phí theo phút theo chi phí máy chủ thực tế + 30%, tự tắt khi bạn dừng. Thế giới mới mỗi lần khởi tạo.',
      coverUrl: `${CDN}/minecraft-java.jpg`,
      gallery: [`${CDN}/minecraft-java.jpg`],
      pricing: { model: 'usage', price: 0, currency: 'USD', usageUnit: 'minute', usageRate: perMinute(TYPICAL_POD_COST_PER_HOUR.cpu3g2) },
      tags: ['game', 'minecraft', 'java', 'dedicated-server', 'multiplayer'],
      featured: true,
      changelog: [{ version: '1.0.0', date: '2026-10-25', notes: 'Máy chủ riêng trên pod CPU, tính phí theo chi phí thực.' }],
      gameServer: {
        game: 'minecraft-java',
        image: 'itzg/minecraft-server:latest',
        port: 25565,
        protocol: 'minecraft',
        computeType: 'CPU',
        cpuFlavorIds: ['cpu3g', 'cpu5g'],
        vcpuCount: 2,
        diskGb: 10,
        dataCenterIds: DATA_CENTERS,
        env: {
          EULA: 'TRUE',
          TYPE: 'VANILLA',
          MEMORY: '5G',
          ONLINE_MODE: 'TRUE',
          MAX_PLAYERS: '10',
          VIEW_DISTANCE: '8',
          MOTD: 'AI Markets - may chu Minecraft rieng',
          ENABLE_RCON: 'FALSE',
        },
        connectHint: 'Mở Minecraft Java → Multiplayer → Direct Connection → dán địa chỉ máy chủ.',
      },
    }),
    row({
      slug: 'game-server-minecraft-paper',
      name: 'Máy chủ Minecraft Java (Paper, hỗ trợ plugin)',
      tagline: 'Paper hiệu năng cao, sẵn sàng cho plugin Bukkit/Spigot — server riêng, tính phí theo phút.',
      description:
        'Máy chủ Minecraft: Java Edition chạy Paper (bản tối ưu hiệu năng, tương thích plugin Bukkit/Spigot) trên CPU 2 nhân, 8 GB RAM. ' +
        'Bấm Chơi để khởi tạo và nhận địa chỉ IP:port. Yêu cầu tài khoản Minecraft Java bản quyền. ' +
        'Tính phí theo phút theo chi phí máy chủ thực tế + 30%, tự tắt khi bạn dừng.',
      coverUrl: `${CDN}/minecraft-paper.jpg`,
      gallery: [`${CDN}/minecraft-paper.jpg`],
      pricing: { model: 'usage', price: 0, currency: 'USD', usageUnit: 'minute', usageRate: perMinute(TYPICAL_POD_COST_PER_HOUR.cpu3g2) },
      tags: ['game', 'minecraft', 'paper', 'plugins', 'dedicated-server'],
      featured: false,
      changelog: [{ version: '1.0.0', date: '2026-10-25', notes: 'Paper server trên pod CPU riêng.' }],
      gameServer: {
        game: 'minecraft-paper',
        image: 'itzg/minecraft-server:latest',
        port: 25565,
        protocol: 'minecraft',
        computeType: 'CPU',
        cpuFlavorIds: ['cpu3g', 'cpu5g'],
        vcpuCount: 2,
        diskGb: 10,
        dataCenterIds: DATA_CENTERS,
        env: {
          EULA: 'TRUE',
          TYPE: 'PAPER',
          MEMORY: '5G',
          ONLINE_MODE: 'TRUE',
          MAX_PLAYERS: '20',
          VIEW_DISTANCE: '8',
          MOTD: 'AI Markets - Paper server',
          ENABLE_RCON: 'FALSE',
        },
        connectHint: 'Mở Minecraft Java → Multiplayer → Direct Connection → dán địa chỉ máy chủ.',
      },
    }),
    row({
      slug: 'game-server-terraria',
      name: 'Máy chủ Terraria (TShock)',
      tagline: 'Server Terraria riêng cho tối đa 8 người — tạo thế giới mới, tính phí theo phút.',
      description:
        'Máy chủ Terraria chạy TShock (mã nguồn mở) trên CPU 2 nhân, 4 GB RAM. Bấm Chơi để tạo thế giới nhỏ mới và nhận địa chỉ IP:port, ' +
        'sau đó vào Multiplayer → Join via IP. Tối đa 8 người chơi. Tính phí theo phút theo chi phí máy chủ thực tế + 30%, tự tắt khi bạn dừng.',
      coverUrl: `${CDN}/terraria.jpg`,
      gallery: [`${CDN}/terraria.jpg`],
      pricing: { model: 'usage', price: 0, currency: 'USD', usageUnit: 'minute', usageRate: perMinute(TYPICAL_POD_COST_PER_HOUR.cpu3c2) },
      tags: ['game', 'terraria', 'tshock', 'dedicated-server', 'multiplayer'],
      featured: false,
      changelog: [{ version: '1.0.0', date: '2026-10-25', notes: 'TShock server trên pod CPU riêng.' }],
      gameServer: {
        game: 'terraria',
        image: 'ryshe/terraria:latest',
        port: 7777,
        protocol: 'tcp',
        computeType: 'CPU',
        cpuFlavorIds: ['cpu3c', 'cpu5c'],
        vcpuCount: 2,
        diskGb: 10,
        dataCenterIds: DATA_CENTERS,
        dockerStartCmd: [
          '-world', '/root/.local/share/Terraria/Worlds/aimarkets.wld',
          '-autocreate', '1',
          '-worldname', 'AIMarkets',
          '-maxplayers', '8',
        ],
        connectHint: 'Mở Terraria → Multiplayer → Join via IP → nhập IP và cổng (port) của máy chủ.',
      },
    }),
  ];
}

module.exports = { buildGameServerProducts, perMinute, DATA_CENTERS };
