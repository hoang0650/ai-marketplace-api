# AI Film: owned RunPod worker

Set both API and AI service FILM_BACKEND=own. The API additionally needs STUDIO_FILM_MARKUP=0, explicit cost-based FILM_I2V_COST_PER_SEC and FILM_IMAGE_COST prices, FILM_FREE_VIDEOS_PER_DAY=0 and FILM_FREE_IMAGES_PER_DAY=0. The AI service needs FILM_WORKER_ENDPOINT=lt3fw01s0d35ua and its existing RUNPOD_API_KEY. Public endpoints are not used as fallback in owned mode.

The owned worker receives explicit model/action names and 4-step Wan / 8-step Qwen Lightning requests. Its inline artifact is decoded into bounded job-local scratch before existing MinIO upload handling. Missing output or unexpected models fail safely.

Scenes use exact 5-second increments (10-second shots plus optional 5-second tail), preserving the requested 20-second maximum for free videos. Daily free generation is disabled by default and in the current release. Optional quotas may be enabled explicitly: at most 20 planned seconds per free video request, with configurable video and image counts. Automatic keyframes count toward image allowance. Longer scenes are paid, and shorter re-shoot requests each count as one video request. Quotas reset at midnight UTC+7.

Mongo optimistic compare-and-swap reservations prevent parallel requests from exceeding the free limit. Failed submissions return the quota. On settlement, free video allowance is returned only if no video was produced; image allowance is returned if no image was produced. Releases are idempotent. Failed paid components use the existing wallet refund flow with effective rates excluding free components. The render/narration charge remains separate.

GPU model loading and model switching can dominate cost. FILM_GPU_COST_PER_SEC, if configured on the AI service, estimates execution cost from RunPod executionTime; this excludes startup/idle/storage and is not an invoice amount. The cost report should include those separately. Never treat missing billing data as zero cost.
