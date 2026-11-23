const os = require('os');
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, WORKSPACES_FILE, resolveBaseDir, safeResolve } = require('./config');

function readCustomWorkspaces() {
  try {
    if (fs.existsSync(WORKSPACES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object') {
        return Object.entries(raw).map(([name, wsPath]) => ({ name, path: wsPath }));
      }
    }
  } catch (e) {}
  return [];
}

function writeCustomWorkspaces(list) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function handleFsWorkspaces(send, reqId) {
  const defaults = [
    { name: 'Home (~)', path: os.homedir(), isDefault: true }
  ];
  const custom = readCustomWorkspaces();
  const seenPaths = new Set(defaults.map(w => w.path));
  const merged = [...defaults];
  for (const ws of custom) {
    if (ws && ws.path && !seenPaths.has(ws.path)) {
      seenPaths.add(ws.path);
      merged.push(ws);
    }
  }
  send({ action: 'fs:workspaces_result', reqId, workspaces: merged });
}

function handleFsAddWorkspace(send, reqId, msg) {
  try {
    const { name, path: wsPath } = msg;
    if (!name || !String(name).trim()) {
      return send({ action: 'fs:add_workspace_result', reqId, error: 'Workspace name is required.' });
    }
    const trimmedName = String(name).trim();
    const rawPath = (wsPath && String(wsPath).trim()) ? String(wsPath).trim() : path.join(os.homedir(), trimmedName);
    const resolvedPath = rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.substring(2))
      : (rawPath === '~' ? os.homedir() : path.resolve(rawPath));

    if (!fs.existsSync(resolvedPath)) {
      fs.mkdirSync(resolvedPath, { recursive: true });
    }

    const custom = readCustomWorkspaces();
    const exists = custom.find(w => w.name.toLowerCase() === trimmedName.toLowerCase() || w.path === resolvedPath);
    if (exists) {
      return send({ action: 'fs:add_workspace_result', reqId, error: 'Workspace with this name or path already exists.' });
    }

    const newWs = { name: trimmedName, path: resolvedPath };
    custom.push(newWs);
    writeCustomWorkspaces(custom);
    send({ action: 'fs:add_workspace_result', reqId, success: true, workspace: newWs });
  } catch (e) {
    send({ action: 'fs:add_workspace_result', reqId, error: e.message });
  }
}

function handleFsRemoveWorkspace(send, reqId, msg) {
  try {
    const { name } = msg;
    if (!name) {
      return send({ action: 'fs:remove_workspace_result', reqId, error: 'Workspace name is required.' });
    }
    const custom = readCustomWorkspaces();
    const filtered = custom.filter(w => w.name.toLowerCase() !== String(name).toLowerCase());
    if (filtered.length === custom.length) {
      return send({ action: 'fs:remove_workspace_result', reqId, error: 'Workspace not found (built-in workspaces cannot be removed).' });
    }
    writeCustomWorkspaces(filtered);
    send({ action: 'fs:remove_workspace_result', reqId, success: true });
  } catch (e) {
    send({ action: 'fs:remove_workspace_result', reqId, error: e.message });
  }
}

function handleFsList(send, reqId, workspacePath, relativePath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const targetDir = relativePath ? safeResolve(baseDir, relativePath) : baseDir;

    if (!fs.existsSync(targetDir)) {
      return send({ action: 'fs:list_result', reqId, error: 'Directory not found' });
    }

    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return send({ action: 'fs:list_result', reqId, error: 'Target is not a directory' });
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const items = entries
      .filter(e => e.name !== '.git' && e.name !== 'node_modules' && e.name !== '.claude' && e.name !== '.codex' && !e.name.startsWith('.DS_Store'))
      .map(e => {
        const fullPath = path.join(targetDir, e.name);
        const relPath = path.relative(baseDir, fullPath);
        const isDir = e.isDirectory();
        let size = null;
        let mtime = null;
        try {
          const s = fs.statSync(fullPath);
          size = isDir ? null : s.size;
          mtime = s.mtime.toISOString();
        } catch (err) {}

        return {
          name: e.name,
          path: relPath,
          isDir,
          isDirectory: isDir,
          size,
          mtime
        };
      });

    items.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    send({ action: 'fs:list_result', reqId, rootDir: baseDir, items });
  } catch (err) {
    send({ action: 'fs:list_result', reqId, error: err.message });
  }
}

function handleFsRead(send, reqId, workspacePath, filePath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const targetPath = safeResolve(baseDir, filePath);

    if (!fs.existsSync(targetPath)) {
      return send({ action: 'fs:read_result', reqId, error: 'File not found' });
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return send({ action: 'fs:read_result', reqId, error: 'Path is not a file' });
    }

    if (stat.size > 2 * 1024 * 1024) {
      return send({ action: 'fs:read_result', reqId, error: 'File is too large (>2MB)' });
    }

    const content = fs.readFileSync(targetPath, 'utf8');
    send({ action: 'fs:read_result', reqId, path: filePath, content, size: stat.size });
  } catch (err) {
    send({ action: 'fs:read_result', reqId, error: err.message });
  }
}

function handleFsWrite(send, reqId, workspacePath, filePath, content) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const targetPath = safeResolve(baseDir, filePath);
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(targetPath, content || '', 'utf8');
    send({ action: 'fs:write_result', reqId, success: true });
  } catch (err) {
    send({ action: 'fs:write_result', reqId, error: err.message });
  }
}

function handleFsCreateFile(send, reqId, workspacePath, filePath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const targetPath = safeResolve(baseDir, filePath);
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, '', 'utf8');
    }
    send({ action: 'fs:create_file_result', reqId, success: true });
  } catch (e) {
    send({ action: 'fs:create_file_result', reqId, error: e.message });
  }
}

function handleFsCreateDir(send, reqId, workspacePath, dirPath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const targetPath = safeResolve(baseDir, dirPath);
    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }
    send({ action: 'fs:create_dir_result', reqId, success: true });
  } catch (e) {
    send({ action: 'fs:create_dir_result', reqId, error: e.message });
  }
}

function handleFsDelete(send, reqId, workspacePath, targetPath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const fullPath = safeResolve(baseDir, targetPath);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
    send({ action: 'fs:delete_result', reqId, success: true });
  } catch (e) {
    send({ action: 'fs:delete_result', reqId, error: e.message });
  }
}

function handleFsRename(send, reqId, workspacePath, oldPath, newPath) {
  try {
    const baseDir = resolveBaseDir(workspacePath);
    const src = safeResolve(baseDir, oldPath);
    const dst = safeResolve(baseDir, newPath);
    const dstParent = path.dirname(dst);
    if (!fs.existsSync(dstParent)) {
      fs.mkdirSync(dstParent, { recursive: true });
    }
    fs.renameSync(src, dst);
    send({ action: 'fs:rename_result', reqId, success: true });
  } catch (e) {
    send({ action: 'fs:rename_result', reqId, error: e.message });
  }
}

function handleDirectories(send, reqId, targetPath) {
  try {
    const baseDir = resolveBaseDir(targetPath);
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(baseDir, e.name) }));
    send({ action: 'fs:directories_result', reqId, currentPath: baseDir, directories: dirs });
  } catch (e) {
    send({ action: 'fs:directories_result', reqId, error: e.message });
  }
}

function handleUploadFile(send, reqId, msg) {
  try {
    const { workspacePath, filename, bufferBase64 } = msg;
    const baseDir = resolveBaseDir(workspacePath);
    const targetPath = safeResolve(baseDir, filename);
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const buf = Buffer.from(bufferBase64, 'base64');
    fs.writeFileSync(targetPath, buf);
    send({ action: 'fs:upload_file_result', reqId, success: true });
  } catch (e) {
    send({ action: 'fs:upload_file_result', reqId, error: e.message });
  }
}

module.exports = {
  readCustomWorkspaces,
  writeCustomWorkspaces,
  handleFsWorkspaces,
  handleFsAddWorkspace,
  handleFsRemoveWorkspace,
  handleFsList,
  handleFsRead,
  handleFsWrite,
  handleFsCreateFile,
  handleFsCreateDir,
  handleFsDelete,
  handleFsRename,
  handleDirectories,
  handleUploadFile
};
