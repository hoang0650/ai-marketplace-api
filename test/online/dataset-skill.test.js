const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../../src/utils/dataset-store');
const { readZip, writeZip } = require('../../src/utils/zip-lite');
const skills = require('../../src/routes/skills-online')._test;

describe('dataset splits', () => {
  const ep = (title) => ({ title, objectName: `o/${title}` });
  test('jsonl wins over csv, docs and zips are not splits, suffix aliases resolve', () => {
    const files = store.pickSplitFiles([ep('train.jsonl'), ep('train.csv'), ep('README.md'), ep('labels.json'), ep('x.zip'), ep('address_parsing_validation.jsonl'), ep('wards.csv')]);
    assert.deepEqual(files.map((f) => `${f.stem}.${f.ext}`).sort(), ['address_parsing_validation.jsonl', 'train.jsonl', 'wards.csv']);
    assert.equal(store.resolveSplit(files, 'validation').stem, 'address_parsing_validation');
    assert.equal(store.resolveSplit(files, 'train').ext, 'jsonl');
    assert.equal(store.resolveSplit(files, 'nope'), null);
  });
  test('csv parser handles BOM, quotes and newlines in fields', () => {
    const r = store.parseCsv('\uFEFFa,b\n1,"x, ""y"""\n2,"multi\nline"\n');
    assert.deepEqual(r.columns, ['a', 'b']);
    assert.deepEqual(r.rows, [{ a: '1', b: 'x, "y"' }, { a: '2', b: 'multi\nline' }]);
  });
  test('jsonl rows parse lazily', () => {
    const e = store.parseFile('jsonl', Buffer.from('{"t":1}\n\n{"t":2}\n'));
    assert.equal(e.rows.length, 2);
    assert.deepEqual(store.rowAt(e, 1), { t: 2 });
  });
});

describe('skill loader + runs', () => {
  const md = '---\nname: demo\ndescription: Demo skill.\nlicense: MIT\nmetadata:\n  openclaw:\n    emoji: "🧾"\n    requires:\n      bins:\n        - python3\n---\n\n# Demo\n\nCông cụ offline, Python 3.9+ thư viện chuẩn.\n\n## Lệnh\n```bash\npython3 {baseDir}/scripts/demo.py run x\n```\n\n## Kiểm thử\n```bash\npython3 {baseDir}/tests/test_demo.py\n```\n';
  const bundle = { root: 'demo', files: new Map([['SKILL.md', Buffer.from(md)], ['scripts/demo.py', Buffer.from('print("secret logic")')], ['prompts/p.md', Buffer.from('p')]]) };
  const product = { slug: 'skill-demo', name: 'Demo' };

  test('SKILL.md keeps OpenClaw frontmatter, requires the license env, drops offline wording and tests', () => {
    const out = skills.loaderSkillMd(bundle, product);
    const { head, body } = skills.frontmatter(out);
    assert.match(head, /^name: demo$/m);
    assert.match(head, /primaryEnv: AIMARKETS_LICENSE_KEY/);
    assert.match(head, /- AIMARKETS_API_KEY/);
    assert.match(head, /- python3/);
    assert.doesNotMatch(body, /offline/);
    assert.doesNotMatch(body, /tests\/test_demo/);
    assert.match(body, /python3 \{baseDir\}\/scripts\/demo\.py run x/);
  });

  test('loader zip ships stubs only, never the skill code', () => {
    const files = readZip(skills.buildLoaderZip(bundle, product));
    assert.deepEqual([...files.keys()].sort(), ['demo/LICENSE-LOADER.txt', 'demo/SKILL.md', 'demo/scripts/aim_resource.py', 'demo/scripts/demo.py']);
    const stub = files.get('demo/scripts/demo.py').toString();
    assert.doesNotMatch(stub, /secret logic/);
    assert.match(stub, /SLUG = "skill-demo"/);
    assert.match(stub, /SCRIPT = "demo.py"/);
  });

  test('run bodies: known script only, no absolute / parent paths, files under in/ or out/', () => {
    const ok = skills.cleanRunBody({ script: 'demo.py', argv: ['run', 'in/0/a.json', '--out=res'], files: [{ path: 'in/0/a.json', data: 'e30=' }] }, ['demo.py']);
    assert.equal(ok.files['in/0/a.json'], 'e30=');
    const bad = (b) => assert.throws(() => skills.cleanRunBody(b, ['demo.py']), (e) => e.status === 400);
    bad({ script: 'other.py' });
    bad({ script: 'demo.py', argv: ['/etc/passwd'] });
    bad({ script: 'demo.py', argv: ['--policy=../x'] });
    bad({ script: 'demo.py', argv: ['C:\\x'] });
    bad({ script: 'demo.py', files: [{ path: '../x', data: '' }] });
    bad({ script: 'demo.py', files: [{ path: 'etc/x', data: '' }] });
  });

  test('server runs: platform skills yes, third-party only after admin approval', () => {
    assert.equal(skills.serverRunAllowed({ ownershipType: 'PLATFORM_DIRECT' }), true);
    assert.equal(skills.serverRunAllowed({ ownershipType: 'THIRD_PARTY_SELLER' }), false);
    assert.equal(skills.serverRunAllowed({ ownershipType: 'THIRD_PARTY_SELLER', contentMeta: { onlineRunApproved: true } }), true);
  });

  test('zip round trip', () => {
    const z = readZip(writeZip([{ name: 'a/b.txt', data: 'xin chào' }]));
    assert.equal(z.get('a/b.txt').toString(), 'xin chào');
  });
});
