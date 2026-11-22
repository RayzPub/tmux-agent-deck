const path = require('path');
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { resolveBaseDir } = require('./config');

async function handleGitStatus(send, reqId, workspacePath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    let gitRoot = '';
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: baseDir, encoding: 'utf8' });
      gitRoot = (stdout || '').trim();
    } catch (_) {
      return send({ action: 'git:status_result', reqId, isGit: false, branch: '', clean: true, files: [] });
    }
    const [branchRes, statusRes] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], { cwd: baseDir, encoding: 'utf8' }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain', '-u', '--', '.'], { cwd: baseDir, encoding: 'utf8' }).catch(() => ({ stdout: '' }))
    ]);
    const branch = (branchRes.stdout || '').trim();
    const statusOut = statusRes.stdout || '';
    const files = [];
    for (const line of statusOut.split('\n')) {
      if (!line.trim()) continue;
      const code = line.substring(0, 2);
      let filePath = line.substring(3).trim();
      let renameFrom = null;
      if (code.startsWith('R') || code.endsWith('R')) {
        const parts = filePath.split(' -> ');
        if (parts.length === 2) {
          renameFrom = parts[0];
          filePath = parts[1];
        }
      }
      if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
      if (renameFrom && renameFrom.startsWith('"') && renameFrom.endsWith('"')) renameFrom = renameFrom.slice(1, -1);
      const fullPath = path.resolve(gitRoot, filePath);
      const relToWorkspace = path.relative(baseDir, fullPath);
      if (relToWorkspace.startsWith('..') || path.isAbsolute(relToWorkspace)) continue;
      let relRenameFrom = null;
      if (renameFrom) {
        relRenameFrom = path.relative(baseDir, path.resolve(gitRoot, renameFrom));
      }
      files.push({
        path: relToWorkspace,
        status: code.trim(),
        index: code[0],
        worktree: code[1],
        renameFrom: relRenameFrom
      });
    }
    send({ action: 'git:status_result', reqId, isGit: true, branch, clean: files.length === 0, files });
  } catch (e) {
    send({ action: 'git:status_result', reqId, isGit: false, branch: '', clean: true, files: [] });
  }
}

function handleGitDiff(send, reqId, workspacePath, filePath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const fileArg = filePath ? ` -- "${filePath.replace(/"/g, '')}"` : '';
    const diff = execSync(`git diff HEAD${fileArg} 2>/dev/null || git diff${fileArg} 2>/dev/null || echo ""`, { cwd: baseDir, encoding: 'utf8' });
    send({ action: 'git:diff_result', reqId, diff });
  } catch (e) {
    send({ action: 'git:diff_result', reqId, diff: '' });
  }
}

function handleGitStage(send, reqId, workspacePath, files) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const fileArgs = Array.isArray(files) && files.length > 0
      ? files.map(f => `"${String(f).replace(/"/g, '')}"`).join(' ')
      : '.';
    execSync(`git add ${fileArgs}`, { cwd: baseDir, stdio: 'ignore' });
    send({ action: 'git:stage_result', reqId, success: true });
  } catch (e) {
    send({ action: 'git:stage_result', reqId, error: e.message });
  }
}

function handleGitUnstage(send, reqId, workspacePath, files) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const fileArgs = Array.isArray(files) && files.length > 0
      ? files.map(f => `"${String(f).replace(/"/g, '')}"`).join(' ')
      : '.';
    execSync(`git reset HEAD ${fileArgs}`, { cwd: baseDir, stdio: 'ignore' });
    send({ action: 'git:unstage_result', reqId, success: true });
  } catch (e) {
    send({ action: 'git:unstage_result', reqId, error: e.message });
  }
}

function handleGitCommit(send, reqId, workspacePath, message) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const cleanMsg = (message || 'Commit from ccnow').replace(/"/g, '\\"');
    execSync(`git commit -m "${cleanMsg}"`, { cwd: baseDir, stdio: 'ignore' });
    send({ action: 'git:commit_result', reqId, success: true });
  } catch (e) {
    send({ action: 'git:commit_result', reqId, error: e.message });
  }
}

function handleGitBranches(send, reqId, workspacePath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const out = execSync('git branch 2>/dev/null || echo ""', { cwd: baseDir, encoding: 'utf8' });
    const lines = out.split('\n').filter(Boolean);
    let currentBranch = '';
    const branches = [];
    for (const line of lines) {
      const isCurrent = line.startsWith('*');
      const bName = line.replace(/^\*?\s+/, '').trim();
      if (bName) {
        branches.push(bName);
        if (isCurrent) currentBranch = bName;
      }
    }
    send({ action: 'git:branches_result', reqId, currentBranch, branches });
  } catch (e) {
    send({ action: 'git:branches_result', reqId, currentBranch: '', branches: [] });
  }
}

function handleGitCheckout(send, reqId, workspacePath, branch) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const cleanBranch = String(branch).replace(/[^a-zA-Z0-9_\-\.\/]/g, '');
    execSync(`git checkout "${cleanBranch}"`, { cwd: baseDir, stdio: 'ignore' });
    send({ action: 'git:checkout_result', reqId, success: true });
  } catch (e) {
    send({ action: 'git:checkout_result', reqId, error: e.message });
  }
}

module.exports = {
  handleGitStatus,
  handleGitDiff,
  handleGitStage,
  handleGitUnstage,
  handleGitCommit,
  handleGitBranches,
  handleGitCheckout
};
