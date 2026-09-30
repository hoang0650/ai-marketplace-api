const { gpuRentalConfig } = require('./config');

const HOURS_PER_MONTH = 730;

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

/** Public offer: no upstream cost, no vendor fields. */
function toOffer(row, cfg = gpuRentalConfig()) {
  const { pricePerHour } = quote({ costPerHour: row.costPerHour }, cfg);
  const stock = String(row.stock || '').toLowerCase();
  return {
    id: String(row.id),
    name: String(row.name || row.id),
    memoryGb: Number(row.memoryGb) || 0,
    pricePerHour,
    availability: stock === 'high' ? 'high' : stock === 'medium' ? 'medium' : stock === 'low' ? 'low' : 'unknown',
  };
}

module.exports = { HOURS_PER_MONTH, ceilCents, quote, toOffer };
