const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runTests() {
  console.log('🧪 Starting SQLite Storage & Migration unit tests...');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnow-storage-test-'));
  const tmpData = path.join(tmpRoot, 'data');
  const tmpDb = path.join(tmpData, 'ccnow.db');
  fs.mkdirSync(tmpData, { recursive: true });

  // Point sqliteService singleton at isolated temp DB
  process.env.CCNOW_DB_PATH = tmpDb;

  const { openDatabase, closeDb, atomicWriteJSON } = require('../services/sqliteService');
  const { migrateJsonToSqlite } = require('../services/storageMigration');
  const dbService = require('../services/dbService');
  const deviceService = require('../services/deviceService');
  const fileService = require('../services/fileService');
  const projectService = require('../services/projectService');

  try {
    // 1. Seed synthetic legacy JSON files in tmpRoot
    fs.writeFileSync(path.join(tmpData, 'users.json'), JSON.stringify({
      admin: {
        username: 'admin',
        passwordHash: dbService.hashPassword('secret123'),
        role: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
        apiKeys: { claude: 'sk-test-claude' }
      }
    }, null, 2));

    fs.writeFileSync(path.join(tmpData, 'invite_codes.json'), JSON.stringify([
      {
        code: 'INV-TEST0001',
        createdBy: 'admin',
        createdAt: '2026-01-02T00:00:00.000Z',
        status: 'pending',
        usedBy: null,
        usedAt: null,
        note: 'unit test'
      }
    ], null, 2));

    fs.writeFileSync(path.join(tmpData, 'settings.json'), JSON.stringify({
      enabledAgents: ['default', 'claude', 'codex'],
      appIcon: 'cyber-grid',
      claudeOAuthMode: true
    }, null, 2));

    fs.writeFileSync(path.join(tmpData, 'devices.json'), JSON.stringify([
      {
        deviceId: 'dev_legacy01',
        userId: 'admin',
        name: 'MacBook Pro',
        hostname: 'mbp.local',
        platform: 'darwin',
        arch: 'arm64',
        clientVersion: '1.5.0',
        agentTypes: ['claude-code', 'tmux'],
        deviceKind: 'external',
        containerName: null,
        secretHash: 'abc123',
        createdAt: 1700000000000,
        lastSeen: 1700000001000
      }
    ], null, 2));

    fs.writeFileSync(path.join(tmpRoot, 'workspaces.json'), JSON.stringify([
      { name: 'single-ws', path: '/tmp/single-ws' }
    ], null, 2));

    fs.writeFileSync(path.join(tmpData, 'workspaces_admin.json'), JSON.stringify([
      { name: 'deck', path: '/tmp/deck' },
      { name: 'blog', path: '/tmp/blog' }
    ], null, 2));

    fs.writeFileSync(path.join(tmpData, 'task_board_admin.json'), JSON.stringify({
      todos: [
        {
          id: 'todo-1',
          title: 'Migrate to SQLite',
          description: 'Use node:sqlite',
          workspaceName: 'deck',
          workspacePath: '/tmp/deck',
          agentType: 'claude',
          priority: 'high',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z'
        }
      ],
      cardMeta: {
        u_admin_claude: { customTitle: 'Main Agent', pinned: true, updatedAt: '2026-01-03T00:00:00.000Z' }
      }
    }, null, 2));

    fs.writeFileSync(path.join(tmpRoot, 'push_subscriptions.json'), JSON.stringify([
      { endpoint: 'https://push.example.com/sub1', keys: { p256dh: 'k1', auth: 'a1' }, webUsername: 'admin' }
    ], null, 2));

    fs.writeFileSync(path.join(tmpRoot, 'im_bindings.json'), JSON.stringify({
      telegram: [{ chatId: '12345', username: 'alice_tg' }],
      feishu: [],
      wechat: [],
      activeSessions: { '12345': 'u_admin_claude' }
    }, null, 2));

    fs.writeFileSync(path.join(tmpRoot, 'vapid.json'), JSON.stringify({
      publicKey: 'pub-test',
      privateKey: 'priv-test'
    }, null, 2));

    // 2. Test dry-run does not create DB
    const dryReport = migrateJsonToSqlite({ projectRoot: tmpRoot, dbPath: tmpDb, dryRun: true });
    assert.strictEqual(dryReport.dryRun, true);
    assert.strictEqual(dryReport.counts.users, 1);
    assert.strictEqual(dryReport.counts.inviteCodes, 1);
    assert.strictEqual(dryReport.counts.devices, 1);
    assert.strictEqual(dryReport.counts.workspaces, 3);
    assert.strictEqual(dryReport.counts.taskBoardTodos, 1);
    assert.strictEqual(dryReport.counts.taskBoardCardMeta, 1);
    assert.strictEqual(dryReport.counts.pushSubscriptions, 1);
    assert.strictEqual(dryReport.counts.vapidMigrated, 1);
    assert.strictEqual(fs.existsSync(tmpDb), false, 'dry-run must not create DB file');
    console.log('✅ Dry-run migration preview verified!');

    // 3. Test real migration with backup
    const report = migrateJsonToSqlite({ projectRoot: tmpRoot, dbPath: tmpDb, backup: true });
    assert.strictEqual(report.skipped, false);
    assert.strictEqual(fs.existsSync(tmpDb), true, 'DB file must be created');
    assert.strictEqual(fs.existsSync(path.join(tmpData, 'vapid.json')), true, 'data/vapid.json must be created');
    assert.ok(report.backupDir && fs.existsSync(report.backupDir), 'backupDir must exist');
    console.log('✅ Real JSON -> SQLite migration + backup verified!');

    // 4. Test idempotency (second run skips)
    const secondReport = migrateJsonToSqlite({ projectRoot: tmpRoot, dbPath: tmpDb, silentIfDone: true });
    assert.strictEqual(secondReport.skipped, true, 'second run without --force should skip');
    console.log('✅ Migration idempotency verified!');

    // 5. Verify dbService reads migrated data & atomic invite redemption
    const users = dbService.getUsers();
    assert.strictEqual(users.admin.username, 'admin');
    assert.strictEqual(users.admin.apiKeys.claude, 'sk-test-claude');
    assert.strictEqual(dbService.verifyPassword('secret123', users.admin.passwordHash), true);

    const settings = dbService.getSettings();
    assert.strictEqual(settings.appIcon, 'cyber-grid');
    assert.strictEqual(settings.claudeOAuthMode, true);

    const regOk = dbService.registerUserWithInviteCode({
      code: 'INV-TEST0001',
      username: 'Alice',
      password: 'password123'
    });
    assert.strictEqual(regOk.ok, true);

    // Second redemption with same code must fail atomically
    const regDup = dbService.registerUserWithInviteCode({
      code: 'INV-TEST0001',
      username: 'Bob',
      password: 'password123'
    });
    assert.strictEqual(regDup.ok, false);
    assert.ok(dbService.getUsers().alice, 'new user alice should exist');
    console.log('✅ dbService CRUD & atomic invite redemption verified!');

    // 6. Verify deviceService CRUD
    const migratedDev = deviceService.getDeviceById('dev_legacy01');
    assert.ok(migratedDev && migratedDev.name === 'MacBook Pro');
    const createdDev = deviceService.registerDevice('alice', { name: 'Alice Laptop', platform: 'linux' });
    assert.ok(deviceService.authenticateDevice(createdDev.deviceId, createdDev.deviceSecret));
    assert.strictEqual(deviceService.authenticateDevice(createdDev.deviceId, 'wrong'), null);
    assert.strictEqual(deviceService.updateDeviceInfo(createdDev.deviceId, { version: '2.0.0' }), true);
    assert.strictEqual(deviceService.getDeviceById(createdDev.deviceId).clientVersion, '2.0.0');
    const managed = deviceService.ensureManagedDevice('alice', { deviceKind: 'docker-sandbox', containerName: 'ccnow-sandbox-alice' });
    assert.strictEqual(managed.created, true);
    const managedAgain = deviceService.ensureManagedDevice('alice', { deviceKind: 'docker-sandbox', containerName: 'ccnow-sandbox-alice' });
    assert.strictEqual(managedAgain.created, false);
    assert.strictEqual(managedAgain.deviceId, managed.deviceId);
    const newSecret = deviceService.rotateManagedDeviceSecret(managed.deviceId);
    assert.ok(deviceService.authenticateDevice(managed.deviceId, newSecret));
    assert.strictEqual(deviceService.removeDevice('alice', createdDev.deviceId), true);
    assert.strictEqual(deviceService.getDeviceById(createdDev.deviceId), null);
    console.log('✅ deviceService SQLite CRUD verified!');

    // 7. Verify workspaces & task board CRUD
    const adminWs = fileService.readWorkspaces('admin');
    assert.strictEqual(adminWs.length >= 1, true);

    const tbBefore = projectService.readTaskBoardStore('admin');
    assert.strictEqual(tbBefore.todos.length, 1);
    assert.strictEqual(tbBefore.cardMeta.u_admin_claude.pinned, true);

    const { todo: addedTodo } = projectService.upsertTodoItem('admin', { title: 'Second Task', priority: 'low' });
    assert.ok(addedTodo.id);
    projectService.updateCardMeta('admin', 'u_admin_claude', { customTitle: 'Updated Agent', pinned: true });
    const tbAfter = projectService.readTaskBoardStore('admin');
    assert.strictEqual(tbAfter.todos.length, 2);
    assert.strictEqual(tbAfter.cardMeta.u_admin_claude.customTitle, 'Updated Agent');
    projectService.deleteTodoItem('admin', addedTodo.id);
    assert.strictEqual(projectService.readTaskBoardStore('admin').todos.length, 1);
    console.log('✅ projectService task board SQLite CRUD verified!');

    // 8. Verify push_subscriptions & im_bindings in DB
    const conn = openDatabase(tmpDb);
    const subCnt = conn.prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions').get().cnt;
    assert.strictEqual(subCnt, 1);
    const tgRow = conn.prepare('SELECT value_json FROM im_bindings_kv WHERE key = ?').get('telegram');
    const tgList = JSON.parse(tgRow.value_json);
    assert.strictEqual(tgList[0].webUsername, 'admin', 'legacy telegram binding should default webUsername to admin');
    conn.close();
    console.log('✅ push_subscriptions & im_bindings SQLite migration verified!');

    // 9. Verify atomicWriteJSON
    const atomicTarget = path.join(tmpData, 'atomic_test.json');
    atomicWriteJSON(atomicTarget, { hello: 'world' }, { mode: 0o600 });
    const parsed = JSON.parse(fs.readFileSync(atomicTarget, 'utf8'));
    assert.strictEqual(parsed.hello, 'world');
    console.log('✅ atomicWriteJSON verified!');

    console.log('\n🎉 All SQLite storage & migration tests passed!');
  } finally {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests();
