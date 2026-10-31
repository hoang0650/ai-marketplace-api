#!/usr/bin/env node
/**
 * Copy per-user trees out of a shared agent volume into aim-agent-<agent>-<userId>-data.
 *
 * Dry-run unless TENANT_MIGRATE_APPLY=1 and --apply are both set.
 * The shared volume is backed up first and is never deleted.
 *
 *   node scripts/migrate-tenant-volumes.js --agent nanoclaw --volume nanoclaw-aimarkets-data --paths paths.json
 *   TENANT_MIGRATE_APPLY=1 node scripts/migrate-tenant-volumes.js --agent nanoclaw --volume nanoclaw-aimarkets-data --apply
 *
 * --paths is a JSON array of relative paths inside the volume (from a read-only listing).
 * Without --paths the script prints the plan header and does not invent paths.
 */
const fs = require('fs');
const { planMigration, assertMigrationSafe, SHARED_VOLUMES } = require('../src/services/tenant-runtime');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

function main() {
  const agent = arg('--agent') || 'nanoclaw';
  const volume = arg('--volume') || 'nanoclaw-aimarkets-data';
  const apply = process.argv.includes('--apply');
  const pathsFile = arg('--paths');
  if (!SHARED_VOLUMES.includes(volume)) {
    console.error(`Refusing volume ${volume}. Known shared volumes: ${SHARED_VOLUMES.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  if (volume.startsWith('spacebot')) {
    console.error('SpaceBot volumes are not migrated and are not deleted.');
    process.exitCode = 2;
    return;
  }
  const paths = pathsFile ? JSON.parse(fs.readFileSync(pathsFile, 'utf8')) : [];
  const plan = assertMigrationSafe(planMigration({ agentId: agent, sharedVolume: volume, paths, now: new Date() }));
  const summary = {
    dryRun: !(apply && process.env.TENANT_MIGRATE_APPLY === '1'),
    sharedVolume: plan.sharedVolume,
    backupVolume: plan.backupVolume,
    deletes: plan.deletes,
    copies: plan.actions.filter((a) => a.op === 'copy-path').length,
    volumes: plan.actions.filter((a) => a.op === 'ensure-volume').map((a) => a.volume),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.dryRun) {
    console.log('Dry-run only. Re-run with --apply and TENANT_MIGRATE_APPLY=1 after the backup volume exists.');
    console.log('This script does not delete the shared volume.');
    return;
  }
  console.log('Apply requested. This process does not talk to Docker by itself.');
  console.log('Run the backup and copies from the runtime host using the plan actions, then leave the shared volume in place.');
  console.log(JSON.stringify(plan.actions, null, 2));
}

main();
