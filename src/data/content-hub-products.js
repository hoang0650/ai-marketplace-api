/**
 * Test catalog for Voice clone, Video AI (watch series), and Stories.
 * Video AI is seller-uploaded watch content (ai-film-series) — not text-to-video models.
 */
const { inferProductType } = require('./marketplace-types');
const { taxCategoryFromProduct } = require('../finance/tax-category');
const { normalizeContentMeta, isVoiceCategory, isLicenseCategory } = require('../utils/license-keys');
const { voiceCloneRuntime } = require('../utils/voice-clone');

const SAMPLE_VOICE = {
  mai: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  khoa: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  ava: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
  bay: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3',
};

function cover(id) {
  return `https://images.unsplash.com/${id}?w=1200&q=80`;
}

function voiceProduct(partial) {
  const contentMeta = {
    kind: 'voice',
    voiceModes: partial.voiceModes || ['tts'],
    voiceSampleUrl: partial.voiceSampleUrl || '',
    creditUnit: 'character',
    charactersPerCredit: partial.charactersPerCredit || 1000,
  };
  return {
    creatorId: partial.creatorId,
    creatorSlug: partial.creatorSlug,
    creatorName: partial.creatorName,
    slug: partial.slug,
    id: `p-voice-${partial.slug}`,
    name: partial.name,
    tagline: partial.tagline,
    description: partial.description,
    category: 'voice-clone',
    coverUrl: partial.coverUrl,
    gallery: [partial.coverUrl],
    pricing: {
      model: 'usage',
      price: 0,
      currency: 'USD',
      usageUnit: '1K characters',
      usageRate: partial.usageRate,
    },
    contentMeta,
    rating: partial.rating,
    reviewCount: partial.reviewCount,
    installCount: partial.installCount,
    salesCount: partial.installCount,
    tags: ['voice-clone', ...(partial.tags || [])],
    apiDocsMarkdown: partial.apiDocsMarkdown,
    changelog: [
      { version: '1.0.0', date: '2026-08-20', notes: 'Listed on AI Markets voice hub.' },
    ],
    featured: !!partial.featured,
    publishedAt: partial.publishedAt,
  };
}

function licenseProduct({ category, kind, ...partial }) {
  const month = Number(partial.licensePrices.month);
  return {
    creatorId: partial.creatorId,
    creatorSlug: partial.creatorSlug,
    creatorName: partial.creatorName,
    slug: partial.slug,
    id: partial.id,
    name: partial.name,
    tagline: partial.tagline,
    description: partial.description,
    category,
    coverUrl: partial.coverUrl,
    gallery: [partial.coverUrl],
    pricing: {
      model: 'subscription',
      price: month,
      currency: 'USD',
      interval: 'month',
    },
    contentMeta: {
      kind,
      episodeCount: partial.episodeCount,
      licenseTerm: 'month',
      licensePrices: partial.licensePrices,
    },
    rating: partial.rating,
    reviewCount: partial.reviewCount,
    installCount: partial.installCount,
    salesCount: partial.installCount,
    tags: [category, ...(partial.tags || [])],
    apiDocsMarkdown: partial.apiDocsMarkdown,
    changelog: [
      { version: '1.0.0', date: '2026-08-20', notes: 'License key day / month / year.' },
    ],
    featured: !!partial.featured,
    publishedAt: partial.publishedAt,
  };
}

function buildContentHubProducts() {
  const voices = [
    voiceProduct({
      slug: 'mai-linh-narrator',
      name: 'Mai Linh Narrator',
      tagline: 'Giọng nữ Bắc — kể chuyện, audiobook, TTS tiếng Việt.',
      description:
        'Voice clone thuê theo credit ký tự. Phù hợp audiobook, explainer, IVR. Sample 15s; TTS only. Không phải model text-to-speech generic — đây là giọng đã clone/upload của seller.',
      creatorId: 'c-nova',
      creatorSlug: 'nova-labs',
      creatorName: 'Nova Labs',
      coverUrl: cover('photo-1478737270239-2f02b77fc618'),
      voiceModes: ['tts'],
      voiceSampleUrl: SAMPLE_VOICE.mai,
      usageRate: 0.02,
      rating: 4.9,
      reviewCount: 64,
      installCount: 1820,
      tags: ['vietnamese', 'female', 'audiobook', 'tts'],
      featured: true,
      publishedAt: '2026-08-12T00:00:00.000Z',
      apiDocsMarkdown:
        'POST playground TTS với `voiceSlug=mai-linh-narrator`. 1 credit = 1000 ký tự.',
    }),
    voiceProduct({
      slug: 'khoa-bilingual-studio',
      name: 'Khoa Bilingual Studio',
      tagline: 'Nam Việt–Anh, TTS + STT cho call center.',
      description:
        'Giọng nam trung tính, hỗ trợ đọc (TTS) và nhận dạng (STT). Tính credit theo ký tự đầu vào. Dùng cho CSKH, training, dubbing.',
      creatorId: 'c-orbit',
      creatorSlug: 'orbit-ai',
      creatorName: 'Orbit AI',
      coverUrl: cover('photo-1590602847861-f357a9332bbc'),
      voiceModes: ['tts', 'stt'],
      voiceSampleUrl: SAMPLE_VOICE.khoa,
      charactersPerCredit: 800,
      usageRate: 0.035,
      rating: 4.7,
      reviewCount: 41,
      installCount: 960,
      tags: ['vietnamese', 'english', 'male', 'tts', 'stt'],
      publishedAt: '2026-08-14T00:00:00.000Z',
      apiDocsMarkdown: 'Modes: `tts`, `stt`. 1 credit = 800 ký tự.',
    }),
    voiceProduct({
      slug: 'ava-commercial-en',
      name: 'Ava Commercial EN',
      tagline: 'English female — ads, product videos, explainer.',
      description:
        'US English commercial voice. TTS only, billed per 1K characters. Sample clip on product page.',
      creatorId: 'c-pulse',
      creatorSlug: 'pulse-studio',
      creatorName: 'Pulse Studio',
      coverUrl: cover('photo-1516280440614-37939bbacd81'),
      voiceModes: ['tts'],
      voiceSampleUrl: SAMPLE_VOICE.ava,
      usageRate: 0.018,
      rating: 4.6,
      reviewCount: 29,
      installCount: 740,
      tags: ['english', 'female', 'ads', 'tts'],
      publishedAt: '2026-08-18T00:00:00.000Z',
      apiDocsMarkdown: 'TTS English. 1 credit = 1000 characters.',
    }),
    voiceProduct({
      slug: 'ong-bay-mekong',
      name: 'Ông Bảy Mekong',
      tagline: 'Giọng Nam Bộ — kể chuyện miền Tây, TTS + STT.',
      description:
        'Giọng ông già miền Tây, ấm, chậm. Thuê để làm truyện audio, podcast địa phương. Hỗ trợ TTS và STT.',
      creatorId: 'c-nova',
      creatorSlug: 'nova-labs',
      creatorName: 'Nova Labs',
      coverUrl: cover('photo-1511671782779-c97d3d27a1d4'),
      voiceModes: ['tts', 'stt'],
      voiceSampleUrl: SAMPLE_VOICE.bay,
      usageRate: 0.022,
      rating: 4.8,
      reviewCount: 22,
      installCount: 410,
      tags: ['vietnamese', 'southern', 'storytelling', 'tts', 'stt'],
      publishedAt: '2026-08-22T00:00:00.000Z',
      apiDocsMarkdown: 'TTS/STT. 1 credit = 1000 ký tự.',
    }),
  ];

  const films = [
    licenseProduct({
      category: 'ai-film-series',
      kind: 'series',
      id: 'p-film-neon-harbor',
      slug: 'neon-harbor',
      name: 'Neon Harbor',
      tagline: 'Phim AI 12 tập — cảng đêm, cyber-noir.',
      description:
        'Series do seller upload để xem trên hub Video AI. Mở khóa bằng license key ngày / tháng / năm. Không phải model text-to-video.',
      creatorId: 'c-pulse',
      creatorSlug: 'pulse-studio',
      creatorName: 'Pulse Studio',
      coverUrl: cover('photo-1536440136628-849c177e76a1'),
      episodeCount: 12,
      licensePrices: { day: 1.99, month: 9.99, year: 69 },
      rating: 4.8,
      reviewCount: 112,
      installCount: 3400,
      tags: ['sci-fi', 'noir', 'series'],
      featured: true,
      publishedAt: '2026-08-10T00:00:00.000Z',
      apiDocsMarkdown: 'License key AIM-xxxx. 12 tập. Xem trên /video-ai.',
    }),
    licenseProduct({
      category: 'ai-film-series',
      kind: 'series',
      id: 'p-film-sai-gon-after-rain',
      slug: 'sai-gon-after-rain',
      name: 'Sài Gòn After Rain',
      tagline: '8 tập romance — mưa chiều Quận 3.',
      description:
        'Phim ngắn AI nhiều tập, nội dung đã render sẵn. Buyer mua license theo hạn, nhận key qua email.',
      creatorId: 'c-nova',
      creatorSlug: 'nova-labs',
      creatorName: 'Nova Labs',
      coverUrl: cover('photo-1517142089942-ba376ce32a2e'),
      episodeCount: 8,
      licensePrices: { day: 0.99, month: 6.99, year: 49 },
      rating: 4.7,
      reviewCount: 86,
      installCount: 2100,
      tags: ['romance', 'vietnam', 'series'],
      publishedAt: '2026-08-16T00:00:00.000Z',
      apiDocsMarkdown: '8 tập. License day / month / year.',
    }),
    licenseProduct({
      category: 'ai-film-series',
      kind: 'series',
      id: 'p-film-iron-lotus',
      slug: 'iron-lotus',
      name: 'Iron Lotus',
      tagline: '24 tập hành động — võ thuật xưa, drone nay.',
      description:
        'Series dài tập. License năm tiết kiệm nhất. Nội dung xem tại hub Video AI sau khi có key còn hạn.',
      creatorId: 'c-orbit',
      creatorSlug: 'orbit-ai',
      creatorName: 'Orbit AI',
      coverUrl: cover('photo-1485846234645-a62644f84728'),
      episodeCount: 24,
      licensePrices: { day: 2.49, month: 12.99, year: 89 },
      rating: 4.5,
      reviewCount: 54,
      installCount: 1280,
      tags: ['action', 'wuxia', 'series'],
      publishedAt: '2026-08-21T00:00:00.000Z',
      apiDocsMarkdown: '24 tập. Key theo hạn mua.',
    }),
    licenseProduct({
      category: 'ai-film-series',
      kind: 'series',
      id: 'p-film-the-last-pagoda',
      slug: 'the-last-pagoda',
      name: 'The Last Pagoda',
      tagline: '6 tập kinh dị — chùa trên núi, sương đêm.',
      description:
        'Mini-series horror AI. Poster + tập đã upload. Mở khóa xem bằng license key.',
      creatorId: 'c-pulse',
      creatorSlug: 'pulse-studio',
      creatorName: 'Pulse Studio',
      coverUrl: cover('photo-1509248961158-e54f6934749c'),
      episodeCount: 6,
      licensePrices: { day: 1.49, month: 7.99, year: 54 },
      rating: 4.4,
      reviewCount: 33,
      installCount: 620,
      tags: ['horror', 'vietnam', 'miniseries'],
      publishedAt: '2026-08-25T00:00:00.000Z',
      apiDocsMarkdown: '6 tập. License day / month / year.',
    }),
  ];

  const stories = [
    licenseProduct({
      category: 'story-book',
      kind: 'story',
      id: 'p-story-dem-ha-noi',
      slug: 'dem-ha-noi',
      name: 'Đêm Hà Nội',
      tagline: 'Tiểu thuyết 48 chương — phố cổ, mưa phùn.',
      description:
        'Truyện AI đọc trên hub Stories. License key ngày / tháng / năm. Không phải model sinh truyện realtime — nội dung seller đã xuất bản.',
      creatorId: 'c-nova',
      creatorSlug: 'nova-labs',
      creatorName: 'Nova Labs',
      coverUrl: cover('photo-1481627834876-b7833e8f5570'),
      episodeCount: 48,
      licensePrices: { day: 0.79, month: 4.99, year: 29 },
      rating: 4.9,
      reviewCount: 201,
      installCount: 5600,
      tags: ['literary', 'vietnam', 'novel'],
      featured: true,
      publishedAt: '2026-08-08T00:00:00.000Z',
      apiDocsMarkdown: '48 chương. License AIM-xxxx.',
    }),
    licenseProduct({
      category: 'story-book',
      kind: 'story',
      id: 'p-story-cao-va-rung',
      slug: 'cao-va-rung',
      name: 'Cáo Và Rừng',
      tagline: '12 chương thiếu nhi — cáo, rừng, bài học.',
      description:
        'Truyện thiếu nhi, đọc từng chương sau khi có license còn hạn. Có thể kết hợp giọng clone Ông Bảy / Mai Linh.',
      creatorId: 'c-pulse',
      creatorSlug: 'pulse-studio',
      creatorName: 'Pulse Studio',
      coverUrl: cover('photo-1441974231531-c6227db76b6e'),
      episodeCount: 12,
      licensePrices: { day: 0.49, month: 2.99, year: 19 },
      rating: 4.8,
      reviewCount: 77,
      installCount: 1900,
      tags: ['kids', 'fable', 'illustrated'],
      publishedAt: '2026-08-15T00:00:00.000Z',
      apiDocsMarkdown: '12 chương. License day / month / year.',
    }),
    licenseProduct({
      category: 'story-book',
      kind: 'story',
      id: 'p-story-founder-notes',
      slug: 'founder-notes',
      name: 'Founder Notes',
      tagline: '20 chương — nhật ký dựng startup SEA.',
      description:
        'Sách kinh doanh dạng chương. Mở khóa đọc bằng license key. Test checkout term tháng / năm.',
      creatorId: 'c-orbit',
      creatorSlug: 'orbit-ai',
      creatorName: 'Orbit AI',
      coverUrl: cover('photo-1450101499163-c8848c66ca85'),
      episodeCount: 20,
      licensePrices: { day: 1.29, month: 8.99, year: 59 },
      rating: 4.6,
      reviewCount: 48,
      installCount: 880,
      tags: ['business', 'startup', 'nonfiction'],
      publishedAt: '2026-08-19T00:00:00.000Z',
      apiDocsMarkdown: '20 chương. License key theo hạn.',
    }),
    licenseProduct({
      category: 'story-book',
      kind: 'story',
      id: 'p-story-mat-thu-mekong',
      slug: 'mat-thu-mekong',
      name: 'Mật Thư Mekong',
      tagline: '32 chương trinh thám — mật thư sông Tiền.',
      description:
        'Truyện trinh thám nhiều chương. Buyer chọn hạn license trên trang sản phẩm rồi checkout.',
      creatorId: 'c-nova',
      creatorSlug: 'nova-labs',
      creatorName: 'Nova Labs',
      coverUrl: cover('photo-1432821596592-e2c18b78144f'),
      episodeCount: 32,
      licensePrices: { day: 0.99, month: 5.99, year: 39 },
      rating: 4.7,
      reviewCount: 91,
      installCount: 1420,
      tags: ['mystery', 'vietnam', 'novel'],
      publishedAt: '2026-08-24T00:00:00.000Z',
      apiDocsMarkdown: '32 chương. License day / month / year.',
    }),
  ];

  return [...voices, ...films, ...stories];
}

function buildContentHubReviews() {
  return [
    {
      id: 'r-hub-mai',
      productId: 'p-voice-mai-linh-narrator',
      userId: 'u-buyer',
      userName: 'Lan Nguyen',
      rating: 5,
      title: 'Giọng kể rất mượt',
      body: 'TTS tiếng Việt ổn định, credit rõ ràng theo ký tự.',
      createdAt: '2026-08-20T00:00:00.000Z',
    },
    {
      id: 'r-hub-neon',
      productId: 'p-film-neon-harbor',
      userId: 'u-buyer',
      userName: 'Lan Nguyen',
      rating: 5,
      title: 'Xem license tháng ok',
      body: 'Key AIM đến email, 12 tập xem trên hub Video AI.',
      createdAt: '2026-08-21T00:00:00.000Z',
    },
    {
      id: 'r-hub-hanoi',
      productId: 'p-story-dem-ha-noi',
      userId: 'u-buyer',
      userName: 'Lan Nguyen',
      rating: 5,
      title: 'Đọc hết 48 chương',
      body: 'License năm rẻ. Hub Stories mở đúng chapter.',
      createdAt: '2026-08-22T00:00:00.000Z',
    },
    {
      id: 'r-hub-fox',
      productId: 'p-story-cao-va-rung',
      userId: 'u-buyer',
      userName: 'Lan Nguyen',
      rating: 4,
      title: 'Bé nhà mình thích',
      body: '12 chương ngắn, giá ngày hợp để thử.',
      createdAt: '2026-08-23T00:00:00.000Z',
    },
  ];
}

/** Sample licenses for buyer@example.com after products exist. */
function buildContentHubLicenseSeeds() {
  return [
    { productSlug: 'neon-harbor', term: 'month', amount: 9.99 },
    { productSlug: 'dem-ha-noi', term: 'year', amount: 29 },
    { productSlug: 'iron-lotus', term: 'day', amount: 2.49, expired: true },
  ];
}

function hubProductFields(p) {
  const productType = inferProductType(p.category, p.tags);
  const contentMeta = normalizeContentMeta(p.category, {
    ...(p.contentMeta || {}),
    cloneStatus: isVoiceCategory(p.category) && p.contentMeta?.voiceSampleUrl ? 'ready' : p.contentMeta?.cloneStatus,
    cloneReadyAt: isVoiceCategory(p.category) && p.contentMeta?.voiceSampleUrl ? '2026-08-20T00:00:00.000Z' : '',
  });
  return {
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    description: p.description,
    category: p.category,
    creatorSlug: p.creatorSlug,
    creatorName: p.creatorName,
    coverUrl: p.coverUrl,
    gallery: p.gallery || [],
    pricing: p.pricing,
    runtime: isVoiceCategory(p.category) ? voiceCloneRuntime(p.contentMeta?.voiceSampleUrl) : {},
    contentMeta: contentMeta || undefined,
    rating: p.rating || 0,
    reviewCount: p.reviewCount || 0,
    installCount: p.installCount || 0,
    salesCount: p.salesCount || p.installCount || 0,
    tags: p.tags || [],
    apiDocsMarkdown: p.apiDocsMarkdown || '',
    changelog: p.changelog || [],
    featured: !!p.featured,
    publishedAt: p.publishedAt ? new Date(p.publishedAt) : new Date(),
    productType,
    taxCategory: taxCategoryFromProduct({ category: p.category, productType }),
    ownershipType: 'THIRD_PARTY_SELLER',
    infraProvider: isVoiceCategory(p.category) ? 'runpod_public' : '',
    published: true,
    moderationStatus: 'active',
    complianceStatus: 'approved',
  };
}

function isHubCategory(category) {
  return isVoiceCategory(category) || isLicenseCategory(category);
}

const SAMPLE_VIDEOS = [
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  'https://storage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
];

const SAMPLE_PAGES = [
  'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=1400&q=80',
  'https://images.unsplash.com/photo-1509248961158-e54f6934749c?w=1400&q=80',
  'https://images.unsplash.com/photo-1517142089942-ba376ce32a2e?w=1400&q=80',
  'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1400&q=80',
  'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=1400&q=80',
  'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1400&q=80',
  'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=1400&q=80',
  'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?w=1400&q=80',
];

function videoEp(title, i) {
  return {
    title,
    kind: 'video',
    sourceUrl: SAMPLE_VIDEOS[i % SAMPLE_VIDEOS.length],
    contentType: 'video/mp4',
  };
}

function imageEp(title, i) {
  return {
    title,
    kind: 'image',
    sourceUrl: SAMPLE_PAGES[i % SAMPLE_PAGES.length],
    contentType: 'image/jpeg',
  };
}

function buildContentHubEpisodes() {
  return [
    {
      productSlug: 'neon-harbor',
      items: [
        videoEp('Tập 1 — Đèn cảng', 0),
        videoEp('Tập 2 — Sương đêm', 1),
        videoEp('Tập 3 — Hàng cấm', 2),
        videoEp('Tập 4 — Radio cũ', 3),
      ],
    },
    {
      productSlug: 'sai-gon-after-rain',
      items: [
        videoEp('Tập 1 — Mưa chiều Q3', 2),
        videoEp('Tập 2 — Xe ôm đêm', 4),
        videoEp('Tập 3 — Cà phê sữa', 5),
      ],
    },
    {
      productSlug: 'iron-lotus',
      items: [
        videoEp('Tập 1 — Lò rèn', 6),
        videoEp('Tập 2 — Drone trên đỉnh', 7),
        videoEp('Tập 3 — Hoa sen sắt', 0),
      ],
    },
    {
      productSlug: 'the-last-pagoda',
      items: [
        videoEp('Tập 1 — Chuông chùa', 1),
        videoEp('Tập 2 — Sương núi', 3),
        videoEp('Tập 3 — Bước chân', 5),
      ],
    },
    {
      productSlug: 'dem-ha-noi',
      items: [
        imageEp('Chương 1 — Phố cổ', 0),
        imageEp('Chương 2 — Mưa phùn', 1),
        imageEp('Chương 3 — Đèn dầu', 2),
        imageEp('Chương 4 — Hồ Gươm', 5),
      ],
    },
    {
      productSlug: 'cao-va-rung',
      items: [
        imageEp('Chương 1 — Cáo gặp rừng', 3),
        imageEp('Chương 2 — Lá vàng', 4),
        imageEp('Chương 3 — Bài học', 6),
      ],
    },
    {
      productSlug: 'founder-notes',
      items: [
        imageEp('Chương 1 — Pitch đầu', 7),
        imageEp('Chương 2 — Runway', 4),
        imageEp('Chương 3 — Pivot', 0),
      ],
    },
    {
      productSlug: 'mat-thu-mekong',
      items: [
        imageEp('Chương 1 — Mật thư', 6),
        imageEp('Chương 2 — Sông Tiền', 5),
        imageEp('Chương 3 — Chợ nổi', 1),
        imageEp('Chương 4 — Đêm cuối', 2),
      ],
    },
  ];
}

/** Upsert sample video/image chapters so Watch / Read can be tested without MinIO. */
async function upsertContentHubEpisodes(ContentEpisode, Product) {
  let n = 0;
  for (const pack of buildContentHubEpisodes()) {
    const product = await Product.findOne({ slug: pack.productSlug });
    if (!product) continue;
    let i = 1;
    for (const item of pack.items) {
      await ContentEpisode.findOneAndUpdate(
        { product: product._id, index: i },
        {
          $set: {
            seller: product.creator,
            title: item.title,
            kind: item.kind,
            contentType: item.contentType || '',
            sourceUrl: item.sourceUrl,
            published: true,
          },
          $setOnInsert: { product: product._id, index: i },
        },
        { upsert: true },
      );
      i += 1;
      n += 1;
    }
    await Product.updateOne(
      { _id: product._id },
      { $set: { 'contentMeta.episodeCount': pack.items.length } },
    );
  }
  return n;
}

module.exports = {
  SAMPLE_VOICE,
  buildContentHubProducts,
  buildContentHubReviews,
  buildContentHubLicenseSeeds,
  buildContentHubEpisodes,
  upsertContentHubEpisodes,
  hubProductFields,
  isHubCategory,
};
