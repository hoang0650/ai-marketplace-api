const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const files = require('../../src/utils/builder/files');
const { buildMessages } = require('../../src/utils/builder/prompts');
const { previewResponse, scriptJson } = require('../../src/utils/builder/preview');
const llm = require('../../src/utils/builder/llm');
const BuilderProject = require('../../src/models/BuilderProject');
const { applyGeneration } = require('../../src/routes/builder');

function project(kind, over = {}) {
  return new BuilderProject({
    owner: new mongoose.Types.ObjectId(),
    name: 'Demo',
    kind,
    files: files.starterFiles(kind),
    previewToken: 'x'.repeat(32),
    ...over,
  });
}

describe('builder file rules', () => {
  test('paths stay relative and match the project kind', () => {
    assert.equal(files.cleanPath('app', './components/Card.tsx'), 'components/Card.tsx');
    assert.equal(files.cleanPath('web', 'css\\site.css'), 'css/site.css');
    assert.equal(files.cleanPath('web', '../etc/passwd.txt'), '');
    assert.equal(files.cleanPath('web', '/abs.html'), '');
    assert.equal(files.cleanPath('web', '.env.js'), '');
    assert.equal(files.cleanPath('app', 'index.html'), '');
    assert.equal(files.cleanPath('web', 'App.tsx'), '');
  });

  test('model output is split into files, deletes and the chat summary', () => {
    const out = files.parseOutput(
      'Đã tạo màn hình.\n<file path="App.tsx">\n```tsx\nexport default function App() {}\n```\n</file>\n<delete path="old.js" />\n- thêm tab'
    );
    assert.deepEqual(out.files, [{ path: 'App.tsx', content: 'export default function App() {}' }]);
    assert.deepEqual(out.deletes, ['old.js']);
    assert.equal(out.truncated, false);
    assert.match(out.summary, /Đã tạo màn hình/);
    assert.doesNotMatch(out.summary, /export default/);
  });

  test('a file cut off by the token limit is not applied', () => {
    const out = files.parseOutput('<file path="a.js">ok</file><file path="b.js">const x =');
    assert.deepEqual(out.files.map((f) => f.path), ['a.js']);
    assert.equal(out.truncated, true);
  });

  test('changes reject bad paths and keep the entry file first', () => {
    const out = files.applyChanges('app', [{ path: 'App.tsx', content: 'a' }], {
      files: [
        { path: 'components/B.tsx', content: 'b' },
        { path: '../x.tsx', content: 'x' },
      ],
      deletes: ['nope.tsx'],
    });
    assert.deepEqual(out.files.map((f) => f.path), ['App.tsx', 'components/B.tsx']);
    assert.deepEqual(out.touched, ['components/B.tsx']);
    assert.deepEqual(out.rejected, ['../x.tsx']);
  });

  test('project size caps are enforced', () => {
    const big = Array.from({ length: files.limits().maxFiles + 1 }, (_, i) => ({ path: `f${i}.js`, content: '' }));
    assert.throws(() => files.applyChanges('web', [], { files: big }), { code: 'PROJECT_TOO_MANY_FILES' });
  });
});

describe('builder prompts', () => {
  test('history keeps summaries only and never two turns of the same role', () => {
    const msgs = buildMessages({
      kind: 'app',
      files: [{ path: 'App.tsx', content: 'code' }],
      history: [
        { role: 'user', content: 'làm app todo' },
        { role: 'assistant', content: 'Đã làm', files: ['App.tsx'] },
        { role: 'user', content: 'lượt lỗi trước' },
      ],
      prompt: 'thêm dark mode',
      previewError: 'TypeError: x is undefined',
    });
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /react-native-web/);
    for (let i = 2; i < msgs.length; i++) assert.notEqual(msgs[i].role, msgs[i - 1].role);
    const last = msgs[msgs.length - 1];
    assert.match(last.content, /<file path="App.tsx">/);
    assert.match(last.content, /thêm dark mode/);
    assert.match(last.content, /TypeError/);
    assert.match(msgs[2].content, /files written: App.tsx/);
  });

  test('output caps follow provider limits', () => {
    assert.equal(llm.maxOutputTokens('deepseek'), 8192);
    assert.equal(llm.maxOutputTokens('anthropic'), 16000);
  });
});

describe('builder preview', () => {
  test('web projects are served file by file inside a CSP sandbox', () => {
    const doc = project('web');
    const index = previewResponse(doc, '');
    assert.equal(index.status, 200);
    assert.match(index.headers['Content-Security-Policy'], /^sandbox allow-scripts/);
    assert.doesNotMatch(index.headers['Content-Security-Policy'], /allow-same-origin/);
    assert.match(index.body, /aim-preview/);
    assert.equal(index.headers['Referrer-Policy'], 'no-referrer');
    const css = previewResponse(doc, 'styles.css');
    assert.match(css.headers['Content-Type'], /text\/css/);
    assert.equal(previewResponse(doc, 'missing.js').status, 404);
  });

  test('app projects get the react-native-web runtime with files embedded safely', () => {
    const doc = project('app', { files: [{ path: 'App.tsx', content: 'const s = "</script><script>alert(1)</script>";' }] });
    const out = previewResponse(doc, '');
    assert.equal(out.status, 200);
    assert.match(out.body, /react-native-web@/);
    assert.match(out.body, /babel/);
    assert.doesNotMatch(out.body, /<\/script><script>alert/);
    assert.equal(previewResponse(doc, 'App.tsx').status, 404);
    assert.equal(JSON.parse(scriptJson({ a: '</script>' })).a, '</script>');
  });
});

describe('builder generation', () => {
  test('retains a bounded display duration without changing generated files', () => {
    for (const [input, expected] of [[14200, 14200], [-1, 0], [Infinity, 0], [9000000, 3600000]]) {
      const doc = project('web');
      applyGeneration(doc, { prompt: 'Explain', text: '**Done.**', provider: 'openai', model: 'test', durationMs: input });
      assert.equal(doc.messages[1].durationMs, expected);
      assert.equal(doc.messages[1].content, '**Done.**');
      assert.equal(doc.version, 0);
    }
  });

  test('provider errors cannot echo a buyer key into chat or logs', async () => {
    const original = global.fetch;
    const secret = 'sk-fake-private-key-never-render';
    global.fetch = async () => new Response(JSON.stringify({ error: { message: `Authorization: Bearer ${secret}` } }), { status: 401 });
    try {
      await assert.rejects(llm.streamChat({ provider: 'openai', apiKey: secret, model: 'test', messages: [] }), (e) => {
        assert.equal(e.code, 'PROVIDER_KEY_REJECTED');
        assert.ok(!e.message.includes(secret));
        return true;
      });
    } finally { global.fetch = original; }
  });
  test('a model reply updates files, bumps the version and records the turn', () => {
    const doc = project('app');
    const r = applyGeneration(doc, {
      prompt: 'app đặt phòng',
      text: 'Xong.\n<file path="App.tsx">export default function App(){return null}</file>',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    assert.deepEqual(r.touched, ['App.tsx']);
    assert.equal(doc.version, 1);
    assert.equal(doc.messages.length, 2);
    assert.equal(doc.messages[1].content, 'Xong.');
    assert.equal(doc.provider, 'anthropic');
  });

  test('empty replies are reported instead of saved', () => {
    assert.throws(() => applyGeneration(project('web'), { prompt: 'x', text: '', provider: 'openai', model: 'gpt-4.1' }), {
      code: 'EMPTY_OUTPUT',
    });
  });
});
