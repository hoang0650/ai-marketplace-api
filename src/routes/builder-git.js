const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const config = require('../config/env');
const BuilderProject = require('../models/BuilderProject');
const GitConnection = require('../models/GitConnection');
const GitOAuthPending = require('../models/GitOAuthPending');
const { authenticate } = require('../middleware/auth');
const { sealSecret, openSecret } = require('../utils/secret-box');
const { apiBase } = require('../utils/training/bundle');
const files = require('../utils/builder/files');
const gh = require('../utils/builder/github');
const { exportFiles, slugify } = require('../utils/builder/export');
const { publicProject, errorBody } = require('./builder');

/**
 * AI App Builder → buyer's own GitHub. Buyers link GitHub (OAuth app or a personal access token),
 * then push a project as one commit to a new or existing repository; later pushes add commits.
 * Mounted at /v1/builder/git before /v1/builder (the OAuth callback carries no bearer token).
 */
const router = express.Router();

const STATE_TTL = '10m';
const PENDING_TTL_MS = 10 * 60 * 1000;
const MESSAGE_MAX = 200;
const pushing = new Set();

function httpError(status, code, extra) {
  return files.httpError(status, code, extra);
}

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (!err || !err.status || !err.code) return next(err);
      return res.status(err.status).json(errorBody(err));
    }
  };
}

/** Separate key so an OAuth `state` can never be replayed as an API access token. */
function stateKey() {
  return crypto.createHash('sha256').update(`builder-git-oauth:${config.jwtSecret}`).digest();
}

function redirectUri() {
  return String(process.env.GITHUB_OAUTH_REDIRECT_URI || '').trim() || `${apiBase()}/v1/builder/git/github/callback`;
}

/** Only our web origins and the mobile app scheme may receive the connect id. */
function allowedReturn(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'aimarkets:') return url;
  if (url.protocol === 'exp:' && !config.isProduction) return url;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const origins = new Set(
    [...config.corsOrigins, config.frontendUrl]
      .filter((o) => o && o !== '*')
      .map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
  );
  return origins.has(url.origin) ? url : null;
}

function withParams(url, params) {
  const out = new URL(url.toString());
  for (const [k, v] of Object.entries(params)) out.searchParams.set(k, v);
  return out.toString();
}

function fallbackReturn() {
  return new URL(`${config.frontendUrl.replace(/\/+$/, '')}/build`);
}

async function findOwned(req) {
  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) throw httpError(404, 'PROJECT_NOT_FOUND');
  const doc = await BuilderProject.findOne({ _id: id, owner: req.user._id });
  if (!doc) throw httpError(404, 'PROJECT_NOT_FOUND');
  return doc;
}

async function useConnection(userId) {
  const conn = await GitConnection.findOne({ user: userId, provider: 'github' }).select('+secret');
  if (!conn || conn.status !== 'active') throw httpError(400, 'GIT_NOT_CONNECTED');
  let token;
  try {
    token = openSecret(conn.secret);
  } catch {
    throw httpError(400, 'GIT_NOT_CONNECTED');
  }
  return { conn, token };
}

/** Marks the link broken when GitHub rejects the token so the UI asks to reconnect. */
async function guard(conn, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === 'GIT_TOKEN_INVALID') {
      await GitConnection.updateOne({ _id: conn._id }, { $set: { status: 'invalid' } }).catch(() => {});
    }
    throw err;
  }
}

async function saveConnection(userId, data) {
  const conn = await GitConnection.findOneAndUpdate(
    { user: userId, provider: 'github' },
    {
      $set: {
        method: data.method,
        secret: data.secret,
        login: data.login,
        accountId: data.accountId,
        avatarUrl: data.avatarUrl,
        scopes: data.scopes,
        status: 'active',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return conn.toPublic();
}

function hasBuild(doc) {
  return (doc.files || []).length > 0 && (doc.version > 0 || !!doc.lastGeneratedAt || !!doc.template?.product);
}

function cleanMessage(value, doc) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (text.length > MESSAGE_MAX) throw httpError(400, 'GIT_MESSAGE_INVALID');
  return text || `Update from AI Markets Builder (v${doc.version || 0})`;
}

function repoTarget(r, created = false) {
  return {
    owner: r.owner?.login || '',
    repo: r.name,
    private: !!r.private,
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch || 'main',
    created,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- OAuth callback (public; GitHub redirects the browser here) ----------

router.get('/github/callback', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  let state;
  try {
    state = jwt.verify(String(req.query.state || ''), stateKey(), { audience: 'builder-git-oauth' });
  } catch {
    return res.redirect(302, withParams(fallbackReturn(), { git_error: 'GIT_OAUTH_STATE' }));
  }
  const back = allowedReturn(state.rt) || fallbackReturn();
  if (req.query.error) return res.redirect(302, withParams(back, { git_error: 'GIT_OAUTH_DENIED' }));
  const oauth = gh.oauthConfig();
  if (!oauth || !mongoose.isValidObjectId(state.uid)) {
    return res.redirect(302, withParams(back, { git_error: 'GIT_OAUTH_STATE' }));
  }
  try {
    const { token, scopes } = await gh.exchangeCode({ ...oauth, code: String(req.query.code || ''), redirectUri: redirectUri() });
    const user = await gh.getUser(token);
    const connectId = crypto.randomBytes(24).toString('base64url');
    await GitOAuthPending.create({
      connectId,
      user: state.uid,
      provider: 'github',
      secret: sealSecret(token),
      login: user.login,
      accountId: user.accountId,
      avatarUrl: user.avatarUrl,
      scopes: user.scopes || scopes,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });
    return res.redirect(302, withParams(back, { git_connect: connectId }));
  } catch (err) {
    if (!err?.code) console.error('[builder-git] oauth callback failed', err);
    return res.redirect(302, withParams(back, { git_error: err?.code || 'GIT_ERROR' }));
  }
});

router.use(authenticate);

// ---------- connection ----------

/** GET /v1/builder/git — supported hosts + the buyer's linked account. */
router.get(
  '/',
  wrap(async (req, res) => {
    const conns = await GitConnection.find({ user: req.user._id });
    res.json({
      providers: [{ id: 'github', label: 'GitHub', oauth: !!gh.oauthConfig() }],
      connections: conns.map((c) => c.toPublic()),
    });
  })
);

/** POST /v1/builder/git/github/oauth/start — body { returnTo } → { url } to open in the browser. */
router.post(
  '/github/oauth/start',
  wrap(async (req, res) => {
    const oauth = gh.oauthConfig();
    if (!oauth) throw httpError(400, 'GIT_NOT_CONFIGURED');
    const back = allowedReturn(req.body?.returnTo);
    if (!back) throw httpError(400, 'GIT_RETURN_INVALID');
    const state = jwt.sign({ uid: String(req.user._id), rt: back.toString(), n: crypto.randomBytes(8).toString('hex') }, stateKey(), {
      audience: 'builder-git-oauth',
      expiresIn: STATE_TTL,
    });
    res.json({ url: gh.authorizeUrl({ clientId: oauth.clientId, redirectUri: redirectUri(), state }) });
  })
);

/** POST /v1/builder/git/github/oauth/complete — body { connectId } from the callback redirect. */
router.post(
  '/github/oauth/complete',
  wrap(async (req, res) => {
    const connectId = String(req.body?.connectId || '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(connectId)) throw httpError(400, 'GIT_CONNECT_EXPIRED');
    const pending = await GitOAuthPending.findOneAndDelete({
      connectId,
      user: req.user._id,
      expiresAt: { $gt: new Date() },
    }).select('+secret');
    if (!pending) throw httpError(400, 'GIT_CONNECT_EXPIRED');
    const connection = await saveConnection(req.user._id, {
      method: 'oauth',
      secret: pending.secret,
      login: pending.login,
      accountId: pending.accountId,
      avatarUrl: pending.avatarUrl,
      scopes: pending.scopes,
    });
    res.json({ connection });
  })
);

/** POST /v1/builder/git/github/token — body { token } (personal access token). */
router.post(
  '/github/token',
  wrap(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!gh.validToken(token)) throw httpError(400, 'GIT_TOKEN_FORMAT');
    const user = await gh.getUser(token);
    const connection = await saveConnection(req.user._id, {
      method: 'token',
      secret: sealSecret(token),
      login: user.login,
      accountId: user.accountId,
      avatarUrl: user.avatarUrl,
      scopes: user.scopes,
    });
    res.json({ connection });
  })
);

/** DELETE /v1/builder/git/github — unlink (and revoke our OAuth grant). Project links are kept. */
router.delete(
  '/github',
  wrap(async (req, res) => {
    const conn = await GitConnection.findOne({ user: req.user._id, provider: 'github' }).select('+secret');
    if (conn) {
      const oauth = gh.oauthConfig();
      if (conn.method === 'oauth' && oauth) {
        try {
          await gh.revokeOAuthToken({ ...oauth, token: openSecret(conn.secret) });
        } catch {
          // stored secret unreadable — nothing to revoke
        }
      }
      await conn.deleteOne();
    }
    res.json({ success: true });
  })
);

/** GET /v1/builder/git/github/repos — repositories the linked account can push to. */
router.get(
  '/github/repos',
  wrap(async (req, res) => {
    const { conn, token } = await useConnection(req.user._id);
    const repos = await guard(conn, () => gh.listRepos(token));
    res.json({ repos });
  })
);

// ---------- push ----------

/**
 * POST /v1/builder/git/projects/:id/push
 * body { create?: { name?, private? } | repo?: "owner/name", branch?, message? }
 * Without create/repo the project's linked repository is used.
 */
router.post(
  '/projects/:id/push',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    if (!hasBuild(doc)) throw httpError(400, 'GIT_NOTHING_TO_PUSH');
    const key = String(doc._id);
    if (pushing.has(key)) throw httpError(409, 'GIT_BUSY');
    pushing.add(key);
    try {
      const { conn, token } = await useConnection(req.user._id);
      const body = req.body || {};
      const message = cleanMessage(body.message, doc);
      if (body.branch !== undefined && body.branch !== '' && !gh.validBranch(String(body.branch))) {
        throw httpError(400, 'GIT_BRANCH_INVALID');
      }

      const target = await guard(conn, async () => {
        if (body.create) {
          const name = String(body.create.name || '').trim() || slugify(doc.name, 'aimarkets-project');
          if (!gh.validRepoName(name)) throw httpError(400, 'GIT_REPO_INVALID');
          const created = await gh.createRepo(token, {
            name,
            isPrivate: body.create.private !== false,
            description: `${doc.name} — built with AI Markets App Builder`,
          });
          return repoTarget(created, true);
        }
        let ref = null;
        if (body.repo) {
          ref = gh.parseFullName(body.repo);
          if (!ref) throw httpError(400, 'GIT_REPO_INVALID');
        } else if (doc.git?.repo) {
          ref = { owner: doc.git.owner, repo: doc.git.repo };
        } else {
          throw httpError(400, 'GIT_REPO_REQUIRED');
        }
        const info = await gh.getRepo(token, ref.owner, ref.repo);
        if (!info?.permissions?.push) throw httpError(403, 'GIT_REPO_NO_PUSH');
        if (info.archived) throw httpError(403, 'GIT_REPO_NO_PUSH');
        return repoTarget(info);
      });

      const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
      const sameRepo = !!doc.git?.repo && same(doc.git.owner, target.owner) && same(doc.git.repo, target.repo);
      const branch = String(body.branch || '') || (sameRepo && doc.git.branch) || target.defaultBranch;
      if (!gh.validBranch(branch)) throw httpError(400, 'GIT_BRANCH_INVALID');

      const out = exportFiles(doc);
      const paths = new Set(out.map((f) => f.path));
      const deletes = sameRepo && doc.git.branch === branch ? (doc.git.pushedPaths || []).filter((p) => !paths.has(p)) : [];
      const args = { owner: target.owner, repo: target.repo, branch, files: out, deletes, message, htmlUrl: target.htmlUrl };

      const result = await guard(conn, async () => {
        try {
          return await gh.pushFiles(token, args);
        } catch (err) {
          // A just-created repository can take a moment before its first branch is readable.
          if (!target.created || err.code !== 'GIT_NOT_FOUND') throw err;
          await sleep(1500);
          return gh.pushFiles(token, args);
        }
      });

      await BuilderProject.updateOne(
        { _id: doc._id },
        {
          $set: {
            git: {
              provider: 'github',
              owner: target.owner,
              repo: target.repo,
              branch,
              repoUrl: target.htmlUrl,
              private: target.private,
              lastCommitSha: result.sha,
              lastCommitUrl: result.commitUrl,
              lastPushedAt: new Date(),
              lastPushedVersion: doc.version || 0,
              pushedPaths: [...paths],
            },
          },
        }
      );
      GitConnection.updateOne({ _id: conn._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
      const fresh = await BuilderProject.findById(doc._id).select('-messages -files');
      res.json({
        git: publicProject(fresh).git,
        commit: { sha: result.sha, url: result.commitUrl, unchanged: result.unchanged },
        repo: { fullName: `${target.owner}/${target.repo}`, url: target.htmlUrl, private: target.private, created: target.created },
      });
    } finally {
      pushing.delete(key);
    }
  })
);

/** DELETE /v1/builder/git/projects/:id/link — forget the linked repository (the repo itself is untouched). */
router.delete(
  '/projects/:id/link',
  wrap(async (req, res) => {
    const doc = await findOwned(req);
    await BuilderProject.updateOne({ _id: doc._id }, { $unset: { git: 1 } });
    res.json({ git: null });
  })
);

module.exports = router;
module.exports.allowedReturn = allowedReturn;
module.exports.hasBuild = hasBuild;
module.exports.stateKey = stateKey;
module.exports.useConnection = useConnection;
module.exports.guard = guard;
