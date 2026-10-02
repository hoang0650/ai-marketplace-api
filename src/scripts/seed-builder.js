/**
 * Create (or recreate) the two AI App Builder demo projects — web landing page + mobile app —
 * for one account, replaying scripted provider replies (no API key / tokens used).
 * Usage: npm run seed:builder -- --email=user@example.com
 *        BUILDER_DEMO_EMAIL=user@example.com npm run seed:builder
 */
require('dotenv').config();
const crypto = require('crypto');
const { connectDb } = require('../config/db');
const User = require('../models/User');
const BuilderProject = require('../models/BuilderProject');
const files = require('../utils/builder/files');
const { applyGeneration, publicProject } = require('../routes/builder');
const { DEMO_CASES, replayCase } = require('./builder-demo-cases');

function argEmail() {
  const flag = process.argv.find((a) => a.startsWith('--email='));
  return String((flag ? flag.slice('--email='.length) : process.env.BUILDER_DEMO_EMAIL) || '')
    .trim()
    .toLowerCase();
}

async function seedBuilderDemos(email) {
  const user = await User.findOne({ email }).select('_id email').lean();
  if (!user) throw new Error(`Không tìm thấy user ${email}`);

  const names = DEMO_CASES.map((c) => c.name);
  const removed = await BuilderProject.deleteMany({ owner: user._id, name: { $in: names } });

  const created = [];
  for (const demo of DEMO_CASES) {
    const doc = new BuilderProject({
      owner: user._id,
      name: demo.name,
      kind: demo.kind,
      files: files.starterFiles(demo.kind),
      previewToken: crypto.randomBytes(24).toString('base64url'),
    });
    replayCase(doc, demo, applyGeneration);
    await doc.save();
    created.push(publicProject(doc));
  }
  return { user: user.email, removed: removed.deletedCount, created };
}

const email = argEmail();
if (!email) {
  console.error('[seed:builder] thiếu email: npm run seed:builder -- --email=user@example.com');
  process.exit(1);
}

connectDb()
  .then(() => seedBuilderDemos(email))
  .then((r) => {
    console.log(`[seed:builder] user=${r.user} removed=${r.removed}`);
    for (const p of r.created) {
      console.log(`  ${p.kind.padEnd(3)} ${p.name} (v${p.version}, ${p.fileCount} files)`);
      console.log(`      studio:  /build/${p.id}`);
      console.log(`      preview: ${p.previewUrl}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('[seed:builder] failed', err);
    process.exit(1);
  });
