const test = require('node:test');
const assert = require('node:assert/strict');
const { runBuild } = require('../../src/utils/builder/template-build');

const entries = (files) => Object.entries(files).map(([path, data]) => ({ path, data }));
const errors = (r) => r.log.filter((l) => l.level === 'error').map((l) => l.msg);

test('web build passes with linked css/js and warns about missing images', () => {
  const r = runBuild({
    kind: 'web',
    entries: entries({
      'index.html': '<html><head><link rel="stylesheet" href="css/a.css"></head><body><img src="logo.png"><script src="./app.js"></script><script src="https://cdn.x/y.js"></script></body></html>',
      'css/a.css': 'body{}',
      'app.js': 'import x from "./b.js"; export const y = () => x;',
      'b.js': 'export default 1;',
    }),
  });
  assert.equal(r.ok, true, errors(r).join('\n'));
  assert.equal(r.files.length, 4);
  assert.ok(r.log.some((l) => l.level === 'warn' && l.msg.includes('logo.png')));
  assert.equal(r.log.at(-1).level, 'success');
});

test('web build fails on a missing script, a missing stylesheet and a JS syntax error', () => {
  const r = runBuild({
    kind: 'web',
    entries: entries({
      'index.html': '<body>\n<link rel="stylesheet" href="style.css">\n<script src="main.js"></script>\n<script src="app.js"></script></body>',
      'app.js': 'const a = ;',
    }),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.files, []);
  const msgs = errors(r).join('\n');
  assert.match(msgs, /index\.html:3 .*main\.js/);
  assert.match(msgs, /index\.html:2 .*style\.css/);
  assert.match(msgs, /app\.js: .*Unexpected token/);
  assert.match(r.log.at(-1).msg, /Build thất bại với 3 lỗi/);
});

test('missing entry file is reported in the log, not thrown', () => {
  const r = runBuild({ kind: 'web', entries: entries({ 'about.html': '<body></body>' }), describe: (e) => e.code });
  assert.equal(r.ok, false);
  assert.ok(errors(r).includes('TEMPLATE_ENTRY_MISSING'));
});

test('app build compiles TSX like the preview and resolves relative imports', () => {
  const r = runBuild({
    kind: 'app',
    entries: entries({
      'App.tsx': "import { View } from 'react-native';\nimport Card from './components/Card';\nexport default function App() { return <View><Card title=\"x\" /></View>; }",
      'components/Card.tsx': "import { Text } from 'react-native';\ntype P = { title: string };\nexport default function Card({ title }: P) { return <Text>{title}</Text>; }",
    }),
  });
  assert.equal(r.ok, true, errors(r).join('\n'));
});

test('app build fails on TSX syntax, unknown relative module and missing default export', () => {
  const broken = runBuild({
    kind: 'app',
    entries: entries({
      'App.tsx': "import Card from './Card';\nexport function App() { return <View>; }",
    }),
  });
  assert.equal(broken.ok, false);
  assert.match(errors(broken).join('\n'), /App\.tsx: .*\(2:/);

  const missing = runBuild({
    kind: 'app',
    entries: entries({ 'App.tsx': "import Card from './Card';\nimport dayjs from 'dayjs';\nexport function App() { return <Card at={dayjs()} />; }" }),
  });
  const msgs = errors(missing).join('\n');
  assert.match(msgs, /Cannot find module '\.\/Card'/);
  assert.match(msgs, /export default/);
  assert.ok(missing.log.some((l) => l.level === 'warn' && l.msg.includes('dayjs')));
});

test('a failed fetch (entries null) still ends with a failure line', () => {
  const r = runBuild({ kind: 'web', entries: null });
  assert.equal(r.ok, false);
  assert.match(r.log.at(-1).msg, /Build thất bại/);
});
