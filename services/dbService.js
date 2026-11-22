const crypto = require('crypto');
const { getDb, withTransaction } = require('./sqliteService');
const { migrateJsonToSqlite } = require('./storageMigration');

// Password hashing
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
};

// Password verification
const verifyPassword = (password, storedHash) => {
  if (!storedHash) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const [, salt, hash] = parts;
  const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return checkHash === hash;
};

function rowToUser(row) {
  let apiKeys = {};
  let extra = {};
  try { apiKeys = JSON.parse(row.api_keys_json || '{}'); } catch (_) {}
  try { extra = JSON.parse(row.extra_json || '{}'); } catch (_) {}

  const user = {
    ...extra,
    username: row.username,
    role: row.role,
    createdAt: row.created_at
  };
  if (row.password_hash !== null && row.password_hash !== undefined) {
    user.passwordHash = row.password_hash;
  }
  if (apiKeys && Object.keys(apiKeys).length > 0) {
    user.apiKeys = apiKeys;
  }
  return user;
}

const getUsers = () => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM users').all();
    const result = {};
    for (const row of rows) {
      result[row.username_key] = rowToUser(row);
    }
    return result;
  } catch (err) {
    console.error('Error reading users from SQLite:', err);
    return {};
  }
};

const saveUsers = (users) => {
  try {
    const now = new Date().toISOString();
    withTransaction((db) => {
      const incomingKeys = Object.keys(users || {}).map(k => k.toLowerCase());
      const existingRows = db.prepare('SELECT username_key FROM users').all();
      const incomingSet = new Set(incomingKeys);

      const delStmt = db.prepare('DELETE FROM users WHERE username_key = ?');
      for (const r of existingRows) {
        if (!incomingSet.has(r.username_key)) {
          delStmt.run(r.username_key);
        }
      }

      const upsertStmt = db.prepare(`
        INSERT INTO users (username_key, username, password_hash, role, api_keys_json, extra_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username_key) DO UPDATE SET
          username = excluded.username,
          password_hash = excluded.password_hash,
          role = excluded.role,
          api_keys_json = excluded.api_keys_json,
          extra_json = excluded.extra_json,
          updated_at = excluded.updated_at
      `);

      for (const [rawKey, u] of Object.entries(users || {})) {
        if (!u || typeof u !== 'object') continue;
        const { username, passwordHash, role, apiKeys, createdAt, ...extra } = u;
        upsertStmt.run(
          rawKey.toLowerCase(),
          username || rawKey,
          passwordHash !== undefined ? passwordHash : null,
          role || 'user',
          JSON.stringify(apiKeys || {}),
          JSON.stringify(extra || {}),
          createdAt || now,
          now
        );
      }
    });
    return true;
  } catch (err) {
    console.error('Error saving users to SQLite:', err);
    return false;
  }
};

const getCodes = () => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM invite_codes ORDER BY created_at ASC').all();
    return rows.map(r => ({
      code: r.code,
      createdBy: r.created_by,
      createdAt: r.created_at,
      status: r.status,
      usedBy: r.used_by,
      usedAt: r.used_at,
      note: r.note || ''
    }));
  } catch (err) {
    console.error('Error reading invite_codes from SQLite:', err);
    return [];
  }
};

const saveCodes = (codes) => {
  try {
    const now = new Date().toISOString();
    withTransaction((db) => {
      db.prepare('DELETE FROM invite_codes').run();
      const ins = db.prepare(`
        INSERT INTO invite_codes (code, created_by, created_at, status, used_by, used_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of (Array.isArray(codes) ? codes : [])) {
        if (!c || !c.code) continue;
        ins.run(
          String(c.code),
          c.createdBy || null,
          c.createdAt || now,
          c.status || 'pending',
          c.usedBy || null,
          c.usedAt || null,
          c.note || ''
        );
      }
    });
    return true;
  } catch (err) {
    console.error('Error saving invite_codes to SQLite:', err);
    return false;
  }
};

/**
 * Atomically redeem an invite code and create the user in a single SQLite transaction.
 * Prevents concurrent race conditions where two requests reuse the same invite code or username.
 */
const registerUserWithInviteCode = ({ code, username, password }) => {
  const usernameKey = String(username || '').toLowerCase();
  const reservedUsernames = ['default', 'admin', 'system', 'guest', 'user_data', 'workspaces'];
  if (reservedUsernames.includes(usernameKey)) {
    return { ok: false, error: 'Username already exists or is reserved.' };
  }

  const now = new Date().toISOString();
  const passwordHash = hashPassword(password);

  return withTransaction((db) => {
    const existingUser = db.prepare('SELECT username_key FROM users WHERE username_key = ?').get(usernameKey);
    if (existingUser) {
      return { ok: false, error: 'Username already exists or is reserved.' };
    }

    const redeemRes = db.prepare(`
      UPDATE invite_codes
      SET status = 'used', used_by = ?, used_at = ?
      WHERE code = ? AND status = 'pending'
    `).run(username, now, code);

    if (!redeemRes || Number(redeemRes.changes) === 0) {
      return { ok: false, error: 'Invalid or already used invite code' };
    }

    db.prepare(`
      INSERT INTO users (username_key, username, password_hash, role, api_keys_json, extra_json, created_at, updated_at)
      VALUES (?, ?, ?, 'user', '{}', '{}', ?, ?)
    `).run(usernameKey, username, passwordHash, now, now);

    return { ok: true };
  });
};

const getSettings = () => {
  const current = {};
  try {
    const db = getDb();
    const rows = db.prepare('SELECT key, value_json FROM settings').all();
    for (const row of rows) {
      try {
        current[row.key] = JSON.parse(row.value_json);
      } catch (_) {}
    }
  } catch (err) {
    console.error('Error reading settings from SQLite:', err);
  }

  if (!current.enabledAgents) {
    current.enabledAgents = ['default', 'agy', 'claude', 'codex', 'kimi'];
  }
  if (!current.appIcon) {
    current.appIcon = 'shape-diamond';
  }
  if (current.claudeOAuthMode === undefined) {
    current.claudeOAuthMode = false;
  }
  return current;
};

const saveSettings = (settings) => {
  try {
    const now = new Date().toISOString();
    withTransaction((db) => {
      db.prepare('DELETE FROM settings').run();
      const ins = db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)');
      for (const [k, v] of Object.entries(settings || {})) {
        if (v === undefined) continue;
        ins.run(k, JSON.stringify(v), now);
      }
    });
    return true;
  } catch (err) {
    console.error('Error saving settings to SQLite:', err);
    return false;
  }
};

const runMigration = () => {
  // 1. Always ensure legacy JSON -> SQLite migration runs once on boot (idempotent)
  try {
    const report = migrateJsonToSqlite({ silentIfDone: true, backup: true });
    if (!report.skipped && report.migratedFiles.length > 0) {
      console.log(
        `✅ [Migration] Imported legacy JSON into SQLite (${report.counts.users} users, ` +
        `${report.counts.devices} devices, ${report.counts.workspaces} workspaces, ` +
        `${report.counts.inviteCodes} invite codes).`
      );
      if (report.backupDir) {
        console.log(`📦 [Migration] Legacy JSON backup saved to: ${report.backupDir}`);
      }
    }
  } catch (err) {
    console.error('❌ [Migration] Legacy JSON -> SQLite import failed:', err);
  }

  const { PASSWORD, MULTI_USER_ENABLED } = require('../config');
  if (!MULTI_USER_ENABLED) return;

  const db = module.exports;
  const users = db.getUsers();

  // 2. If users database is empty, create default admin using PASSWORD
  if (Object.keys(users).length === 0) {
    console.log('🏁 [Migration] Initializing empty user database. Creating default admin account...');
    users['admin'] = {
      username: 'admin',
      passwordHash: db.hashPassword(PASSWORD),
      role: 'admin',
      createdAt: new Date().toISOString()
    };
    db.saveUsers(users);
    console.log('✅ [Migration] Default admin account successfully created.');
  }

  // 3. Rename active legacy tmux sessions
  const { exec } = require('child_process');
  exec('tmux list-sessions -F "#{session_name}"', (err, stdout) => {
    if (err) return;
    const sessions = stdout.trim().split('\n').filter(Boolean);
    sessions.forEach(s => {
      if (s === 'agy' || s === 'claude' || s === 'codex') {
        const newName = `u_admin_${s}`;
        console.log(`🏁 [Migration] Renaming legacy tmux session '${s}' to '${newName}'...`);
        exec(`tmux rename-session -t ${s} ${newName}`, (renameErr) => {
          if (renameErr) {
            console.error(`❌ [Migration] Failed to rename session ${s}:`, renameErr.message);
          } else {
            console.log(`✅ [Migration] Session '${s}' successfully renamed.`);
          }
        });
      }
    });
  });
};

module.exports = {
  getUsers,
  saveUsers,
  getCodes,
  saveCodes,
  registerUserWithInviteCode,
  getSettings,
  saveSettings,
  hashPassword,
  verifyPassword,
  runMigration
};
