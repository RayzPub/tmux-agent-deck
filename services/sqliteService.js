const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { PROJECT_ROOT } = require('../config');

const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SCHEMA_VERSION = 1;

let dbInstance = null;
let currentDbPath = null;

function resolveDbPath(customPath) {
  return path.resolve(customPath || process.env.CCNOW_DB_PATH || path.join(DEFAULT_DATA_DIR, 'ccnow.db'));
}

/**
 * Best-effort chown to SUDO_USER when running as root so non-root scripts/dev runs remain writable.
 */
function chownIfSudo(targetPath) {
  try {
    if (process.getuid && process.getuid() === 0 && process.env.SUDO_UID && process.env.SUDO_GID) {
      const uid = parseInt(process.env.SUDO_UID, 10);
      const gid = parseInt(process.env.SUDO_GID, 10);
      if (!Number.isNaN(uid) && !Number.isNaN(gid) && fs.existsSync(targetPath)) {
        fs.chownSync(targetPath, uid, gid);
      }
    }
  } catch (_) {
    // ignore chown errors on non-standard filesystems
  }
}

/**
 * Crash-safe atomic JSON writer (write temp file + fs.renameSync).
 */
function atomicWriteJSON(filePath, data, options = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    chownIfSudo(dir);
  }
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify(data, null, 2) + '\n';
  try {
    const writeOpts = { encoding: 'utf8' };
    if (options.mode) {
      writeOpts.mode = options.mode;
    }
    fs.writeFileSync(tmpFile, payload, writeOpts);
    if (options.mode) {
      try { fs.chmodSync(tmpFile, options.mode); } catch (_) {}
    }
    chownIfSudo(tmpFile);
    fs.renameSync(tmpFile, filePath);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_) {}
    throw err;
  }
}

function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  const row = db.prepare('PRAGMA user_version').get();
  const currentVersion = row ? Number(row.user_version || 0) : 0;

  if (currentVersion < 1) {
    db.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS users (
        username_key  TEXT PRIMARY KEY,
        username      TEXT NOT NULL,
        password_hash TEXT,
        role          TEXT NOT NULL DEFAULT 'user',
        api_keys_json TEXT NOT NULL DEFAULT '{}',
        extra_json    TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invite_codes (
        code       TEXT PRIMARY KEY,
        created_by TEXT,
        created_at TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        used_by    TEXT,
        used_at    TEXT,
        note       TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        device_id        TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL,
        name             TEXT NOT NULL,
        hostname         TEXT NOT NULL DEFAULT 'unknown-host',
        platform         TEXT NOT NULL DEFAULT 'unknown',
        arch             TEXT NOT NULL DEFAULT 'unknown',
        client_version   TEXT NOT NULL DEFAULT '1.0.0',
        agent_types_json TEXT NOT NULL DEFAULT '[]',
        device_kind      TEXT NOT NULL DEFAULT 'external',
        container_name   TEXT,
        secret_hash      TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        last_seen        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

      CREATE TABLE IF NOT EXISTS workspaces (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        scope      TEXT NOT NULL,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        extra_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_workspaces_scope ON workspaces(scope, sort_order);

      CREATE TABLE IF NOT EXISTS task_board_todos (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        workspace_name TEXT NOT NULL DEFAULT '',
        workspace_path TEXT NOT NULL DEFAULT '',
        agent_type     TEXT NOT NULL DEFAULT 'agy',
        priority       TEXT NOT NULL DEFAULT 'medium',
        extra_json     TEXT NOT NULL DEFAULT '{}',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_board_todos_user ON task_board_todos(username, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_board_card_meta (
        username     TEXT NOT NULL,
        session_name TEXT NOT NULL,
        custom_title TEXT,
        pinned       INTEGER NOT NULL DEFAULT 0,
        extra_json   TEXT NOT NULL DEFAULT '{}',
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (username, session_name)
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint          TEXT PRIMARY KEY,
        web_username      TEXT NOT NULL DEFAULT 'admin',
        subscription_json TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(web_username);

      CREATE TABLE IF NOT EXISTS im_bindings_kv (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS migration_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
  }
}

/**
 * Open a standalone DatabaseSync instance for a specific path (used by CLI migration scripts & tests).
 */
function openDatabase(dbPath) {
  const resolved = resolveDbPath(dbPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    chownIfSudo(dir);
  }
  const db = new DatabaseSync(resolved);
  initSchema(db);
  chownIfSudo(resolved);
  chownIfSudo(`${resolved}-wal`);
  chownIfSudo(`${resolved}-shm`);
  return db;
}

/**
 * Get the shared singleton DatabaseSync instance for the server runtime.
 */
function getDb() {
  const targetPath = resolveDbPath();
  if (dbInstance && currentDbPath === targetPath) {
    return dbInstance;
  }
  if (dbInstance) {
    try { dbInstance.close(); } catch (_) {}
    dbInstance = null;
  }
  dbInstance = openDatabase(targetPath);
  currentDbPath = targetPath;
  return dbInstance;
}

/**
 * Run a synchronous function inside a SQLite transaction.
 */
function withTransaction(fn, db = null) {
  const conn = db || getDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try { conn.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Close the singleton database connection cleanly (for graceful shutdown or tests).
 */
function closeDb() {
  if (dbInstance) {
    try { dbInstance.close(); } catch (_) {}
    dbInstance = null;
    currentDbPath = null;
  }
}

function getDbPath() {
  return resolveDbPath();
}

module.exports = {
  getDb,
  openDatabase,
  closeDb,
  getDbPath,
  withTransaction,
  atomicWriteJSON,
  chownIfSudo,
  SCHEMA_VERSION
};
