const { publicRuntime } = require('./runtime');
const { isPayoutHeld, holdKind, holdUntil, canOpenDispute, roundMoney, effectiveSellerNet } = require('./payout-hold');

function mapProduct(doc, { includeSecrets = false } = {}) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  return {
    id: String(o._id || o.id),
    slug: o.slug,
    name: o.name,
    tagline: o.tagline || '',
    description: o.description || '',
    category: o.category,
    productType: o.productType || undefined,
    provider: o.provider || undefined,
    creatorId: o.creator ? String(o.creator._id || o.creator) : '',
    creatorSlug: o.creatorSlug,
    creatorName: o.creatorName,
    coverUrl: o.coverUrl || '',
    gallery: o.gallery || [],
    pricing: o.pricing,
    runtime: publicRuntime(o.runtime, { includeSecrets, maskProviderUrls: true, modelId: o.slug }),
    rating: o.rating || 0,
    reviewCount: o.reviewCount || 0,
    salesCount: Number(o.salesCount) || 0,
    installCount: Number(o.salesCount) || 0,
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

function mapOrder(doc, { viewerId, viewerRole } = {}) {
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  const held = isPayoutHeld(o);
  const buyerId = o.buyer ? String(o.buyer._id || o.buyer) : '';
  const viewerIsBuyer = viewerId && buyerId === String(viewerId);
  return {
    id: String(o._id || o.id),
    productId: String(o.product?._id || o.product),
    productName: o.productName,
    buyerId,
    buyerName: o.buyerName,
    sellerId: o.seller ? String(o.seller._id || o.seller) : '',
    quantity: Math.max(1, Number(o.quantity) || 1),
    amount: o.amount,
    sellerNet: effectiveSellerNet(o),
    platformFee: roundMoney(o.platformFee),
    currency: o.currency || 'USD',
    status: o.status,
    provider: o.provider,
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
    completedAt: o.completedAt ? new Date(o.completedAt).toISOString() : null,
    payoutHoldUntil: holdUntil(o).toISOString(),
    payoutHeld: held,
    payoutHoldKind: holdKind(o),
    disputeStatus: o.disputeStatus || 'none',
    disputeReason: o.disputeReason || '',
    disputeOpenedAt: o.disputeOpenedAt ? new Date(o.disputeOpenedAt).toISOString() : null,
    disputeResolvedAt: o.disputeResolvedAt ? new Date(o.disputeResolvedAt).toISOString() : null,
    canDispute: !!(viewerIsBuyer || viewerRole === 'admin') && canOpenDispute(o),
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
  const products = await Product.find({ creator: user._id }).select('rating salesCount').lean();
  const productCount = products.length;
  const rating =
    productCount === 0
      ? 0
      : Math.round(
          (products.reduce((s, p) => s + (Number(p.rating) || 0), 0) / productCount) * 10
        ) / 10;
  const totalSales = products.reduce((s, p) => s + (Number(p.salesCount) || 0), 0);
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
