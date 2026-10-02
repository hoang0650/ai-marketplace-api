const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const config = require('../../src/config/env');
const gh = require('../../src/utils/builder/github');
const { exportFiles, slugify } = require('../../src/utils/builder/export');
const gitRoutes = require('../../src/routes/builder-git');

function reply(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Fake GitHub: routes `METHOD path` to handlers and records every call. */
function fakeGithub(routes) {
  const calls = [];
  gh._setFetch(async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace('https://api.github.com', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    for (const [key, handler] of Object.entries(routes)) {
      const [m, p] = key.split(' ');
      if (m === method && p === path) return typeof handler === 'function' ? handler(body, calls) : handler;
    }
    return reply(404, { message: 'Not Found' });
  });
  return calls;
}

test.afterEach(() => gh._setFetch(null));

test('validators: repo names, branches, tokens, owner/repo', () => {
  assert.ok(gh.validRepoName('my-shop.v2_x'));
  assert.ok(!gh.validRepoName('..'));
  assert.ok(!gh.validRepoName('a b'));
  assert.ok(!gh.validRepoName('repo.git'));
  assert.ok(gh.validBranch('main'));
  assert.ok(gh.validBranch('feature/ai-builder'));
  for (const bad of ['', '-x', 'a..b', 'a//b', '/a', 'a/', 'x.lock', 'a@{b', '.hidden', 'a/.b', 'a b']) {
    assert.ok(!gh.validBranch(bad), bad);
  }
  assert.ok(gh.validToken('ghp_' + 'a'.repeat(36)));
  assert.ok(gh.validToken('github_pat_' + 'A1_'.repeat(20)));
  assert.ok(!gh.validToken('short'));
  assert.ok(!gh.validToken('ghp_abc def' + 'x'.repeat(30)));
  assert.deepEqual(gh.parseFullName('nova/shop'), { owner: 'nova', repo: 'shop' });
  assert.equal(gh.parseFullName('nova/shop/extra'), null);
  assert.equal(gh.parseFullName('-bad/shop'), null);
});

test('exportFiles: app gets the Expo scaffold, project files win', () => {
  const out = exportFiles({
    kind: 'app',
    name: 'Cửa hàng Đẹp',
    files: [
      { path: 'App.tsx', content: 'export default 1' },
      { path: 'README.md', content: '# mine' },
    ],
  });
  const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));
  assert.equal(byPath['README.md'], '# mine');
  assert.equal(JSON.parse(byPath['package.json']).name, 'cua-hang-dep');
  assert.equal(JSON.parse(byPath['app.json']).expo.name, 'Cửa hàng Đẹp');
  assert.match(byPath['.gitignore'], /node_modules/);
  assert.equal(slugify('!!!', 'fallback'), 'fallback');

  const web = exportFiles({ kind: 'web', name: 'Site', files: [{ path: 'index.html', content: '<p>x</p>' }] });
  assert.deepEqual(web.map((f) => f.path).sort(), ['.gitignore', 'README.md', 'index.html']);
});

test('OAuth return address: only our web origins and the app scheme', () => {
  assert.ok(gitRoutes.allowedReturn('https://aimarkets.vn/build/abc'));
  assert.ok(gitRoutes.allowedReturn('http://localhost:4200/build/abc?x=1'));
  assert.ok(gitRoutes.allowedReturn('aimarkets://builder/abc'));
  assert.equal(gitRoutes.allowedReturn('https://evil.example/build'), null);
  assert.equal(gitRoutes.allowedReturn('https://aimarkets.vn.evil.example/'), null);
  assert.equal(gitRoutes.allowedReturn('https://user:pw@aimarkets.vn/'), null);
  assert.equal(gitRoutes.allowedReturn('javascript:alert(1)'), null);
  assert.equal(gitRoutes.allowedReturn('not a url'), null);
});

test('OAuth state is not accepted as an API access token', () => {
  const state = jwt.sign({ uid: '507f1f77bcf86cd799439011', rt: 'https://aimarkets.vn/build' }, gitRoutes.stateKey(), {
    audience: 'builder-git-oauth',
    expiresIn: '10m',
  });
  assert.throws(() => jwt.verify(state, config.jwtSecret));
  assert.equal(jwt.verify(state, gitRoutes.stateKey(), { audience: 'builder-git-oauth' }).uid, '507f1f77bcf86cd799439011');
});

test('hasBuild: needs files and a build, a template copy or edits', () => {
  assert.equal(gitRoutes.hasBuild({ files: [{ path: 'index.html' }], version: 0 }), false);
  assert.equal(gitRoutes.hasBuild({ files: [{ path: 'index.html' }], version: 2 }), true);
  assert.equal(gitRoutes.hasBuild({ files: [{ path: 'index.html' }], version: 0, template: { product: 'x' } }), true);
  assert.equal(gitRoutes.hasBuild({ files: [], version: 3 }), false);
});

test('pushFiles: one commit on the branch head, stale files deleted only if present', async () => {
  const calls = fakeGithub({
    'GET /repos/nova/shop/git/ref/heads/main': reply(200, { object: { sha: 'head1' } }),
    'GET /repos/nova/shop/git/commits/head1': reply(200, { tree: { sha: 'tree1' } }),
    'GET /repos/nova/shop/git/trees/tree1?recursive=1': reply(200, {
      truncated: false,
      tree: [
        { path: 'old.html', type: 'blob' },
        { path: 'index.html', type: 'blob' },
      ],
    }),
    'POST /repos/nova/shop/git/trees': reply(201, { sha: 'tree2' }),
    'POST /repos/nova/shop/git/commits': reply(201, { sha: 'commit2' }),
    'PATCH /repos/nova/shop/git/refs/heads/main': reply(200, { object: { sha: 'commit2' } }),
  });
  const out = await gh.pushFiles('tok', {
    owner: 'nova',
    repo: 'shop',
    branch: 'main',
    files: [{ path: 'index.html', content: '<h1>v2</h1>' }],
    deletes: ['old.html', 'gone-already.css'],
    message: 'Update',
  });
  assert.deepEqual(out, { sha: 'commit2', commitUrl: 'https://github.com/nova/shop/commit/commit2', branch: 'main', unchanged: false });
  const tree = calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/trees')).body;
  assert.equal(tree.base_tree, 'tree1');
  assert.deepEqual(tree.tree, [
    { path: 'index.html', mode: '100644', type: 'blob', content: '<h1>v2</h1>' },
    { path: 'old.html', mode: '100644', type: 'blob', sha: null },
  ]);
  const commit = calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/commits')).body;
  assert.deepEqual(commit.parents, ['head1']);
  assert.equal(calls.find((c) => c.method === 'PATCH').body.force, false);
});

test('pushFiles: empty repository is seeded through the contents API', async () => {
  const calls = fakeGithub({
    'GET /repos/nova/new/git/ref/heads/main': reply(409, { message: 'Git Repository is empty.' }),
    'PUT /repos/nova/new/contents/README.md': reply(201, { commit: { sha: 'seed' } }),
    'GET /repos/nova/new/git/commits/seed': reply(200, { tree: { sha: 'tseed' } }),
    'POST /repos/nova/new/git/trees': reply(201, { sha: 'tfull' }),
    'POST /repos/nova/new/git/commits': reply(201, { sha: 'c1' }),
    'PATCH /repos/nova/new/git/refs/heads/main': reply(200, {}),
  });
  const out = await gh.pushFiles('tok', {
    owner: 'nova',
    repo: 'new',
    branch: 'main',
    files: [
      { path: 'index.html', content: 'x' },
      { path: 'README.md', content: '# Site' },
    ],
    message: 'Initial',
  });
  assert.equal(out.sha, 'c1');
  const seed = calls.find((c) => c.method === 'PUT').body;
  assert.equal(Buffer.from(seed.content, 'base64').toString('utf8'), '# Site');
  assert.equal(seed.branch, 'main');
});

test('pushFiles: missing branch is created from the default branch', async () => {
  const calls = fakeGithub({
    'GET /repos/nova/shop/git/ref/heads/ai/v2': reply(404, { message: 'Not Found' }),
    'GET /repos/nova/shop': reply(200, { default_branch: 'main' }),
    'GET /repos/nova/shop/git/ref/heads/main': reply(200, { object: { sha: 'm1' } }),
    'GET /repos/nova/shop/git/commits/m1': reply(200, { tree: { sha: 't1' } }),
    'POST /repos/nova/shop/git/trees': reply(201, { sha: 't2' }),
    'POST /repos/nova/shop/git/commits': reply(201, { sha: 'c2' }),
    'POST /repos/nova/shop/git/refs': reply(201, {}),
  });
  const out = await gh.pushFiles('tok', { owner: 'nova', repo: 'shop', branch: 'ai/v2', files: [{ path: 'a.js', content: '1' }], message: 'm' });
  assert.equal(out.sha, 'c2');
  assert.deepEqual(calls.find((c) => c.path.endsWith('/git/refs')).body, { ref: 'refs/heads/ai/v2', sha: 'c2' });
});

test('pushFiles: identical tree is reported as unchanged without a commit', async () => {
  const calls = fakeGithub({
    'GET /repos/nova/shop/git/ref/heads/main': reply(200, { object: { sha: 'h' } }),
    'GET /repos/nova/shop/git/commits/h': reply(200, { tree: { sha: 'same' } }),
    'POST /repos/nova/shop/git/trees': reply(201, { sha: 'same' }),
  });
  const out = await gh.pushFiles('tok', { owner: 'nova', repo: 'shop', branch: 'main', files: [{ path: 'a.js', content: '1' }], message: 'm' });
  assert.equal(out.unchanged, true);
  assert.equal(out.sha, 'h');
  assert.ok(!calls.some((c) => c.path.endsWith('/git/commits') && c.method === 'POST'));
});

test('pushFiles: rebuilds once when the branch moved during the push', async () => {
  let heads = 0;
  let patches = 0;
  fakeGithub({
    'GET /repos/nova/shop/git/ref/heads/main': () => reply(200, { object: { sha: heads++ ? 'h2' : 'h1' } }),
    'GET /repos/nova/shop/git/commits/h1': reply(200, { tree: { sha: 't1' } }),
    'GET /repos/nova/shop/git/commits/h2': reply(200, { tree: { sha: 't2' } }),
    'POST /repos/nova/shop/git/trees': () => reply(201, { sha: 'tn' }),
    'POST /repos/nova/shop/git/commits': (body) => reply(201, { sha: `c-${body.parents[0]}` }),
    'PATCH /repos/nova/shop/git/refs/heads/main': () =>
      patches++ ? reply(200, {}) : reply(422, { message: 'Update is not a fast forward' }),
  });
  const out = await gh.pushFiles('tok', { owner: 'nova', repo: 'shop', branch: 'main', files: [{ path: 'a.js', content: '1' }], message: 'm' });
  assert.equal(out.sha, 'c-h2');
});

test('GitHub errors map to builder codes (token error is 400, not 401)', async () => {
  fakeGithub({ 'GET /user': reply(401, { message: 'Bad credentials' }) });
  await assert.rejects(gh.getUser('tok'), (err) => err.code === 'GIT_TOKEN_INVALID' && err.status === 400);

  fakeGithub({ 'GET /user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member': reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }) });
  await assert.rejects(gh.listRepos('tok'), (err) => err.code === 'GIT_RATE_LIMITED');

  fakeGithub({ 'POST /user/repos': reply(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }) });
  await assert.rejects(gh.createRepo('tok', { name: 'shop' }), (err) => err.code === 'GIT_REPO_EXISTS');

  fakeGithub({});
  await assert.rejects(gh.createRepo('tok', { name: 'bad name' }), (err) => err.code === 'GIT_REPO_INVALID');
});

test('getUser reads login and classic token scopes', async () => {
  fakeGithub({ 'GET /user': reply(200, { login: 'nova', id: 7, avatar_url: 'https://a/x.png' }, { 'x-oauth-scopes': 'repo, read:user' }) });
  assert.deepEqual(await gh.getUser('tok'), { login: 'nova', accountId: '7', avatarUrl: 'https://a/x.png', scopes: 'repo, read:user' });
});

test('listRepos keeps only pushable, non-archived repositories', async () => {
  fakeGithub({
    'GET /user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member': reply(200, [
      { full_name: 'nova/a', name: 'a', owner: { login: 'nova' }, private: true, default_branch: 'main', html_url: 'u', permissions: { push: true } },
      { full_name: 'org/b', name: 'b', owner: { login: 'org' }, permissions: { push: false } },
      { full_name: 'nova/c', name: 'c', owner: { login: 'nova' }, archived: true, permissions: { push: true } },
    ]),
  });
  const repos = await gh.listRepos('tok');
  assert.deepEqual(repos.map((r) => r.fullName), ['nova/a']);
});
