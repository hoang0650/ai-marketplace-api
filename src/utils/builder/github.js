/**
 * Minimal GitHub REST client for AI App Builder "push to my GitHub".
 * Pushes are one commit built with the Git Data API (tree with inline contents → commit → ref),
 * parented on the branch head so commits made on GitHub are kept, never force-pushed.
 */
const { httpError } = require('./files');

const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

let fetchImpl = (...args) => fetch(...args);

/** Test hook. */
function _setFetch(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

function validOwner(value) {
  return OWNER_RE.test(String(value || ''));
}

function validRepoName(value) {
  const name = String(value || '');
  return REPO_RE.test(name) && name !== '.' && name !== '..' && !/\.git$/i.test(name);
}

/** "owner/repo" → { owner, repo } or null. */
function parseFullName(value) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(value || '').trim());
  if (!m || !validOwner(m[1]) || !validRepoName(m[2])) return null;
  return { owner: m[1], repo: m[2] };
}

/** Subset of `git check-ref-format` rules, enough to keep refs safe in URLs. */
function validBranch(value) {
  const b = String(value || '');
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(b)) return false;
  if (b.startsWith('/') || b.endsWith('/') || b.startsWith('-') || b.endsWith('.') || b.endsWith('.lock')) return false;
  if (b.includes('..') || b.includes('//') || b.includes('@{')) return false;
  return b.split('/').every((seg) => seg && !seg.startsWith('.'));
}

function validToken(value) {
  return TOKEN_RE.test(String(value || ''));
}

function refPath(branch) {
  return String(branch).split('/').map(encodeURIComponent).join('/');
}

function contentPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

async function errorFrom(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const message = String(body?.message || res.statusText || '').slice(0, 300);
  const details = Array.isArray(body?.errors)
    ? body.errors.map((e) => (typeof e === 'string' ? e : e?.message || e?.code || '')).filter(Boolean).join('; ')
    : '';
  const text = [message, details].filter(Boolean).join(' — ').slice(0, 400);
  // 400, not 401: clients treat 401 as "AI Markets session expired" and sign the user out.
  if (res.status === 401) return httpError(400, 'GIT_TOKEN_INVALID');
  if (res.status === 403 || res.status === 429) {
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)) {
      return httpError(429, 'GIT_RATE_LIMITED');
    }
    return httpError(403, 'GIT_FORBIDDEN');
  }
  if (res.status === 404) return httpError(404, 'GIT_NOT_FOUND');
  if (res.status === 409) {
    const err = httpError(409, 'GIT_CONFLICT');
    err.githubStatus = 409;
    err.message = text;
    return err;
  }
  if (res.status === 422) {
    if (/already exists/i.test(text)) return httpError(409, 'GIT_REPO_EXISTS');
    const err = httpError(422, 'GIT_UNPROCESSABLE');
    err.message = text;
    return err;
  }
  const err = httpError(502, 'GIT_ERROR');
  err.message = text || `HTTP ${res.status}`;
  return err;
}

async function request(token, method, path, body, { raw = false } = {}) {
  let res;
  try {
    res = await fetchImpl(path.startsWith('http') ? path : `${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aimarkets-builder',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const err = httpError(502, 'GIT_ERROR');
    err.message = cause?.name === 'TimeoutError' ? 'timeout' : 'network error';
    throw err;
  }
  if (!res.ok) throw await errorFrom(res);
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

async function getUser(token) {
  const res = await request(token, 'GET', '/user', undefined, { raw: true });
  const user = await res.json();
  return {
    login: String(user.login || ''),
    accountId: String(user.id || ''),
    avatarUrl: String(user.avatar_url || ''),
    scopes: String(res.headers.get('x-oauth-scopes') || ''),
  };
}

async function listRepos(token) {
  const rows = await request(
    token,
    'GET',
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'
  );
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.permissions?.push && !r.archived)
    .map((r) => ({
      fullName: r.full_name,
      owner: r.owner?.login || '',
      name: r.name,
      private: !!r.private,
      defaultBranch: r.default_branch || 'main',
      htmlUrl: r.html_url,
      pushedAt: r.pushed_at || null,
    }));
}

async function getRepo(token, owner, repo) {
  return request(token, 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

async function createRepo(token, { name, isPrivate = true, description = '' }) {
  if (!validRepoName(name)) throw httpError(400, 'GIT_REPO_INVALID');
  return request(token, 'POST', '/user/repos', {
    name,
    private: !!isPrivate,
    description: String(description || '').replace(/[\r\n\t]+/g, ' ').slice(0, 300),
    auto_init: true,
  });
}

async function getRef(token, base, branch) {
  try {
    const ref = await request(token, 'GET', `${base}/git/ref/heads/${refPath(branch)}`);
    return { sha: ref?.object?.sha || '', empty: false };
  } catch (err) {
    if (err.code === 'GIT_NOT_FOUND') return { sha: '', empty: false };
    if (err.githubStatus === 409) return { sha: '', empty: true };
    throw err;
  }
}

/** Empty repositories reject the Git Data API, so the first commit goes through the contents API. */
async function bootstrapEmpty(token, base, branch, file, message) {
  const out = await request(token, 'PUT', `${base}/contents/${contentPath(file.path)}`, {
    message,
    content: Buffer.from(file.content, 'utf8').toString('base64'),
    branch,
  });
  return out?.commit?.sha || '';
}

async function existingPaths(token, base, treeSha) {
  const tree = await request(token, 'GET', `${base}/git/trees/${treeSha}?recursive=1`);
  if (tree?.truncated) return null;
  return new Set((tree?.tree || []).filter((e) => e.type === 'blob').map((e) => e.path));
}

/**
 * Writes `files` (and removes `deletes`) on `branch` as a single commit.
 * Creates the branch from the default branch when missing.
 * @returns {{ sha: string, commitUrl: string, branch: string, unchanged: boolean }}
 */
async function pushFiles(token, { owner, repo, branch, files, deletes = [], message, htmlUrl }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repoUrl = htmlUrl || `https://github.com/${owner}/${repo}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let head = await getRef(token, base, branch);
    let branchExists = !!head.sha;
    let seeded = false;
    if (head.empty) {
      const seed = files.find((f) => f.path === 'README.md') || files[0];
      head = { sha: await bootstrapEmpty(token, base, branch, seed, message), empty: false };
      branchExists = true;
      seeded = true;
    } else if (!branchExists) {
      const info = await getRepo(token, owner, repo);
      const fromDefault = await getRef(token, base, info.default_branch || 'main');
      if (!fromDefault.sha) throw httpError(404, 'GIT_NOT_FOUND');
      head = fromDefault;
    }

    const parent = await request(token, 'GET', `${base}/git/commits/${head.sha}`);
    const baseTree = parent?.tree?.sha;
    const present = deletes.length ? await existingPaths(token, base, baseTree) : null;
    const entries = [
      ...files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      ...(present ? deletes.filter((p) => present.has(p)).map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })) : []),
    ];
    const tree = await request(token, 'POST', `${base}/git/trees`, { base_tree: baseTree, tree: entries });

    if (tree.sha === baseTree && branchExists) {
      return { sha: head.sha, commitUrl: `${repoUrl}/commit/${head.sha}`, branch, unchanged: !seeded };
    }

    const commit = await request(token, 'POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [head.sha] });
    try {
      if (branchExists) {
        await request(token, 'PATCH', `${base}/git/refs/heads/${refPath(branch)}`, { sha: commit.sha, force: false });
      } else {
        await request(token, 'POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
      }
    } catch (err) {
      // Branch moved between read and write (not a fast-forward): rebuild on the new head once.
      if (attempt === 0 && (err.code === 'GIT_UNPROCESSABLE' || err.code === 'GIT_CONFLICT')) continue;
      if (err.code === 'GIT_UNPROCESSABLE') throw httpError(409, 'GIT_CONFLICT');
      throw err;
    }
    return { sha: commit.sha, commitUrl: `${repoUrl}/commit/${commit.sha}`, branch, unchanged: false };
  }
  throw httpError(409, 'GIT_CONFLICT');
}

const BLOB_CONCURRENCY = 6;

/**
 * Reads files of `owner/repo` at `ref` (only under `dir` when given) for template imports.
 * `classify(path, size)` returns '' to download the file, 'junk' to drop it silently,
 * or a skip reason reported back to the seller. Paths are relative to `dir`.
 * @returns {{ sha: string, message: string, entries: Array<{ path: string, data: Buffer }>, skipped: Array<{ path: string, reason: string }> }}
 */
async function fetchRepoFiles(token, { owner, repo, ref, dir = '', classify, maxFiles }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const commit = await request(token, 'GET', `${base}/commits/${refPath(ref)}`);
  const sha = commit?.sha || '';
  const message = String(commit?.commit?.message || '').split('\n')[0].slice(0, 200);
  const treeSha = commit?.commit?.tree?.sha || '';
  if (!sha || !treeSha) throw httpError(404, 'GIT_NOT_FOUND');
  const tree = await request(token, 'GET', `${base}/git/trees/${treeSha}?recursive=1`);
  if (tree?.truncated) throw httpError(400, 'GIT_IMPORT_TOO_LARGE');

  const prefix = dir ? `${dir}/` : '';
  const picked = [];
  const skipped = [];
  let inDir = 0;
  for (const e of tree?.tree || []) {
    if (e?.type !== 'blob' || typeof e.path !== 'string' || !e.path.startsWith(prefix)) continue;
    inDir += 1;
    const path = e.path.slice(prefix.length);
    const verdict = classify(path, Number(e.size) || 0);
    if (verdict === 'junk') continue;
    if (verdict) skipped.push({ path: path.slice(0, 160), reason: verdict });
    else picked.push({ path, sha: e.sha });
  }
  if (prefix && !inDir) throw httpError(404, 'GIT_PATH_NOT_FOUND');
  if (maxFiles && picked.length > maxFiles) throw httpError(400, 'PROJECT_TOO_MANY_FILES', { max: maxFiles });

  const entries = new Array(picked.length);
  let next = 0;
  const worker = async () => {
    while (next < picked.length) {
      const i = next++;
      const blob = await request(token, 'GET', `${base}/git/blobs/${picked[i].sha}`);
      const encoding = blob?.encoding === 'base64' ? 'base64' : 'utf8';
      entries[i] = { path: picked[i].path, data: Buffer.from(String(blob?.content || ''), encoding) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, picked.length) }, worker));
  return { sha, message, entries, skipped };
}

// ---------- OAuth app ----------

function oauthConfig() {
  const clientId = String(process.env.GITHUB_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GITHUB_CLIENT_SECRET || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function authorizeUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: 'repo', state, allow_signup: 'true' });
  return `https://github.com/login/oauth/authorize?${q}`;
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  let res;
  try {
    res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'aimarkets-builder' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'GIT_ERROR');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw httpError(400, 'GIT_OAUTH_STATE');
  return { token: String(body.access_token), scopes: String(body.scope || '') };
}

/** Best effort: removes our OAuth grant so a disconnected token stops working on GitHub too. */
async function revokeOAuthToken({ clientId, clientSecret, token }) {
  try {
    await fetchImpl(`${API}/applications/${encodeURIComponent(clientId)}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'aimarkets-builder',
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // ignore
  }
}

module.exports = {
  validOwner,
  validRepoName,
  validBranch,
  validToken,
  parseFullName,
  getUser,
  listRepos,
  getRepo,
  createRepo,
  pushFiles,
  fetchRepoFiles,
  oauthConfig,
  authorizeUrl,
  exchangeCode,
  revokeOAuthToken,
  _setFetch,
};
