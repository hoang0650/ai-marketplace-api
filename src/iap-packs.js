/** Consumable wallet packs. SKUs must match App Store Connect + Play Console. */
const WALLET_IAP_PACKS = [
  { sku: 'aimarkets.wallet.5', usd: 5 },
  { sku: 'aimarkets.wallet.10', usd: 10 },
  { sku: 'aimarkets.wallet.20', usd: 20 },
  { sku: 'aimarkets.wallet.50', usd: 50 },
  { sku: 'aimarkets.wallet.100', usd: 100 },
];

function findIapPack(sku) {
  const id = String(sku || '').trim();
  return WALLET_IAP_PACKS.find((p) => p.sku === id) || null;
}

module.exports = { WALLET_IAP_PACKS, findIapPack };
