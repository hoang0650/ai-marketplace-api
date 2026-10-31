/**
 * SpaceBot's FSL-1.1-ALv2 licence forbids competing commercial hosting.
 * Hide it from the rental catalog and refuse new launches. Do not delete
 * existing subscriptions, sessions, or volumes.
 */

const SPACEBOT_PRODUCT_SLUGS = Object.freeze(['spacebot', 'space-bot', 'spacebot-ops-agent']);

const UNLISTED_MESSAGE =
  'SpaceBot is not offered for new rentals. Existing workspace data is kept and has not been deleted.';

const UNLISTED_LABEL = Object.freeze({
  vi: 'SpaceBot tạm ngừng cho thuê (giấy phép). Dữ liệu cũ được giữ.',
  en: 'SpaceBot is not offered for rent (licence). Existing data is kept.',
  zh: 'SpaceBot 暂停出租（许可限制）。已有数据会保留。',
});

function spacebotUnlistedError() {
  const err = new Error(UNLISTED_MESSAGE);
  err.status = 403;
  err.code = 'SPACEBOT_UNLISTED';
  return err;
}

function spacebotListingFields(agentId) {
  if (agentId !== 'spacebot') return { listed: true, unavailableReason: '' };
  return { listed: false, unavailableReason: 'licence', unavailableLabel: UNLISTED_LABEL };
}

async function unpublishSpacebotListings({ Product, AgentTemplate }) {
  const products = Product
    ? await Product.updateMany(
        { slug: { $in: SPACEBOT_PRODUCT_SLUGS }, published: { $ne: false } },
        { $set: { published: false, featured: false } },
      )
    : { modifiedCount: 0 };
  const templates = AgentTemplate
    ? await AgentTemplate.updateMany(
        { slug: 'spacebot', published: { $ne: false } },
        { $set: { published: false } },
      )
    : { modifiedCount: 0 };
  return {
    products: products.modifiedCount || 0,
    templates: templates.modifiedCount || 0,
  };
}

module.exports = {
  SPACEBOT_PRODUCT_SLUGS,
  UNLISTED_MESSAGE,
  UNLISTED_LABEL,
  spacebotUnlistedError,
  spacebotListingFields,
  unpublishSpacebotListings,
};
