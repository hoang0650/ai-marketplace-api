function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' ? v : fallback;
}

/** GPU rental knobs (USD). Read on every call so tests / admins can change env without reload. */
function gpuRentalConfig() {
  return {
    /** Upstream vendor adapter name inside denglish-api. */
    provider: (process.env.GPU_RENTAL_PROVIDER || 'runpod').trim().toLowerCase(),
    markup: Math.max(0, num('GPU_RENTAL_MARKUP', 0.32)),
    minPricePerHour: Math.max(0, num('GPU_RENTAL_MIN_PRICE', 0.2)),
    /** Upstream storage cost per GB-month while running (container + volume) and while stopped (volume). */
    storageRunningGbMonth: Math.max(0, num('GPU_RENTAL_STORAGE_RUNNING_GB_MONTH', 0.1)),
    storageStoppedGbMonth: Math.max(0, num('GPU_RENTAL_STORAGE_STOPPED_GB_MONTH', 0.2)),
    diskGb: Math.max(10, Math.round(num('GPU_RENTAL_DISK_GB', 20))),
    volumeGbDefault: Math.round(num('GPU_RENTAL_VOLUME_GB', 20)),
    volumeGbMin: 10,
    volumeGbMax: Math.round(num('GPU_RENTAL_VOLUME_GB_MAX', 200)),
    maxGpuCount: Math.max(1, Math.round(num('GPU_RENTAL_MAX_GPU_COUNT', 1))),
    maxActivePerUser: Math.max(1, Math.round(num('GPU_RENTAL_MAX_PER_USER', 2))),
    /** Balance needed to create/start: this many hours of the running price. */
    minPrepayHours: Math.max(0, num('GPU_RENTAL_MIN_PREPAY_HOURS', 1)),
    warnMinutes: Math.max(1, num('GPU_RENTAL_WARN_MINUTES', 10)),
    terminateGraceMs: Math.max(60_000, num('GPU_RENTAL_TERMINATE_GRACE_HOURS', 24) * 3_600_000),
    tickMs: Math.max(10_000, num('GPU_RENTAL_TICK_MS', 60_000)),
    image: (process.env.GPU_RENTAL_IMAGE || 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404').trim(),
    offersTtlMs: Math.max(30_000, num('GPU_RENTAL_OFFERS_TTL_MS', 10 * 60_000)),
    /** Hide GPUs that cannot run the CUDA workspace image or are too small to be useful. */
    minVramGb: Math.max(0, num('GPU_RENTAL_MIN_VRAM_GB', 8)),
    /** Network volumes: upstream USD per GB-month (billed per minute from the wallet with the same markup). */
    volumeGbMonth: Math.max(0, num('GPU_VOLUME_GB_MONTH', 0.07)),
    volumeSizeMin: 10,
    volumeSizeMax: Math.max(10, Math.round(num('GPU_VOLUME_SIZE_MAX', 500))),
    volumeSizeDefault: Math.max(10, Math.round(num('GPU_VOLUME_SIZE_DEFAULT', 20))),
    maxVolumesPerUser: Math.max(1, Math.round(num('GPU_VOLUME_MAX_PER_USER', 3))),
    /** Balance needed to create a volume: this many hours of its price (at least one cent). */
    volumePrepayHours: Math.max(0, num('GPU_VOLUME_PREPAY_HOURS', 24)),
    /** Only proxy workspace traffic to hosts under this suffix (SSRF guard). */
    upstreamHostSuffix: (process.env.GPU_RENTAL_UPSTREAM_HOST_SUFFIX || '.proxy.runpod.net').trim().toLowerCase(),
    /** Browser session lifetime for the workspace proxy cookie. */
    sessionTtlS: Math.max(600, Math.round(num('GPU_RENTAL_SESSION_HOURS', 8) * 3600)),
  };
}

module.exports = { gpuRentalConfig };
