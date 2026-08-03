function mapProduct(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    slug: o.slug,
    name: o.name,
    tagline: o.tagline || '',
    description: o.description || '',
    category: o.category,
    creatorId: o.creator ? String(o.creator._id || o.creator) : '',
    creatorSlug: o.creatorSlug,
    creatorName: o.creatorName,
    coverUrl: o.coverUrl || '',
    gallery: o.gallery || [],
    pricing: o.pricing,
    rating: o.rating || 0,
    reviewCount: o.reviewCount || 0,
    installCount: o.installCount || 0,
    tags: o.tags || [],
    apiDocsMarkdown: o.apiDocsMarkdown || '',
    changelog: o.changelog || [],
    featured: !!o.featured,
    publishedAt: o.publishedAt
      ? new Date(o.publishedAt).toISOString()
      : new Date().toISOString(),
  };
}

function mapReview(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    productId: String(o.product?._id || o.product),
    userId: String(o.user?._id || o.user),
    userName: o.userName,
    rating: o.rating,
    title: o.title || '',
    body: o.body || '',
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
  };
}

function mapOrder(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    productId: String(o.product?._id || o.product),
    productName: o.productName,
    buyerName: o.buyerName,
    amount: o.amount,
    currency: o.currency || 'USD',
    status: o.status,
    provider: o.provider,
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
  };
}

function mapWallet(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    type: o.type,
    amount: o.amount,
    currency: o.currency || 'USD',
    note: o.note || '',
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
  };
}

function mapNotification(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    title: o.title,
    body: o.body || '',
    read: !!o.read,
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
    href: o.href || undefined,
  };
}

async function mapCreator(user, Product) {
  const products = await Product.find({ creator: user._id }).select('rating installCount').lean();
  const productCount = products.length;
  const rating =
    productCount === 0
      ? 0
      : Math.round(
          (products.reduce((s, p) => s + (Number(p.rating) || 0), 0) / productCount) * 10
        ) / 10;
  const totalSales = products.reduce((s, p) => s + (Number(p.installCount) || 0), 0);
  return {
    id: user._id.toString(),
    slug: user.creatorSlug,
    name: user.name,
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || '',
    coverUrl: user.coverUrl || '',
    verified: !!user.verified,
    productCount,
    rating,
    totalSales,
  };
}

module.exports = {
  mapProduct,
  mapReview,
  mapOrder,
  mapWallet,
  mapNotification,
  mapCreator,
};
