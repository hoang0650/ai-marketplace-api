/**
 * Seed AI Markets home banners (idempotent by title+slot).
 * Usage: node src/scripts/seed-banners.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config/env');
const Banner = require('../models/Banner');

const SEED = [
  {
    title: 'OpenClaw trên AI Markets',
    subtitle: 'Launch agent Control UI — provider cost + 25%',
    imageUrl: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200&q=80',
    linkType: 'agents',
    linkValue: '',
    slot: 'home_hero',
    sortOrder: 10,
  },
  {
    title: 'Hermes Agent',
    subtitle: 'Dashboard {userId}.hermes.aimarkets.vn',
    imageUrl: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=1200&q=80',
    linkType: 'agents',
    linkValue: '',
    slot: 'home_hero',
    sortOrder: 20,
  },
  {
    title: 'Khám phá catalog',
    subtitle: 'API · Models · GPU · Licenses',
    imageUrl: 'https://images.unsplash.com/photo-1555949963-aa79dcee981c?w=1200&q=80',
    linkType: 'explore',
    linkValue: '',
    slot: 'home_hero',
    sortOrder: 30,
  },
  {
    title: 'Ưu đãi GPU inference',
    subtitle: 'Giảm phí chạy model trên hạ tầng GPU của AI Markets',
    imageUrl: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=80',
    linkType: 'category',
    linkValue: 'inference',
    slot: 'offers',
    sortOrder: 10,
  },
  {
    title: 'License nội dung số',
    subtitle: 'Mua key hợp lệ — xem ngay trong app',
    imageUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&q=80',
    linkType: 'explore',
    linkValue: '',
    slot: 'offers',
    sortOrder: 20,
  },
  {
    title: 'Đối tác creator',
    subtitle: 'Shop doanh thu nổi bật trên AI Markets',
    imageUrl: 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=800&q=80',
    linkType: 'explore',
    linkValue: '',
    slot: 'partners',
    sortOrder: 10,
  },
];

async function main() {
  await mongoose.connect(config.mongoUri);
  let upserted = 0;
  for (const row of SEED) {
    const r = await Banner.findOneAndUpdate(
      { title: row.title, slot: row.slot },
      { $set: { ...row, active: true } },
      { upsert: true, new: true },
    );
    if (r) upserted += 1;
  }
  console.log(`seed-banners: upserted ${upserted} banners`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
