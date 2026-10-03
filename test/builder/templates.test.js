const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const mongoose = require('mongoose');

const { readZip, isZip } = require('../../src/utils/builder/zip');
const tpl = require('../../src/utils/builder/templates');
const { previewResponse } = require('../../src/utils/builder/preview');
const { templateMeta } = require('../../src/routes/builder-templates');
const { publicProject } = require('../../src/routes/builder');
const { taxCategoryFromProduct } = require('../../src/finance/tax-category');
const { WEB_CASE, APP_CASE } = require('../../src/scripts/builder-demo-cases');
const { parseOutput } = require('../../src/utils/builder/files');

/** Tiny ZIP writer for fixtures (stored or deflate entries). */
function makeZip(entries, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '', 'utf8');
    const isDir = e.path.endsWith('/');
    const body = deflate && !isDir ? zlib.deflateRawSync(raw) : raw;
    const method = deflate && !isDir ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function product(over = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    creator: new mongoose.Types.ObjectId(),
    category: 'template-web',
    pricing: { model: 'one-time', price: 29 },
    moderationStatus: 'active',
    published: true,
    ...over,
  };
}

const webFiles = parseOutput(WEB_CASE.turns[0].reply).files;
const appFiles = parseOutput(APP_CASE.turns[1].reply).files.concat(parseOutput(APP_CASE.turns[0].reply).files.filter((f) => f.path !== 'components/RoomCard.tsx'));

describe('template zip upload', () => {
  test('a zipped site with a wrapper folder becomes clean template files', () => {
    const zip = makeZip([
      { path: 'ph-hotel/' },
      ...webFiles.map((f) => ({ path: `ph-hotel/${f.path}`, data: f.content })),
      { path: 'ph-hotel/.DS_Store', data: 'x' },
      { path: '__MACOSX/ph-hotel/._index.html', data: 'x' },
      { path: 'ph-hotel/node_modules/lib/index.js', data: 'x' },
      { path: 'ph-hotel/img/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]) },
    ]);
    assert.equal(isZip(zip), true);
    const entries = readZip(zip);
    const out = tpl.normalizeUpload('web', entries);
    assert.equal(out.files[0].path, 'index.html');
    assert.deepEqual(out.files.map((f) => f.path).sort(), ['index.html', 'js/app.js', 'js/rooms.js', 'styles.css']);
    assert.equal(out.files.find((f) => f.path === 'js/rooms.js').content, webFiles.find((f) => f.path === 'js/rooms.js').content);
    assert.deepEqual(out.skipped, [{ path: 'ph-hotel/img/logo.png', reason: 'type' }]);
  });

  test('stored (uncompressed) entries are read too', () => {
    const entries = readZip(makeZip([{ path: 'App.tsx', data: 'export default function App(){return null}' }], { deflate: false }));
    assert.equal(entries[0].data.toString(), 'export default function App(){return null}');
  });

  test('broken, oversized and non-zip buffers are rejected with codes', () => {
    assert.throws(() => readZip(Buffer.from('not a zip')), { code: 'ZIP_INVALID' });
    const big = makeZip([{ path: 'a.js', data: 'x'.repeat(5000) }]);
    assert.throws(() => readZip(big, { maxTotalBytes: 1000 }), { code: 'ZIP_TOO_LARGE' });
    assert.throws(() => readZip(makeZip([{ path: 'a.js' }, { path: 'b.js' }]), { maxEntries: 1 }), { code: 'ZIP_TOO_MANY_FILES' });
  });

  test('templates need their entry file and text sources', () => {
    assert.throws(() => tpl.normalizeUpload('web', [{ path: 'styles.css', data: 'a{}' }]), { code: 'TEMPLATE_ENTRY_MISSING' });
    assert.throws(() => tpl.normalizeUpload('app', [{ path: 'logo.png', data: Buffer.from([1, 0, 2]) }]), { code: 'TEMPLATE_EMPTY' });
    const out = tpl.normalizeUpload('app', [
      { path: 'my-app/App.tsx', data: '\uFEFFexport default function App(){return null}' },
      { path: 'my-app/data/bin.json', data: Buffer.from([0x7b, 0, 0x7d]) },
    ]);
    assert.equal(out.files[0].content.startsWith('export'), true);
    assert.deepEqual(out.skipped, [{ path: 'data/bin.json', reason: 'binary' }]);
  });
});

describe('template access and demo', () => {
  test('free listings, the seller and admins can use a template without an order', async () => {
    const p = product({ pricing: { model: 'free', price: 0 } });
    assert.equal(tpl.isFreeListing(p), true);
    assert.equal(tpl.isFreeListing(product({ pricing: { model: 'one-time', price: 0 } })), true);
    assert.equal(tpl.isFreeListing(product()), false);
    assert.equal(await tpl.hasTemplateAccess(null, p), false);
    assert.equal(await tpl.hasTemplateAccess({ _id: new mongoose.Types.ObjectId() }, p), true);
    const paid = product();
    assert.equal(await tpl.hasTemplateAccess({ _id: paid.creator, role: 'seller' }, paid), true);
    assert.equal(await tpl.hasTemplateAccess({ _id: new mongoose.Types.ObjectId(), role: 'admin' }, paid), true);
  });

  test('demo is public only when enabled and the listing is live or under review', () => {
    const t = { demoEnabled: true, files: webFiles };
    assert.equal(tpl.demoVisible(product(), t), true);
    assert.equal(tpl.demoVisible(product({ moderationStatus: 'pending_review', published: false }), t), true);
    assert.equal(tpl.demoVisible(product({ moderationStatus: 'blocked' }), t), false);
    assert.equal(tpl.demoVisible(product(), { ...t, demoEnabled: false }), false);
    assert.equal(tpl.demoVisible(product(), { demoEnabled: true, files: [] }), false);
  });

  test('template meta exposes the demo link but never file contents', () => {
    const p = product({ category: 'template-app' });
    const meta = templateMeta(p, { files: appFiles, version: 3, demoEnabled: true, useCount: 7 }, { access: false, paths: true });
    assert.equal(meta.kind, 'app');
    assert.equal(meta.version, 3);
    assert.equal(meta.fileCount, 3);
    assert.match(meta.demoUrl, new RegExp(`/v1/builder/templates/${p._id}/demo/$`));
    assert.equal(meta.access, false);
    assert.ok(meta.paths.includes('App.tsx'));
    assert.equal(JSON.stringify(meta).includes('StyleSheet.create'), false);
  });

  test('demo documents reuse the sandboxed preview runtime', () => {
    const web = previewResponse({ name: 'T', kind: 'web', files: webFiles }, '');
    assert.match(web.headers['Content-Security-Policy'], /^sandbox allow-scripts/);
    const app = previewResponse({ name: 'T', kind: 'app', files: appFiles }, '');
    assert.match(app.body, /react-native-web@/);
  });

  test('projects built from another seller\'s template are not marked resellable', () => {
    const owner = new mongoose.Types.ObjectId();
    const project = (creator) => ({
      _id: new mongoose.Types.ObjectId(),
      owner,
      name: 'P',
      kind: 'web',
      files: webFiles,
      previewToken: 'x'.repeat(32),
      template: { product: new mongoose.Types.ObjectId(), creator, name: 'T', version: 1 },
    });
    assert.equal(publicProject(project(owner)).template.own, true);
    assert.equal(publicProject(project(new mongoose.Types.ObjectId())).template.own, false);
    assert.equal(publicProject(project(null)).template.own, false);
    assert.equal(publicProject({ ...project(owner), template: {} }).template, null);
  });

  test('template sales are taxed as software licenses', () => {
    assert.equal(taxCategoryFromProduct({ category: 'template-web', productType: 'AI_APPLICATION' }), 'SOFTWARE_LICENSE');
    assert.equal(tpl.templateKind('template-app'), 'app');
    assert.equal(tpl.templateKind('hire-build-app'), '');
  });
});
