const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('../config');
const { openDatabase, getDb, getDbPath, withTransaction, atomicWriteJSON, chownIfSudo } = require('./sqliteService');

const MIGRATION_DONE_KEY = 'legacy_json_import_v1';

function safeReadJSON(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, data: null };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { exists: true, data: JSON.parse(raw) };
  } catch (err) {
    return { exists: true, data: null, error: err.message };
  }
}

function isLegacyMigrationDone(db) {
  try {
    const row = db.prepare('SELECT value FROM migration_meta WHERE key = ?').get(MIGRATION_DONE_KEY);
    return Boolean(row && row.value === 'done');
  } catch (_) {
    return false;
  }
}

/**
 * Discover all legacy JSON files under projectRoot and projectRoot/data
 */
function discoverLegacyFiles(projectRoot) {
  const dataDir = path.join(projectRoot, 'data');
  const found = {
    users: path.join(dataDir, 'users.json'),
    inviteCodes: path.join(dataDir, 'invite_codes.json'),
    settings: path.join(dataDir, 'settings.json'),
    devices: path.join(dataDir, 'devices.json'),
    singleWorkspaces: path.join(projectRoot, 'workspaces.json'),
    userWorkspaces: [],
    taskBoards: [],
    pushSubscriptions: path.join(projectRoot, 'push_subscriptions.json'),
    imBindings: path.join(projectRoot, 'im_bindings.json'),
    vapidRoot: path.join(projectRoot, 'vapid.json'),
    vapidData: path.join(dataDir, 'vapid.json')
  };

  if (fs.existsSync(dataDir)) {
    const entries = fs.readdirSync(dataDir);
    for (const name of entries) {
      if (name.startsWith('workspaces_') && name.endsWith('.json')) {
        const username = name.slice('workspaces_'.length, -'.json'.length);
        if (username) {
          found.userWorkspaces.push({ username, file: path.join(dataDir, name) });
        }
      } else if (name.startsWith('task_board_') && name.endsWith('.json')) {
        const username = name.slice('task_board_'.length, -'.json'.length);
        if (username) {
          found.taskBoards.push({ username, file: path.join(dataDir, name) });
        }
      }
    }
  }

  return found;
}

/**
 * Idempotently migrate legacy JSON files into SQLite (and consolidate vapid.json into data/vapid.json).
 *
 * Options:
 * - projectRoot: override project root directory (default: PROJECT_ROOT)
 * - dbPath: override SQLite DB path (default: <projectRoot>/data/ccnow.db or CCNOW_DB_PATH)
 * - db: optional already-open DatabaseSync instance
 * - force: re-import even if migration_meta already marks legacy_json_import_v1 as done
 * - dryRun: inspect and report counts without modifying DB or filesystem
 * - backup: copy discovered legacy JSON files into data/legacy_json_backup_<timestamp>/
 * - archive: move migrated legacy JSON files into data/legacy_json_backup_<timestamp>/ (implies backup)
 * - silentIfDone: suppress logs when already migrated (for normal server boot)
 */
function migrateJsonToSqlite(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const dataDir = path.join(projectRoot, 'data');
  const resolvedDbPath = options.dbPath
    ? path.resolve(options.dbPath)
    : (options.projectRoot ? path.join(dataDir, 'ccnow.db') : getDbPath());

  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const archive = Boolean(options.archive);
  const backup = Boolean(options.backup || archive);
  const silentIfDone = Boolean(options.silentIfDone);

  const ownDb = !options.db;
  const db = options.db || (dryRun && !fs.existsSync(resolvedDbPath) ? null : (options.dbPath || options.projectRoot ? openDatabase(resolvedDbPath) : getDb()));

  const report = {
    projectRoot,
    dbPath: resolvedDbPath,
    dryRun,
    skipped: false,
    backupDir: null,
    counts: {
      users: 0,
      inviteCodes: 0,
      settings: 0,
      devices: 0,
      workspaces: 0,
      taskBoardTodos: 0,
      taskBoardCardMeta: 0,
      pushSubscriptions: 0,
      imBindingsKeys: 0,
      vapidMigrated: 0
    },
    warnings: [],
    migratedFiles: []
  };

  try {
    if (db && !force && isLegacyMigrationDone(db)) {
      report.skipped = true;
      if (!silentIfDone) {
        console.log('ℹ️ [Migration] Legacy JSON -> SQLite migration already completed. Use --force to re-import.');
      }
      return report;
    }

    const files = discoverLegacyFiles(projectRoot);
    const now = new Date().toISOString();

    // Collect all payloads first so dryRun and real run share identical parsing logic
    const parsedUsers = safeReadJSON(files.users);
    const parsedCodes = safeReadJSON(files.inviteCodes);
    const parsedSettings = safeReadJSON(files.settings);
    const parsedDevices = safeReadJSON(files.devices);
    const parsedSingleWs = safeReadJSON(files.singleWorkspaces);
    const parsedPushSubs = safeReadJSON(files.pushSubscriptions);
    const parsedImBindings = safeReadJSON(files.imBindings);

    const parsedUserWs = files.userWorkspaces.map(({ username, file }) => ({
      username,
      file,
      res: safeReadJSON(file)
    }));
    const parsedTaskBoards = files.taskBoards.map(({ username, file }) => ({
      username,
      file,
      res: safeReadJSON(file)
    }));

    // Track warnings for malformed files
    for (const [label, file, res] of [
      ['users.json', files.users, parsedUsers],
      ['invite_codes.json', files.inviteCodes, parsedCodes],
      ['settings.json', files.settings, parsedSettings],
      ['devices.json', files.devices, parsedDevices],
      ['workspaces.json', files.singleWorkspaces, parsedSingleWs],
      ['push_subscriptions.json', files.pushSubscriptions, parsedPushSubs],
      ['im_bindings.json', files.imBindings, parsedImBindings]
    ]) {
      if (res.error) report.warnings.push(`Failed to parse ${label}: ${res.error}`);
      if (res.exists && !res.error) report.migratedFiles.push(file);
    }
    for (const item of parsedUserWs) {
      if (item.res.error) report.warnings.push(`Failed to parse ${path.basename(item.file)}: ${item.res.error}`);
      if (item.res.exists && !item.res.error) report.migratedFiles.push(item.file);
    }
    for (const item of parsedTaskBoards) {
      if (item.res.error) report.warnings.push(`Failed to parse ${path.basename(item.file)}: ${item.res.error}`);
      if (item.res.exists && !item.res.error) report.migratedFiles.push(item.file);
    }

    // Count items for report
    const usersObj = (parsedUsers.data && typeof parsedUsers.data === 'object' && !Array.isArray(parsedUsers.data)) ? parsedUsers.data : {};
    const codesArr = Array.isArray(parsedCodes.data) ? parsedCodes.data : [];
    const settingsObj = (parsedSettings.data && typeof parsedSettings.data === 'object' && !Array.isArray(parsedSettings.data)) ? parsedSettings.data : {};
    const devicesArr = Array.isArray(parsedDevices.data) ? parsedDevices.data : [];
    const singleWsArr = Array.isArray(parsedSingleWs.data) ? parsedSingleWs.data : [];
    const pushSubsArr = Array.isArray(parsedPushSubs.data) ? parsedPushSubs.data : [];
    const imBindingsObj = (parsedImBindings.data && typeof parsedImBindings.data === 'object' && !Array.isArray(parsedImBindings.data)) ? parsedImBindings.data : null;

    report.counts.users = Object.keys(usersObj).length;
    report.counts.inviteCodes = codesArr.length;
    report.counts.settings = Object.keys(settingsObj).length;
    report.counts.devices = devicesArr.length;
    report.counts.workspaces = singleWsArr.length + parsedUserWs.reduce((acc, u) => acc + (Array.isArray(u.res.data) ? u.res.data.length : 0), 0);
    report.counts.taskBoardTodos = parsedTaskBoards.reduce((acc, tb) => acc + (Array.isArray(tb.res.data?.todos) ? tb.res.data.todos.length : 0), 0);
    report.counts.taskBoardCardMeta = parsedTaskBoards.reduce((acc, tb) => acc + (tb.res.data?.cardMeta && typeof tb.res.data.cardMeta === 'object' ? Object.keys(tb.res.data.cardMeta).length : 0), 0);
    report.counts.pushSubscriptions = pushSubsArr.filter(s => s && s.endpoint).length;
    report.counts.imBindingsKeys = imBindingsObj ? Object.keys(imBindingsObj).length : 0;

    const shouldMigrateVapid = fs.existsSync(files.vapidRoot) && !fs.existsSync(files.vapidData);
    if (shouldMigrateVapid) {
      report.counts.vapidMigrated = 1;
      report.migratedFiles.push(files.vapidRoot);
    }

    if (dryRun) {
      return report;
    }

    // Optional backup before writing/archiving
    if (backup && report.migratedFiles.length > 0) {
      const stamp = now.replace(/[:.]/g, '-');
      const backupDir = path.join(dataDir, `legacy_json_backup_${stamp}`);
      fs.mkdirSync(backupDir, { recursive: true });
      chownIfSudo(backupDir);
      for (const src of report.migratedFiles) {
        if (!fs.existsSync(src)) continue;
        const rel = path.relative(projectRoot, src).replace(/[\\/]/g, '__');
        const dst = path.join(backupDir, rel);
        fs.copyFileSync(src, dst);
        chownIfSudo(dst);
      }
      report.backupDir = backupDir;
    }

    // Perform atomic SQLite import
    withTransaction((conn) => {
      // 1. Users
      const upsertUser = conn.prepare(`
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
      for (const [key, u] of Object.entries(usersObj)) {
        if (!u || typeof u !== 'object') continue;
        const { username, passwordHash, role, apiKeys, createdAt, ...extra } = u;
        upsertUser.run(
          key.toLowerCase(),
          username || key,
          passwordHash || null,
          role || 'user',
          JSON.stringify(apiKeys || {}),
          JSON.stringify(extra || {}),
          createdAt || now,
          now
        );
      }

      // 2. Invite codes
      const upsertCode = conn.prepare(`
        INSERT INTO invite_codes (code, created_by, created_at, status, used_by, used_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          created_by = excluded.created_by,
          created_at = excluded.created_at,
          status = excluded.status,
          used_by = excluded.used_by,
          used_at = excluded.used_at,
          note = excluded.note
      `);
      for (const c of codesArr) {
        if (!c || !c.code) continue;
        upsertCode.run(
          String(c.code),
          c.createdBy || null,
          c.createdAt || now,
          c.status || 'pending',
          c.usedBy || null,
          c.usedAt || null,
          c.note || ''
        );
      }

      // 3. Settings
      const upsertSetting = conn.prepare(`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `);
      for (const [k, v] of Object.entries(settingsObj)) {
        upsertSetting.run(k, JSON.stringify(v), now);
      }

      // 4. Devices
      const upsertDevice = conn.prepare(`
        INSERT INTO devices (
          device_id, user_id, name, hostname, platform, arch, client_version,
          agent_types_json, device_kind, container_name, secret_hash, created_at, last_seen
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          user_id = excluded.user_id,
          name = excluded.name,
          hostname = excluded.hostname,
          platform = excluded.platform,
          arch = excluded.arch,
          client_version = excluded.client_version,
          agent_types_json = excluded.agent_types_json,
          device_kind = excluded.device_kind,
          container_name = excluded.container_name,
          secret_hash = excluded.secret_hash,
          last_seen = excluded.last_seen
      `);
      for (const d of devicesArr) {
        if (!d || !d.deviceId) continue;
        upsertDevice.run(
          String(d.deviceId),
          String(d.userId || 'admin'),
          String(d.name || d.hostname || 'My Device'),
          String(d.hostname || 'unknown-host'),
          String(d.platform || 'unknown'),
          String(d.arch || 'unknown'),
          String(d.clientVersion || '1.0.0'),
          JSON.stringify(Array.isArray(d.agentTypes) ? d.agentTypes : []),
          String(d.deviceKind || 'external'),
          d.containerName || null,
          String(d.secretHash || ''),
          Number(d.createdAt || Date.now()),
          Number(d.lastSeen || Date.now())
        );
      }

      // 5. Workspaces (single-user + per-user)
      const deleteScopeWs = conn.prepare('DELETE FROM workspaces WHERE scope = ?');
      const insertWs = conn.prepare(`
        INSERT INTO workspaces (scope, name, path, sort_order, extra_json)
        VALUES (?, ?, ?, ?, ?)
      `);

      const importWsList = (scope, list) => {
        if (!Array.isArray(list)) return;
        const existingCount = conn.prepare('SELECT COUNT(*) AS cnt FROM workspaces WHERE scope = ?').get(scope).cnt;
        if (existingCount > 0 && !force) return;
        deleteScopeWs.run(scope);
        list.forEach((w, idx) => {
          if (!w || !w.path) return;
          const { name, path: wsPath, ...extra } = w;
          insertWs.run(scope, name || path.basename(wsPath) || 'default', wsPath, idx, JSON.stringify(extra || {}));
        });
      };

      if (parsedSingleWs.exists && Array.isArray(parsedSingleWs.data)) {
        importWsList('__single__', parsedSingleWs.data);
      }
      for (const item of parsedUserWs) {
        if (item.res.exists && Array.isArray(item.res.data)) {
          importWsList(item.username, item.res.data);
        }
      }

      // 6. Task Boards
      const upsertTodo = conn.prepare(`
        INSERT INTO task_board_todos (
          id, username, title, description, workspace_name, workspace_path,
          agent_type, priority, extra_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          title = excluded.title,
          description = excluded.description,
          workspace_name = excluded.workspace_name,
          workspace_path = excluded.workspace_path,
          agent_type = excluded.agent_type,
          priority = excluded.priority,
          extra_json = excluded.extra_json,
          updated_at = excluded.updated_at
      `);
      const upsertCardMeta = conn.prepare(`
        INSERT INTO task_board_card_meta (username, session_name, custom_title, pinned, extra_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(username, session_name) DO UPDATE SET
          custom_title = excluded.custom_title,
          pinned = excluded.pinned,
          extra_json = excluded.extra_json,
          updated_at = excluded.updated_at
      `);

      for (const tb of parsedTaskBoards) {
        if (!tb.res.exists || !tb.res.data || typeof tb.res.data !== 'object') continue;
        const todos = Array.isArray(tb.res.data.todos) ? tb.res.data.todos : [];
        for (const t of todos) {
          if (!t || !t.id) continue;
          const { id, title, description, workspaceName, workspacePath, agentType, priority, createdAt, updatedAt, ...extra } = t;
          upsertTodo.run(
            String(id),
            tb.username,
            String(title || ''),
            String(description || ''),
            String(workspaceName || ''),
            String(workspacePath || ''),
            String(agentType || 'agy'),
            String(priority || 'medium'),
            JSON.stringify(extra || {}),
            createdAt || now,
            updatedAt || now
          );
        }
        const cardMeta = tb.res.data.cardMeta && typeof tb.res.data.cardMeta === 'object' ? tb.res.data.cardMeta : {};
        for (const [sessionName, meta] of Object.entries(cardMeta)) {
          if (!meta || typeof meta !== 'object') continue;
          const { customTitle, pinned, updatedAt, ...extra } = meta;
          upsertCardMeta.run(
            tb.username,
            sessionName,
            customTitle !== undefined ? String(customTitle) : null,
            pinned ? 1 : 0,
            JSON.stringify(extra || {}),
            updatedAt || now
          );
        }
      }

      // 7. Push Subscriptions
      const upsertSub = conn.prepare(`
        INSERT INTO push_subscriptions (endpoint, web_username, subscription_json, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          web_username = excluded.web_username,
          subscription_json = excluded.subscription_json
      `);
      for (const sub of pushSubsArr) {
        if (!sub || !sub.endpoint) continue;
        upsertSub.run(
          String(sub.endpoint),
          String(sub.webUsername || 'admin'),
          JSON.stringify(sub),
          now
        );
      }

      // 8. IM Bindings
      if (imBindingsObj) {
        const upsertIm = conn.prepare(`
          INSERT INTO im_bindings_kv (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `);
        const normalized = {
          telegram: Array.isArray(imBindingsObj.telegram) ? imBindingsObj.telegram : [],
          feishu: Array.isArray(imBindingsObj.feishu) ? imBindingsObj.feishu : [],
          wechat: Array.isArray(imBindingsObj.wechat) ? imBindingsObj.wechat : [],
          activeSessions: (imBindingsObj.activeSessions && typeof imBindingsObj.activeSessions === 'object') ? imBindingsObj.activeSessions : {}
        };
        // Also ensure legacy telegram/wechat bindings have webUsername='admin'
        normalized.telegram.forEach(u => { if (u && !u.webUsername) u.webUsername = 'admin'; });
        normalized.wechat.forEach(u => { if (u && !u.webUsername) u.webUsername = 'admin'; });

        for (const [k, v] of Object.entries(normalized)) {
          upsertIm.run(k, JSON.stringify(v), now);
        }
      }

      // Mark migration complete
      conn.prepare(`
        INSERT INTO migration_meta (key, value, applied_at)
        VALUES (?, 'done', ?)
        ON CONFLICT(key) DO UPDATE SET value = 'done', applied_at = excluded.applied_at
      `).run(MIGRATION_DONE_KEY, now);
    }, db);

    // 9. Consolidate vapid.json -> data/vapid.json (keep 0600 permissions)
    if (shouldMigrateVapid) {
      const vapidRes = safeReadJSON(files.vapidRoot);
      if (vapidRes.data && vapidRes.data.publicKey && vapidRes.data.privateKey) {
        atomicWriteJSON(files.vapidData, vapidRes.data, { mode: 0o600 });
      }
    }

    // 10. Optional archive: remove originals ONLY after backup + successful SQLite commit
    if (archive && report.backupDir) {
      for (const src of report.migratedFiles) {
        if (fs.existsSync(src)) {
          try {
            fs.unlinkSync(src);
          } catch (err) {
            report.warnings.push(`Could not remove archived source ${src}: ${err.message}`);
          }
        }
      }
    }

    return report;
  } finally {
    if (ownDb && db && (options.dbPath || options.projectRoot)) {
      try { db.close(); } catch (_) {}
    }
  }
}

module.exports = {
  migrateJsonToSqlite,
  discoverLegacyFiles,
  MIGRATION_DONE_KEY
};
