const config = require('../config/env');

/**
 * Call denglish-api inference router.
 * @param {{ provider: string, model?: string, endpointId?: string, input: object, action?: string }} body
 */
async function callDenglishInfer(body) {
  const base = (config.denglishApiUrl || '').replace(/\/$/, '');
  if (!base) {
    const err = new Error('DENGLISH_API_URL is not configured');
    err.code = 'DENGLISH_NOT_CONFIGURED';
    throw err;
  }

  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.denglishServiceKey) {
    headers['X-Service-Key'] = config.denglishServiceKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.denglishTimeoutMs);
  try {
    const res = await fetch(`${base}/v1/infer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: body.provider,
        model: body.model || undefined,
        endpoint_id: body.endpointId || undefined,
        input: body.input || {},
        action: body.action || 'runsync',
      }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.detail || json.message || `denglish-api HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function denglishGet(path) {
  const base = (config.denglishApiUrl || '').replace(/\/$/, '');
  if (!base) {
    const err = new Error('DENGLISH_API_URL is not configured');
    err.code = 'DENGLISH_NOT_CONFIGURED';
    throw err;
  }
  const headers = {};
  if (config.denglishServiceKey) headers['X-Service-Key'] = config.denglishServiceKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.denglishTimeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { headers, signal: controller.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.detail || json.message || `denglish-api HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** RunPod Public Endpoints catalog with per-model input schema and pricing. */
function fetchModelCatalog(kind) {
  return denglishGet(`/v1/models${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);
}

function fetchModelSchema(identifier) {
  return denglishGet(`/v1/models/${encodeURIComponent(identifier)}`);
}

/**
 * Ask denglish-api what it would send to RunPod and what the docs pricing says.
 * @returns {Promise<{ endpointId: string, kind: string, input: object, warnings: string[], unit: string, quantity: number, estimatedCost: number|null }>}
 */
async function quoteInference({ model, input }) {
  const base = (config.denglishApiUrl || '').replace(/\/$/, '');
  if (!base) {
    const err = new Error('DENGLISH_API_URL is not configured');
    err.code = 'DENGLISH_NOT_CONFIGURED';
    throw err;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (config.denglishServiceKey) headers['X-Service-Key'] = config.denglishServiceKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.denglishTimeoutMs);
  try {
    const res = await fetch(`${base}/v1/quote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: input || {} }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.detail || json.message || `denglish-api HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Local sandbox when denglish-api is unreachable (dev only). */
function localSandboxInfer({ provider, model, endpointId, input }) {
  const prompt = String(input?.prompt || input?.text || '');
  const duration = Number(input?.duration) || 0;
  const ep = endpointId || model || 'sandbox';
  if (duration > 0 || /video|i2v|t2v/i.test(ep)) {
    return {
      ok: true,
      provider: provider || 'runpod_public',
      model: ep,
      data: {
        kind: 'video',
        video_url: 'https://image.runpod.ai/asset/bytedance/seedance-v1-5-pro-i2.png',
        status: 'COMPLETED',
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        unit: 'seconds',
        quantity: duration || 5,
      },
      latency_ms: 40,
      raw: { sandbox: true, local: true },
    };
  }
  if (input?.image || /image|flux|qwen/i.test(ep)) {
    return {
      ok: true,
      provider: provider || 'runpod_public',
      model: ep,
      data: { kind: 'image', image_url: input?.image || 'https://picsum.photos/seed/phai/1024/1024' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        unit: 'images',
        quantity: 1,
      },
      latency_ms: 30,
      raw: { sandbox: true, local: true },
    };
  }
  const inTok = Math.max(1, Math.ceil(prompt.length / 4));
  const outTok = 64;
  const text = `[sandbox marketplace→denglish] ${prompt.slice(0, 400)}`;
  return {
    ok: true,
    provider: provider || 'runpod_serverless',
    model: model || ep,
    data: {
      kind: 'text',
      text,
      choices: [{ tokens: [text] }],
      ai_response_text: text,
    },
    usage: {
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: inTok + outTok,
      unit: 'tokens',
      quantity: inTok + outTok,
    },
    latency_ms: 25,
    raw: { sandbox: true, local: true },
  };
}

async function inferWithFallback(body) {
  try {
    return await callDenglishInfer(body);
  } catch (err) {
    if (config.denglishSandbox) {
      console.warn('[denglish] fallback sandbox:', err.message);
      return localSandboxInfer(body);
    }
    throw err;
  }
}

/**
 * Call denglish-api persistent-memory agent turn.
 * @param {{ userId: string, agentId: string, message: string, sessionId?: string, provider?: string, model?: string, endpointId?: string }} body
 */
async function callDenglishAgentTurn(body) {
  const base = (config.denglishApiUrl || '').replace(/\/$/, '');
  if (!base) {
    const err = new Error('DENGLISH_API_URL is not configured');
    err.code = 'DENGLISH_NOT_CONFIGURED';
    throw err;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (config.denglishServiceKey) headers['X-Service-Key'] = config.denglishServiceKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.denglishTimeoutMs);
  try {
    const res = await fetch(`${base}/v1/agent/turn`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: body.userId,
        agent_id: body.agentId,
        message: body.message,
        session_id: body.sessionId || undefined,
        provider: body.provider || 'runpod_serverless',
        model: body.model || undefined,
        endpoint_id: body.endpointId || undefined,
      }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.detail || json.message || `denglish-api HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function localSandboxAgentTurn(body) {
  const msg = String(body.message || '');
  const reply = `[sandbox agent+memory] ${msg.slice(0, 400)}`;
  const inTok = Math.max(1, Math.ceil(msg.length / 4));
  const outTok = Math.max(1, Math.ceil(reply.length / 4));
  return {
    ok: true,
    reply,
    session_id: body.sessionId || `sess_local_${Date.now()}`,
    usage: {
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: inTok + outTok,
      unit: 'tokens',
      quantity: inTok + outTok,
    },
    provider: body.provider || 'runpod_serverless',
    model: body.model || 'denglish-lora',
    latency_ms: 20,
    memory_applied: true,
    memory_recalled: 1,
    memory_written: 1,
    sandbox: true,
  };
}

async function agentTurnWithFallback(body) {
  try {
    return await callDenglishAgentTurn(body);
  } catch (err) {
    if (config.denglishSandbox) {
      console.warn('[denglish] agent turn fallback sandbox:', err.message);
      return localSandboxAgentTurn(body);
    }
    throw err;
  }
}

module.exports = {
  callDenglishInfer,
  localSandboxInfer,
  inferWithFallback,
  fetchModelCatalog,
  fetchModelSchema,
  quoteInference,
  callDenglishAgentTurn,
  localSandboxAgentTurn,
  agentTurnWithFallback,
};
