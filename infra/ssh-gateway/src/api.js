/** Client for the AI Markets API internal SSH gateway endpoints. */
class ApiClient {
  constructor({ apiBaseUrl, apiSecret, fetchImpl = globalThis.fetch }) {
    this.base = apiBaseUrl;
    this.secret = apiSecret;
    this.fetch = fetchImpl;
  }

  headers() {
    return { 'Content-Type': 'application/json', 'X-SSH-Gateway-Secret': this.secret };
  }

  /** Returns { sessionId, userId, agentId, expiresAt } or null. Fails closed. */
  async verify(username, password) {
    try {
      const res = await this.fetch(`${this.base}/ssh-gateway/auth`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status !== 200) return null;
      const body = await res.json();
      if (!body?.ok || !body.userId || !body.agentId || !body.expiresAt) return null;
      if (Date.parse(body.expiresAt) <= Date.now()) return null;
      return { sessionId: body.sessionId, userId: body.userId, agentId: body.agentId, expiresAt: body.expiresAt };
    } catch {
      return null;
    }
  }

  /** Active sessions; throws on failure so the reaper skips a round instead of wiping everything. */
  async active() {
    const res = await this.fetch(`${this.base}/ssh-gateway/active`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new Error(`active sessions: HTTP ${res.status}`);
    const body = await res.json();
    if (!body?.ok || !Array.isArray(body.sessions)) throw new Error('active sessions: bad body');
    return body.sessions;
  }
}

module.exports = { ApiClient };
