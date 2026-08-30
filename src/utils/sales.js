const Order = require('../models/Order');
const Product = require('../models/Product');

function clampQty(n) {
  const q = Math.floor(Number(n));
  if (!Number.isFinite(q)) return 1;
  return Math.min(99, Math.max(1, q));
}

/** Recompute denormalized salesCount from paid orders (source of truth). */
async function syncSalesCountsFromOrders() {
  const rows = await Order.aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$product', n: { $sum: { $ifNull: ['$quantity', 1] } } } },
  ]);
  const soldIds = rows.map((row) => row._id).filter(Boolean);
  const ops = rows
    .filter((row) => row._id)
    .map((row) => ({
      updateOne: {
        filter: { _id: row._id },
        update: { $set: { salesCount: row.n } },
      },
    }));
  if (ops.length) await Product.bulkWrite(ops);
  const zero = await Product.updateMany(
    soldIds.length ? { _id: { $nin: soldIds } } : {},
    { $set: { salesCount: 0 } },
  );
  return { productsWithSales: ops.length, reset: zero.modifiedCount };
}

module.exports = { clampQty, syncSalesCountsFromOrders };
