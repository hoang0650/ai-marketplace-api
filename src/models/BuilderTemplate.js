const mongoose = require('mongoose');

/**
 * Source files behind a `template-web` / `template-app` Product. Kept out of the Product
 * document so catalog queries never load template code. Buyers get a copy as a
 * BuilderProject once they own the listing (free, paid order, or seller/admin).
 */
const fileSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, maxlength: 120 },
    content: { type: String, default: '' },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['web', 'app'], required: true },
    files: { type: [fileSchema], default: [] },
    version: { type: Number, default: 0 },
    /** Public sandboxed live demo on the product page (source is visible to visitors). */
    demoEnabled: { type: Boolean, default: true },
    useCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BuilderTemplate', schema);
