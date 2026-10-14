/** Validate that a URL points at a real, public, non-archived GitHub repository. */
const API = 'https://api.github.com';
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

let fetchImpl = (...args) => fetch(...args);
function _setFetch(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

class RepoError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 'https://github.com/owner/repo(.git)(/...)' | 'github.com/owner/repo' → { owner, repo } or null. */
function parseRepoUrl(input) {
  let s = String(input || '').trim();
  if (!s || s.length > 300) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const [owner, rawRepo] = u.pathname.split('/').filter(Boolean);
  const repo = String(rawRepo || '').replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner || '') || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

async function fetchPublicRepo({ owner, repo }, { token = process.env.GITHUB_TOKEN, timeoutMs = 10_000 } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'aimarkets-community-vote' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RepoError('github_unavailable', 'Could not reach GitHub. Try again later.', 502);
  }
  if (res.status === 404) throw new RepoError('repo_not_found', 'Repository not found or not public.');
  if (res.status === 403 || res.status === 429) throw new RepoError('github_rate_limited', 'GitHub rate limit reached. Try again later.', 503);
  if (!res.ok) throw new RepoError('github_unavailable', `GitHub error ${res.status}.`, 502);
  const r = await res.json();
  if (r.private || (r.visibility && r.visibility !== 'public')) throw new RepoError('repo_not_public', 'Repository is not public.');
  if (r.archived) throw new RepoError('repo_archived', 'Archived repositories cannot be submitted.');
  if (r.disabled) throw new RepoError('repo_disabled', 'Repository is disabled.');
  return {
    fullName: r.full_name,
    repoKey: String(r.full_name || `${owner}/${repo}`).toLowerCase(),
    githubId: r.id,
    name: r.name,
    description: String(r.description || '').slice(0, 500),
    stars: Number(r.stargazers_count) || 0,
    avatarUrl: r.owner?.avatar_url || '',
    htmlUrl: r.html_url || `https://github.com/${r.full_name}`,
    language: r.language || '',
    license: r.license?.spdx_id || '',
    fork: !!r.fork,
    pushedAt: r.pushed_at ? new Date(r.pushed_at) : null,
  };
}

module.exports = { parseRepoUrl, fetchPublicRepo, RepoError, _setFetch };
