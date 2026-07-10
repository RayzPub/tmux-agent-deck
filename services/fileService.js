const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('../config');
const { getRunUser } = require('./tmuxService');

const WORKSPACES_FILE = path.join(PROJECT_ROOT, 'workspaces.json');

const getHomeDir = () => {
  const runUser = getRunUser();
  if (runUser) {
    return `/home/${runUser}`;
  }
  return process.env.HOME || require('os').homedir();
};

const resolveWorkspacePath = (p) => {
  if (!p) return '';
  let resolved = p;
  if (p.startsWith('~/') || p === '~') {
    resolved = p.replace('~', getHomeDir());
  }
  return path.resolve(resolved);
};

const readWorkspaces = () => {
  try {
    if (fs.existsSync(WORKSPACES_FILE)) {
      return JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading workspaces file:', err);
  }
  return [];
};

const writeWorkspaces = (workspaces) => {
  try {
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing workspaces file:', err);
    return false;
  }
};

const safeResolve = (workspacePath, reqPath) => {
  const root = workspacePath ? resolveWorkspacePath(workspacePath) : PROJECT_ROOT;
  const resolved = path.resolve(root, reqPath || '.');
  const relative = path.relative(root, resolved);
  const isSafe = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!isSafe) {
    throw new Error('Access denied: Out of workspace root');
  }
  return resolved;
};

module.exports = {
  PROJECT_ROOT,
  WORKSPACES_FILE,
  getHomeDir,
  resolveWorkspacePath,
  readWorkspaces,
  writeWorkspaces,
  safeResolve
};
