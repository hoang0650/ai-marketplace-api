const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const files = require('../../src/utils/builder/files');
const { buildMessages } = require('../../src/utils/builder/prompts');
const { previewResponse } = require('../../src/utils/builder/preview');
const BuilderProject = require('../../src/models/BuilderProject');
const { applyGeneration } = require('../../src/routes/builder');
const { WEB_CASE, APP_CASE, APP_PREVIEW_ERROR, replayCase } = require('../../src/scripts/builder-demo-cases');

function demoProject(demo) {
  return new BuilderProject({
    owner: new mongoose.Types.ObjectId(),
    name: demo.name,
    kind: demo.kind,
    files: files.starterFiles(demo.kind),
    previewToken: 'x'.repeat(32),
  });
}

function fileOf(doc, path) {
  return (doc.files.find((f) => f.path === path) || {}).content;
}

describe('builder demo: web landing page', () => {
  test('first turn writes the site and drops the starter script', () => {
    const doc = demoProject(WEB_CASE);
    const [r] = replayCase(doc, WEB_CASE, applyGeneration, { turns: 1 });
    assert.deepEqual(r.rejected, []);
    assert.equal(r.truncated, false);
    assert.equal(doc.files[0].path, 'index.html');
    assert.deepEqual(doc.files.map((f) => f.path).sort(), ['index.html', 'js/app.js', 'js/rooms.js', 'styles.css']);
    assert.equal(fileOf(doc, 'app.js'), undefined);
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.messages[1].files.sort(), ['app.js', 'index.html', 'js/app.js', 'js/rooms.js', 'styles.css']);
    assert.match(doc.messages[1].content, /landing page PH Hotel/);
    assert.doesNotMatch(doc.messages[1].content, /<file/);
  });

  test('second turn adds the theme module with another provider', () => {
    const doc = demoProject(WEB_CASE);
    const results = replayCase(doc, WEB_CASE, applyGeneration);
    assert.deepEqual(results[1].touched, ['js/theme.js', 'js/app.js']);
    assert.equal(doc.version, 2);
    assert.equal(doc.messages.length, 4);
    assert.equal(doc.provider, 'anthropic');
    assert.match(fileOf(doc, 'js/app.js'), /^import '\.\/theme\.js';/);
  });

  test('preview serves every file of the finished site', () => {
    const doc = demoProject(WEB_CASE);
    replayCase(doc, WEB_CASE, applyGeneration);
    const index = previewResponse(doc, '');
    assert.equal(index.status, 200);
    assert.match(index.body, /<script type="module" src="js\/app\.js">/);
    assert.match(index.body, /aim-preview/);
    for (const path of ['styles.css', 'js/app.js', 'js/rooms.js', 'js/theme.js']) {
      assert.equal(previewResponse(doc, path).status, 200, path);
    }
    assert.match(previewResponse(doc, 'js/theme.js').headers['Content-Type'], /javascript/);
    assert.equal(previewResponse(doc, 'app.js').status, 404);
  });
});

describe('builder demo: mobile app', () => {
  test('first turn ships the booking app with the missing import bug', () => {
    const doc = demoProject(APP_CASE);
    const [r] = replayCase(doc, APP_CASE, applyGeneration, { turns: 1 });
    assert.deepEqual(r.rejected, []);
    assert.deepEqual(doc.files.map((f) => f.path).sort(), ['App.tsx', 'components/RoomCard.tsx', 'data/rooms.ts']);
    const card = fileOf(doc, 'components/RoomCard.tsx');
    assert.match(card, /<Pressable/);
    assert.doesNotMatch(card.split('\n')[1], /Pressable/);
  });

  test('the fix turn sends the preview error to the model and records it as the user turn', () => {
    const doc = demoProject(APP_CASE);
    replayCase(doc, APP_CASE, applyGeneration, { turns: 1 });
    const msgs = buildMessages({
      kind: 'app',
      files: doc.files,
      history: doc.messages,
      prompt: '',
      previewError: APP_PREVIEW_ERROR,
    });
    assert.match(msgs[msgs.length - 1].content, /Pressable is not defined/);

    const [r] = replayCase(doc, { turns: APP_CASE.turns.slice(1) }, applyGeneration);
    assert.deepEqual(r.touched, ['components/RoomCard.tsx']);
    assert.equal(doc.version, 2);
    assert.equal(doc.messages[2].content, 'Sửa lỗi: ReferenceError: Pressable is not defined');
    assert.match(fileOf(doc, 'components/RoomCard.tsx').split('\n')[1], /Pressable/);
  });

  test('preview runtime embeds all app files', () => {
    const doc = demoProject(APP_CASE);
    replayCase(doc, APP_CASE, applyGeneration);
    const out = previewResponse(doc, '');
    assert.equal(out.status, 200);
    assert.match(out.body, /react-native-web@/);
    for (const path of ['App.tsx', 'components/RoomCard.tsx', 'data/rooms.ts']) {
      assert.ok(out.body.includes(JSON.stringify(path)), path);
    }
  });
});
