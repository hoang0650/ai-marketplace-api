const { gpuRentalConfig } = require('./config');

const HOURS_PER_MONTH = 730;
const CLOUDS = ['secure', 'community'];

function ceilCents(value) {
  return Math.ceil(Math.round(Number(value) * 1e6) / 1e4) / 100;
}

function withMarkup(cost, cfg = gpuRentalConfig()) {
  return Number(cost || 0) * (1 + cfg.markup);
}

/** Sell prices (USD/hour) for a GPU cost, rounded up to the cent. */
function quote({ costPerHour, gpuCount = 1, diskGb, volumeGb }, cfg = gpuRentalConfig()) {
  const disk = Number(diskGb ?? cfg.diskGb) || 0;
  const volume = Number(volumeGb ?? cfg.volumeGbDefault) || 0;
  const gpu = Math.max(0, Number(costPerHour) || 0) * Math.max(1, Number(gpuCount) || 1);
  const runningStorage = ((disk + volume) * cfg.storageRunningGbMonth) / HOURS_PER_MONTH;
  const stoppedStorage = (volume * cfg.storageStoppedGbMonth) / HOURS_PER_MONTH;
  return {
    pricePerHour: Math.max(cfg.minPricePerHour, ceilCents(withMarkup(gpu + runningStorage, cfg))),
    stoppedPricePerHour: ceilCents(withMarkup(stoppedStorage, cfg)),
  };
}

function perMinute(pricePerHour) {
  return Math.round((Number(pricePerHour) / 60) * 1e4) / 1e4;
}

function availabilityOf(stock) {
  const s = String(stock || '').toLowerCase();
  return s === 'high' ? 'high' : s === 'medium' ? 'medium' : s === 'low' ? 'low' : 'unknown';
}

const RANK = { unknown: 0, low: 1, medium: 2, high: 3 };

/** GPUs the CUDA workspace image can run, with enough VRAM to be useful. */
function isFitGpu(row, cfg = gpuRentalConfig()) {
  const id = String(row?.id || '');
  return /^(NVIDIA|Tesla)\b/i.test(id) && (Number(row.memoryGb) || 0) >= cfg.minVramGb;
}

/** Upstream clouds of a catalog row (legacy `{costPerHour, stock}` rows are treated as secure). */
function rowClouds(row) {
  if (row && row.clouds && typeof row.clouds === 'object') return row.clouds;
  return { secure: { costPerHour: row?.costPerHour, stock: row?.stock, dataCenters: [] } };
}

/**
 * Public offer: sell prices only (GPU + container disk + default pod volume, ×(1+markup)), per hour and per
 * minute, for each cloud that has real stock. Returns null when nothing is rentable (hidden from the list).
 */
function toOffer(row, cfg = gpuRentalConfig()) {
  const clouds = [];
  const src = rowClouds(row);
  for (const type of CLOUDS) {
    const c = src[type];
    const cost = Number(c?.costPerHour) || 0;
    const availability = availabilityOf(c?.stock);
    if (!(cost > 0) || availability === 'unknown') continue;
    const { pricePerHour } = quote({ costPerHour: cost }, cfg);
    const nv = quote({ costPerHour: cost, volumeGb: 0 }, cfg).pricePerHour;
    clouds.push({
      type,
      pricePerHour,
      pricePerMinute: perMinute(pricePerHour),
      networkVolumePricePerHour: nv,
      networkVolumePricePerMinute: perMinute(nv),
      availability,
      dataCenters:
        type === 'secure'
          ? (c.dataCenters || []).map((d) => ({ id: String(d.id), availability: availabilityOf(d.stock) }))
          : [],
    });
  }
  if (!clouds.length) return null;
  const cheapest = clouds.reduce((a, b) => (b.pricePerHour < a.pricePerHour ? b : a));
  const best = clouds.reduce((a, b) => (RANK[b.availability] > RANK[a.availability] ? b : a));
  return {
    id: String(row.id),
    name: String(row.name || row.id),
    memoryGb: Number(row.memoryGb) || 0,
    pricePerHour: cheapest.pricePerHour,
    pricePerMinute: cheapest.pricePerMinute,
    availability: best.availability,
    clouds,
  };
}

/** Network volume sell price: upstream GB-month × (1+markup); billed per minute from the wallet. */
function volumeQuote(sizeGb, cfg = gpuRentalConfig()) {
  const size = Math.max(0, Number(sizeGb) || 0);
  const pricePerGbMonth = Math.round(withMarkup(cfg.volumeGbMonth, cfg) * 1e4) / 1e4;
  return {
    pricePerGbMonth,
    pricePerMonth: ceilCents(size * pricePerGbMonth),
    pricePerHour: Math.round(((size * pricePerGbMonth) / HOURS_PER_MONTH) * 1e6) / 1e6,
  };
}

module.exports = { HOURS_PER_MONTH, CLOUDS, ceilCents, quote, toOffer, perMinute, availabilityOf, isFitGpu, rowClouds, volumeQuote };
