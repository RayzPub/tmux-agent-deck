#!/usr/bin/env node
/**
 * Standalone JSON -> SQLite Data Migration Script for tmux-agent-deck (CCNOW)
 *
 * Usage:
 *   node scripts/migrate-json-to-sqlite.js [options]
 *
 * Options:
 *   --dry-run              Preview what will be migrated without modifying DB or files
 *   --force                Re-import/upsert from legacy JSON even if already migrated
 *   --archive              Move migrated legacy JSON files into data/legacy_json_backup_<ts>/ after commit
 *   --no-backup            Skip copying legacy JSON files to backup folder (default creates backup)
 *   --project-root <dir>   Target another tmux-agent-deck instance directory
 *   --db-path <file>       Target a custom SQLite database file path
 *   -h, --help             Show this help message
 */

const path = require('path');
const { migrateJsonToSqlite } = require('../services/storageMigration');
const { closeDb } = require('../services/sqliteService');

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    force: false,
    archive: false,
    backup: true,
    projectRoot: null,
    dbPath: null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--archive') {
      opts.archive = true;
      opts.backup = true;
    } else if (arg === '--no-backup') {
      opts.backup = false;
    } else if (arg === '--project-root' && argv[i + 1]) {
      opts.projectRoot = path.resolve(argv[++i]);
    } else if (arg === '--db-path' && argv[i + 1]) {
      opts.dbPath = path.resolve(argv[++i]);
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      opts.help = true;
      process.exitCode = 1;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
CCNOW Storage Migration Tool (Legacy JSON -> SQLite)

Usage:
  node scripts/migrate-json-to-sqlite.js [options]

Options:
  --dry-run              Preview migration counts without writing to SQLite or disk
  --force                Re-import/upsert all legacy JSON files even if already migrated
  --archive              Backup and remove legacy JSON files after successful SQLite commit
  --no-backup            Skip creating a backup copy of legacy JSON files
  --project-root <dir>   Run migration against a specific instance directory
  --db-path <file>       Write to a custom SQLite database path
  -h, --help             Show help
`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  console.log('🚀 [CCNOW Migration] Starting Legacy JSON -> SQLite migration...');
  if (opts.dryRun) {
    console.log('🔍 [CCNOW Migration] DRY RUN mode enabled — no changes will be written.');
  }

  const report = migrateJsonToSqlite({
    projectRoot: opts.projectRoot || undefined,
    dbPath: opts.dbPath || undefined,
    dryRun: opts.dryRun,
    force: opts.force,
    backup: opts.backup,
    archive: opts.archive,
    silentIfDone: false
  });

  console.log('');
  console.log(`📂 Project Root : ${report.projectRoot}`);
  console.log(`🗄️  SQLite DB    : ${report.dbPath}`);
  if (report.backupDir) {
    console.log(`📦 Backup Dir   : ${report.backupDir}`);
  }

  if (report.skipped) {
    console.log('⏭️  Status       : Already migrated (use --force to re-import).');
  } else {
    console.log(`✅ Status       : ${report.dryRun ? 'Dry-run preview complete' : 'Migration committed successfully'}`);
    console.log('');
    console.log('📊 Migrated Entity Summary:');
    console.log(`   - users                : ${report.counts.users}`);
    console.log(`   - invite_codes         : ${report.counts.inviteCodes}`);
    console.log(`   - settings (keys)      : ${report.counts.settings}`);
    console.log(`   - devices              : ${report.counts.devices}`);
    console.log(`   - workspaces           : ${report.counts.workspaces}`);
    console.log(`   - task_board_todos     : ${report.counts.taskBoardTodos}`);
    console.log(`   - task_board_card_meta : ${report.counts.taskBoardCardMeta}`);
    console.log(`   - push_subscriptions   : ${report.counts.pushSubscriptions}`);
    console.log(`   - im_bindings (keys)   : ${report.counts.imBindingsKeys}`);
    console.log(`   - vapid.json -> data/  : ${report.counts.vapidMigrated ? 'yes' : 'no (already in data/ or absent)'}`);
  }

  if (report.warnings.length > 0) {
    console.log('');
    console.warn('⚠️ Warnings:');
    report.warnings.forEach(w => console.warn(`   - ${w}`));
  }

  closeDb();
}

main();
