const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runTests() {
  console.log('🧪 Starting Session Meta, Auto-Increment ID & Auto-Summary unit tests...');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnow-session-meta-test-'));
  const tmpDb = path.join(tmpRoot, 'ccnow.db');
  process.env.CCNOW_DB_PATH = tmpDb;

  const { closeDb } = require('../services/sqliteService');
  const sessionMetaService = require('../services/sessionMetaService');

  try {
    // 1. Strictly monotonic auto-incrementing sequence IDs
    const s1 = sessionMetaService.allocateNextSessionSeq();
    const s2 = sessionMetaService.allocateNextSessionSeq();
    const s3 = sessionMetaService.allocateNextSessionSeq();
    assert.strictEqual(s1, 1);
    assert.strictEqual(s2, 2);
    assert.strictEqual(s3, 3);

    // 2. Collision-free ID generation for tmux & OAR + custom prefix
    assert.strictEqual(
      sessionMetaService.buildAutoSessionId({ agentType: 'agy', sessionMode: 'hybrid', seqId: 1 }),
      'agy-1'
    );
    assert.strictEqual(
      sessionMetaService.buildAutoSessionId({ agentType: 'claude', sessionMode: 'chat_only', seqId: 2 }),
      'oar-claude-2'
    );
    assert.strictEqual(
      sessionMetaService.buildAutoSessionId({ agentType: 'default', sessionMode: 'terminal_only', seqId: 3 }),
      'shell-3'
    );
    assert.strictEqual(
      sessionMetaService.buildAutoSessionId({ agentType: 'codex', sessionMode: 'chat_only', seqId: 4, customPrefix: 'team' }),
      'team-4'
    );

    // 3. Heuristic prompt summarization
    assert.strictEqual(
      sessionMetaService.summarizePromptHeuristically('请帮我优化一下新建会话的表单样式'),
      '优化一下新建会话的表单样式'
    );
    assert.strictEqual(
      sessionMetaService.summarizePromptHeuristically('/clear'),
      ''
    );
    assert.strictEqual(
      sessionMetaService.summarizePromptHeuristically('[图片附件]'),
      ''
    );
    assert.strictEqual(
      sessionMetaService.summarizePromptHeuristically('帮我排查登录接口 500 错误\n\n[附带文件]:\n- logs/err.log'),
      '排查登录接口 500 错误'
    );
    const longSummary = sessionMetaService.summarizePromptHeuristically(
      '帮我设计一个完整的多租户分布式任务调度系统，并且支持动态扩容与故障自愈以及实时监控大盘'
    );
    assert.ok(longSummary.length > 0 && longSummary.endsWith('…'), `Expected truncated summary, got: ${longSummary}`);

    // 4. Auto-summary lifecycle & manual rename preservation
    const devId = 'dev_test01';
    sessionMetaService.upsertSessionMeta(devId, 'oar-agy-1', {
      seqId: 1,
      username: 'admin',
      title: '',
      autoTitle: true,
      titleSource: 'auto_pending',
      agentType: 'agy',
      sessionMode: 'chat_only'
    });

    const initialMeta = sessionMetaService.getSessionMeta(devId, 'oar-agy-1');
    assert.strictEqual(
      sessionMetaService.getDisplayTitleForSession('oar-agy-1', initialMeta),
      'Antigravity #1'
    );

    // Slash command should NOT trigger summary
    const skipped = sessionMetaService.maybeAutoSummarizeTitle(devId, 'oar-agy-1', '/compact');
    assert.strictEqual(skipped, null);

    // Real first prompt triggers instant heuristic title
    const updated = sessionMetaService.maybeAutoSummarizeTitle(devId, 'oar-agy-1', '请帮我重构用户权限中间件并补充单测');
    assert.ok(updated);
    assert.strictEqual(updated.titleSource, 'auto_heuristic');
    assert.ok(updated.title.includes('重构用户权限中间件'));

    // Subsequent prompt must NOT overwrite already summarized title
    const secondTry = sessionMetaService.maybeAutoSummarizeTitle(devId, 'oar-agy-1', '第二个问题不应该覆盖标题');
    assert.strictEqual(secondTry, null);

    // Manual rename overrides and disables autoTitle
    const manual = sessionMetaService.updateSessionTitle(devId, 'oar-agy-1', '权限中间件重构', {
      autoTitle: false,
      source: 'manual'
    });
    assert.strictEqual(manual.title, '权限中间件重构');
    assert.strictEqual(manual.autoTitle, false);
    assert.strictEqual(manual.titleSource, 'manual');

    // Deletion removes meta row but never resets monotonic sequence
    sessionMetaService.deleteSessionMeta(devId, 'oar-agy-1');
    assert.strictEqual(sessionMetaService.getSessionMeta(devId, 'oar-agy-1'), null);
    const s4 = sessionMetaService.allocateNextSessionSeq();
    assert.strictEqual(s4, 4);

    console.log('✅ All Session Meta & Auto-Summary unit tests passed!');
  } finally {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests();
