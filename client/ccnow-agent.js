#!/usr/bin/env node
// ccnow-agent CLIENT_VERSION = '1.7.5'
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// client/src/config.js
var require_config = __commonJS({
  "client/src/config.js"(exports2, module2) {
    var os = require("os");
    var fs2 = require("fs");
    var path2 = require("path");
    var { execSync, execFileSync } = require("child_process");
    var CLIENT_VERSION2 = "1.7.5";
    var CONFIG_DIR2 = process.env.CCNOW_CONFIG_DIR || path2.join(os.homedir(), ".ccnow");
    var CONFIG_FILE2 = path2.join(CONFIG_DIR2, "device.json");
    var WORKSPACES_FILE2 = path2.join(CONFIG_DIR2, "workspaces.json");
    var TMUX_SOCKET = process.env.CCNOW_TMUX_SOCKET || "";
    function tmuxArgs(args) {
      return TMUX_SOCKET ? ["-S", TMUX_SOCKET, ...args] : args;
    }
    function readConfig2() {
      try {
        if (fs2.existsSync(CONFIG_FILE2)) {
          return JSON.parse(fs2.readFileSync(CONFIG_FILE2, "utf8"));
        }
      } catch (err) {
        console.error("\u26A0\uFE0F Failed to read config file:", err.message);
      }
      return null;
    }
    function saveConfig(cfg) {
      try {
        if (!fs2.existsSync(CONFIG_DIR2)) {
          fs2.mkdirSync(CONFIG_DIR2, { recursive: true });
        }
        fs2.writeFileSync(CONFIG_FILE2, JSON.stringify(cfg, null, 2), "utf8");
      } catch (err) {
        console.error("\u274C Failed to save config file:", err.message);
      }
    }
    var BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["daemon", "background", "foreground"]);
    function parseArgs2(args) {
      const result = { command: args[0] || "help", options: {} };
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
          const parts = arg.slice(2).split("=");
          const key = parts[0];
          let val;
          if (parts.length > 1) {
            val = parts.slice(1).join("=");
          } else if (BOOLEAN_FLAGS.has(key)) {
            val = true;
          } else {
            val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
          }
          result.options[key] = val;
        }
      }
      return result;
    }
    var commandCache = /* @__PURE__ */ new Map();
    function hasCommand(cmd) {
      if (commandCache.has(cmd)) {
        return commandCache.get(cmd);
      }
      try {
        execSync(`which ${cmd}`, { stdio: "ignore" });
        commandCache.set(cmd, true);
        return true;
      } catch (e) {
        commandCache.set(cmd, false);
        return false;
      }
    }
    function getLocalDeviceInfo(customName) {
      const hasClaude = hasCommand("claude");
      const hasCodex = hasCommand("codex");
      const hasAgy = hasCommand("agy");
      const hasKimi = hasCommand("kimi");
      const hasTmux = hasCommand("tmux");
      const agentTypes = [];
      if (hasClaude) agentTypes.push("claude-code");
      if (hasCodex) agentTypes.push("codex-cli");
      if (hasAgy) agentTypes.push("agy");
      if (hasKimi) agentTypes.push("kimi");
      if (hasTmux) agentTypes.push("tmux");
      agentTypes.push("local-terminal");
      return {
        version: CLIENT_VERSION2,
        nodeVersion: process.version,
        name: customName || os.hostname(),
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        agentTypes,
        hasClaude,
        hasCodex,
        hasAgy,
        hasKimi,
        hasTmux
      };
    }
    function toWsUrl(serverUrl) {
      let base = serverUrl.trim().replace(/\/+$/, "");
      if (base.startsWith("https://")) {
        base = "wss://" + base.substring(8);
      } else if (base.startsWith("http://")) {
        base = "ws://" + base.substring(7);
      } else if (!base.startsWith("ws://") && !base.startsWith("wss://")) {
        base = "wss://" + base;
      }
      return `${base}/device-tunnel`;
    }
    function resolveBaseDir(wsPath) {
      if (!wsPath || wsPath === "~") return os.homedir();
      if (wsPath.startsWith("~/")) return path2.join(os.homedir(), wsPath.substring(2));
      if (path2.isAbsolute(wsPath) && fs2.existsSync(wsPath)) return wsPath;
      return process.cwd();
    }
    function safeResolve(workspacePath, reqPath) {
      const resolvedRoot = path2.resolve(workspacePath);
      const target = path2.isAbsolute(reqPath) ? path2.resolve(reqPath) : path2.resolve(resolvedRoot, reqPath || "");
      const rel = path2.relative(resolvedRoot, target);
      if (rel.startsWith("..") || path2.isAbsolute(rel)) {
        throw new Error("Access denied: path escapes workspace root");
      }
      return target;
    }
    function applyManagedGatewayEnv2({ server, deviceId, deviceSecret }) {
      if (process.env.CCNOW_MANAGED_LLM_GATEWAY !== "1") return;
      if (!server || !deviceId || !deviceSecret) return;
      const baseUrl = String(server).trim().replace(/\/+$/, "");
      const virtualKey = `sk-ccnow-${deviceId}.${deviceSecret}`;
      const claudeOAuthMode = process.env.CCNOW_CLAUDE_OAUTH_MODE === "1";
      const envMap = {
        OPENAI_BASE_URL: `${baseUrl}/v1`,
        OPENAI_API_BASE: `${baseUrl}/v1`,
        OPENAI_API_KEY: virtualKey,
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1"
      };
      if (claudeOAuthMode) {
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      } else {
        envMap.ANTHROPIC_BASE_URL = baseUrl;
        envMap.ANTHROPIC_API_KEY = virtualKey;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      }
      for (const [k, v] of Object.entries(envMap)) {
        process.env[k] = v;
      }
      if (hasCommand("tmux")) {
        for (const [k, v] of Object.entries(envMap)) {
          try {
            execFileSync("tmux", tmuxArgs(["set-environment", "-g", k, v]), { stdio: "ignore" });
          } catch (_) {
          }
        }
        if (claudeOAuthMode) {
          for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
            try {
              execFileSync("tmux", tmuxArgs(["set-environment", "-gu", k]), { stdio: "ignore" });
            } catch (_) {
            }
          }
        } else {
          try {
            execFileSync("tmux", tmuxArgs(["set-environment", "-gu", "ANTHROPIC_AUTH_TOKEN"]), { stdio: "ignore" });
          } catch (_) {
          }
        }
      }
      console.log(`\u{1F510} [ccnow-agent] Managed LLM Gateway active (${baseUrl}, Claude: ${claudeOAuthMode ? "OAuth Direct" : "Scoped Virtual Key"}, Codex: Scoped Virtual Key)`);
    }
    module2.exports = {
      CLIENT_VERSION: CLIENT_VERSION2,
      CONFIG_DIR: CONFIG_DIR2,
      CONFIG_FILE: CONFIG_FILE2,
      WORKSPACES_FILE: WORKSPACES_FILE2,
      TMUX_SOCKET,
      tmuxArgs,
      readConfig: readConfig2,
      saveConfig,
      parseArgs: parseArgs2,
      hasCommand,
      getLocalDeviceInfo,
      toWsUrl,
      resolveBaseDir,
      safeResolve,
      applyManagedGatewayEnv: applyManagedGatewayEnv2
    };
  }
});

// client/src/fsHandlers.js
var require_fsHandlers = __commonJS({
  "client/src/fsHandlers.js"(exports2, module2) {
    var os = require("os");
    var fs2 = require("fs");
    var path2 = require("path");
    var { CONFIG_DIR: CONFIG_DIR2, WORKSPACES_FILE: WORKSPACES_FILE2, resolveBaseDir, safeResolve } = require_config();
    function readCustomWorkspaces() {
      try {
        if (fs2.existsSync(WORKSPACES_FILE2)) {
          const raw = JSON.parse(fs2.readFileSync(WORKSPACES_FILE2, "utf8"));
          if (Array.isArray(raw)) return raw;
          if (raw && typeof raw === "object") {
            return Object.entries(raw).map(([name, wsPath]) => ({ name, path: wsPath }));
          }
        }
      } catch (e) {
      }
      return [];
    }
    function writeCustomWorkspaces(list) {
      try {
        if (!fs2.existsSync(CONFIG_DIR2)) {
          fs2.mkdirSync(CONFIG_DIR2, { recursive: true });
        }
        fs2.writeFileSync(WORKSPACES_FILE2, JSON.stringify(list, null, 2), "utf8");
        return true;
      } catch (e) {
        return false;
      }
    }
    function handleFsWorkspaces(send, reqId) {
      const defaults = [
        { name: "Home (~)", path: os.homedir(), isDefault: true }
      ];
      const custom = readCustomWorkspaces();
      const seenPaths = new Set(defaults.map((w) => w.path));
      const merged = [...defaults];
      for (const ws of custom) {
        if (ws && ws.path && !seenPaths.has(ws.path)) {
          seenPaths.add(ws.path);
          merged.push(ws);
        }
      }
      send({ action: "fs:workspaces_result", reqId, workspaces: merged });
    }
    function handleFsAddWorkspace(send, reqId, msg) {
      try {
        const { name, path: wsPath } = msg;
        if (!name || !String(name).trim()) {
          return send({ action: "fs:add_workspace_result", reqId, error: "Workspace name is required." });
        }
        const trimmedName = String(name).trim();
        const rawPath = wsPath && String(wsPath).trim() ? String(wsPath).trim() : path2.join(os.homedir(), trimmedName);
        const resolvedPath = rawPath.startsWith("~/") ? path2.join(os.homedir(), rawPath.substring(2)) : rawPath === "~" ? os.homedir() : path2.resolve(rawPath);
        if (!fs2.existsSync(resolvedPath)) {
          fs2.mkdirSync(resolvedPath, { recursive: true });
        }
        const custom = readCustomWorkspaces();
        const exists = custom.find((w) => w.name.toLowerCase() === trimmedName.toLowerCase() || w.path === resolvedPath);
        if (exists) {
          return send({ action: "fs:add_workspace_result", reqId, error: "Workspace with this name or path already exists." });
        }
        const newWs = { name: trimmedName, path: resolvedPath };
        custom.push(newWs);
        writeCustomWorkspaces(custom);
        send({ action: "fs:add_workspace_result", reqId, success: true, workspace: newWs });
      } catch (e) {
        send({ action: "fs:add_workspace_result", reqId, error: e.message });
      }
    }
    function handleFsRemoveWorkspace(send, reqId, msg) {
      try {
        const { name } = msg;
        if (!name) {
          return send({ action: "fs:remove_workspace_result", reqId, error: "Workspace name is required." });
        }
        const custom = readCustomWorkspaces();
        const filtered = custom.filter((w) => w.name.toLowerCase() !== String(name).toLowerCase());
        if (filtered.length === custom.length) {
          return send({ action: "fs:remove_workspace_result", reqId, error: "Workspace not found (built-in workspaces cannot be removed)." });
        }
        writeCustomWorkspaces(filtered);
        send({ action: "fs:remove_workspace_result", reqId, success: true });
      } catch (e) {
        send({ action: "fs:remove_workspace_result", reqId, error: e.message });
      }
    }
    function handleFsList(send, reqId, workspacePath, relativePath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const targetDir = relativePath ? safeResolve(baseDir, relativePath) : baseDir;
        if (!fs2.existsSync(targetDir)) {
          return send({ action: "fs:list_result", reqId, error: "Directory not found" });
        }
        const stat = fs2.statSync(targetDir);
        if (!stat.isDirectory()) {
          return send({ action: "fs:list_result", reqId, error: "Target is not a directory" });
        }
        const entries = fs2.readdirSync(targetDir, { withFileTypes: true });
        const items = entries.filter((e) => e.name !== ".git" && e.name !== "node_modules" && e.name !== ".claude" && e.name !== ".codex" && !e.name.startsWith(".DS_Store")).map((e) => {
          const fullPath = path2.join(targetDir, e.name);
          const relPath = path2.relative(baseDir, fullPath);
          const isDir = e.isDirectory();
          let size = null;
          let mtime = null;
          try {
            const s = fs2.statSync(fullPath);
            size = isDir ? null : s.size;
            mtime = s.mtime.toISOString();
          } catch (err) {
          }
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
          return a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" });
        });
        send({ action: "fs:list_result", reqId, rootDir: baseDir, items });
      } catch (err) {
        send({ action: "fs:list_result", reqId, error: err.message });
      }
    }
    function handleFsRead(send, reqId, workspacePath, filePath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const targetPath = safeResolve(baseDir, filePath);
        if (!fs2.existsSync(targetPath)) {
          return send({ action: "fs:read_result", reqId, error: "File not found" });
        }
        const stat = fs2.statSync(targetPath);
        if (!stat.isFile()) {
          return send({ action: "fs:read_result", reqId, error: "Path is not a file" });
        }
        if (stat.size > 2 * 1024 * 1024) {
          return send({ action: "fs:read_result", reqId, error: "File is too large (>2MB)" });
        }
        const content = fs2.readFileSync(targetPath, "utf8");
        send({ action: "fs:read_result", reqId, path: filePath, content, size: stat.size });
      } catch (err) {
        send({ action: "fs:read_result", reqId, error: err.message });
      }
    }
    function handleFsWrite(send, reqId, workspacePath, filePath, content) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const targetPath = safeResolve(baseDir, filePath);
        const parentDir = path2.dirname(targetPath);
        if (!fs2.existsSync(parentDir)) {
          fs2.mkdirSync(parentDir, { recursive: true });
        }
        fs2.writeFileSync(targetPath, content || "", "utf8");
        send({ action: "fs:write_result", reqId, success: true });
      } catch (err) {
        send({ action: "fs:write_result", reqId, error: err.message });
      }
    }
    function handleFsCreateFile(send, reqId, workspacePath, filePath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const targetPath = safeResolve(baseDir, filePath);
        const parentDir = path2.dirname(targetPath);
        if (!fs2.existsSync(parentDir)) {
          fs2.mkdirSync(parentDir, { recursive: true });
        }
        if (!fs2.existsSync(targetPath)) {
          fs2.writeFileSync(targetPath, "", "utf8");
        }
        send({ action: "fs:create_file_result", reqId, success: true });
      } catch (e) {
        send({ action: "fs:create_file_result", reqId, error: e.message });
      }
    }
    function handleFsCreateDir(send, reqId, workspacePath, dirPath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const targetPath = safeResolve(baseDir, dirPath);
        if (!fs2.existsSync(targetPath)) {
          fs2.mkdirSync(targetPath, { recursive: true });
        }
        send({ action: "fs:create_dir_result", reqId, success: true });
      } catch (e) {
        send({ action: "fs:create_dir_result", reqId, error: e.message });
      }
    }
    function handleFsDelete(send, reqId, workspacePath, targetPath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const fullPath = safeResolve(baseDir, targetPath);
        if (fs2.existsSync(fullPath)) {
          fs2.rmSync(fullPath, { recursive: true, force: true });
        }
        send({ action: "fs:delete_result", reqId, success: true });
      } catch (e) {
        send({ action: "fs:delete_result", reqId, error: e.message });
      }
    }
    function handleFsRename(send, reqId, workspacePath, oldPath, newPath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const src = safeResolve(baseDir, oldPath);
        const dst = safeResolve(baseDir, newPath);
        const dstParent = path2.dirname(dst);
        if (!fs2.existsSync(dstParent)) {
          fs2.mkdirSync(dstParent, { recursive: true });
        }
        fs2.renameSync(src, dst);
        send({ action: "fs:rename_result", reqId, success: true });
      } catch (e) {
        send({ action: "fs:rename_result", reqId, error: e.message });
      }
    }
    function handleDirectories(send, reqId, targetPath) {
      try {
        const baseDir = resolveBaseDir(targetPath);
        const entries = fs2.readdirSync(baseDir, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => ({ name: e.name, path: path2.join(baseDir, e.name) }));
        send({ action: "fs:directories_result", reqId, currentPath: baseDir, directories: dirs });
      } catch (e) {
        send({ action: "fs:directories_result", reqId, error: e.message });
      }
    }
    function handleUploadFile(send, reqId, msg) {
      try {
        const { workspacePath, filename, bufferBase64 } = msg;
        const baseDir = resolveBaseDir(workspacePath);
        const targetPath = safeResolve(baseDir, filename);
        const parentDir = path2.dirname(targetPath);
        if (!fs2.existsSync(parentDir)) {
          fs2.mkdirSync(parentDir, { recursive: true });
        }
        const buf = Buffer.from(bufferBase64, "base64");
        fs2.writeFileSync(targetPath, buf);
        send({ action: "fs:upload_file_result", reqId, success: true });
      } catch (e) {
        send({ action: "fs:upload_file_result", reqId, error: e.message });
      }
    }
    module2.exports = {
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
  }
});

// client/src/gitHandlers.js
var require_gitHandlers = __commonJS({
  "client/src/gitHandlers.js"(exports2, module2) {
    var path2 = require("path");
    var { execSync, execFile } = require("child_process");
    var { promisify } = require("util");
    var execFileAsync = promisify(execFile);
    var { resolveBaseDir } = require_config();
    async function handleGitStatus(send, reqId, workspacePath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        let gitRoot = "";
        try {
          const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: baseDir, encoding: "utf8" });
          gitRoot = (stdout || "").trim();
        } catch (_) {
          return send({ action: "git:status_result", reqId, isGit: false, branch: "", clean: true, files: [] });
        }
        const [branchRes, statusRes] = await Promise.all([
          execFileAsync("git", ["branch", "--show-current"], { cwd: baseDir, encoding: "utf8" }).catch(() => ({ stdout: "" })),
          execFileAsync("git", ["-c", "core.quotePath=false", "status", "--porcelain", "-u", "--", "."], { cwd: baseDir, encoding: "utf8" }).catch(() => ({ stdout: "" }))
        ]);
        const branch = (branchRes.stdout || "").trim();
        const statusOut = statusRes.stdout || "";
        const files = [];
        for (const line of statusOut.split("\n")) {
          if (!line.trim()) continue;
          const code = line.substring(0, 2);
          let filePath = line.substring(3).trim();
          let renameFrom = null;
          if (code.startsWith("R") || code.endsWith("R")) {
            const parts = filePath.split(" -> ");
            if (parts.length === 2) {
              renameFrom = parts[0];
              filePath = parts[1];
            }
          }
          if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
          if (renameFrom && renameFrom.startsWith('"') && renameFrom.endsWith('"')) renameFrom = renameFrom.slice(1, -1);
          const fullPath = path2.resolve(gitRoot, filePath);
          const relToWorkspace = path2.relative(baseDir, fullPath);
          if (relToWorkspace.startsWith("..") || path2.isAbsolute(relToWorkspace)) continue;
          let relRenameFrom = null;
          if (renameFrom) {
            relRenameFrom = path2.relative(baseDir, path2.resolve(gitRoot, renameFrom));
          }
          files.push({
            path: relToWorkspace,
            status: code.trim(),
            index: code[0],
            worktree: code[1],
            renameFrom: relRenameFrom
          });
        }
        send({ action: "git:status_result", reqId, isGit: true, branch, clean: files.length === 0, files });
      } catch (e) {
        send({ action: "git:status_result", reqId, isGit: false, branch: "", clean: true, files: [] });
      }
    }
    function handleGitDiff(send, reqId, workspacePath, filePath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const fileArg = filePath ? ` -- "${filePath.replace(/"/g, "")}"` : "";
        const diff = execSync(`git diff HEAD${fileArg} 2>/dev/null || git diff${fileArg} 2>/dev/null || echo ""`, { cwd: baseDir, encoding: "utf8" });
        send({ action: "git:diff_result", reqId, diff });
      } catch (e) {
        send({ action: "git:diff_result", reqId, diff: "" });
      }
    }
    function handleGitStage(send, reqId, workspacePath, files) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const fileArgs = Array.isArray(files) && files.length > 0 ? files.map((f) => `"${String(f).replace(/"/g, "")}"`).join(" ") : ".";
        execSync(`git add ${fileArgs}`, { cwd: baseDir, stdio: "ignore" });
        send({ action: "git:stage_result", reqId, success: true });
      } catch (e) {
        send({ action: "git:stage_result", reqId, error: e.message });
      }
    }
    function handleGitUnstage(send, reqId, workspacePath, files) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const fileArgs = Array.isArray(files) && files.length > 0 ? files.map((f) => `"${String(f).replace(/"/g, "")}"`).join(" ") : ".";
        execSync(`git reset HEAD ${fileArgs}`, { cwd: baseDir, stdio: "ignore" });
        send({ action: "git:unstage_result", reqId, success: true });
      } catch (e) {
        send({ action: "git:unstage_result", reqId, error: e.message });
      }
    }
    function handleGitCommit(send, reqId, workspacePath, message) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const cleanMsg = (message || "Commit from ccnow").replace(/"/g, '\\"');
        execSync(`git commit -m "${cleanMsg}"`, { cwd: baseDir, stdio: "ignore" });
        send({ action: "git:commit_result", reqId, success: true });
      } catch (e) {
        send({ action: "git:commit_result", reqId, error: e.message });
      }
    }
    function handleGitBranches(send, reqId, workspacePath) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const out = execSync('git branch 2>/dev/null || echo ""', { cwd: baseDir, encoding: "utf8" });
        const lines = out.split("\n").filter(Boolean);
        let currentBranch = "";
        const branches = [];
        for (const line of lines) {
          const isCurrent = line.startsWith("*");
          const bName = line.replace(/^\*?\s+/, "").trim();
          if (bName) {
            branches.push(bName);
            if (isCurrent) currentBranch = bName;
          }
        }
        send({ action: "git:branches_result", reqId, currentBranch, branches });
      } catch (e) {
        send({ action: "git:branches_result", reqId, currentBranch: "", branches: [] });
      }
    }
    function handleGitCheckout(send, reqId, workspacePath, branch) {
      try {
        const baseDir = resolveBaseDir(workspacePath);
        const cleanBranch = String(branch).replace(/[^a-zA-Z0-9_\-\.\/]/g, "");
        execSync(`git checkout "${cleanBranch}"`, { cwd: baseDir, stdio: "ignore" });
        send({ action: "git:checkout_result", reqId, success: true });
      } catch (e) {
        send({ action: "git:checkout_result", reqId, error: e.message });
      }
    }
    module2.exports = {
      handleGitStatus,
      handleGitDiff,
      handleGitStage,
      handleGitUnstage,
      handleGitCommit,
      handleGitBranches,
      handleGitCheckout
    };
  }
});

// client/src/depsManager.js
var require_depsManager = __commonJS({
  "client/src/depsManager.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var Module = require("module");
    var { pathToFileURL } = require("url");
    var { spawn, execFileSync } = require("child_process");
    var { CONFIG_DIR: CONFIG_DIR2, hasCommand } = require_config();
    var autoInstallStarted = false;
    function getConfigRequire() {
      try {
        return Module.createRequire(path2.join(CONFIG_DIR2, "package.json"));
      } catch (_) {
        return null;
      }
    }
    function getConfigPkgDir(pkgName) {
      return path2.join(CONFIG_DIR2, "node_modules", ...pkgName.split("/"));
    }
    function tryRequireOptional(pkgName) {
      try {
        return require(pkgName);
      } catch (_) {
      }
      try {
        const cfgReq = getConfigRequire();
        if (cfgReq) return cfgReq(pkgName);
      } catch (_) {
      }
      return null;
    }
    function resolveOptionalEsmUrl(specifier) {
      try {
        const cfgReq = getConfigRequire();
        if (cfgReq) {
          const resolved = cfgReq.resolve(specifier);
          if (resolved) return pathToFileURL(resolved).href;
        }
      } catch (_) {
      }
      try {
        const parts = specifier.split("/");
        const pkgName = specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
        const subpath = specifier.startsWith("@") ? parts.length > 2 ? "./" + parts.slice(2).join("/") : "." : parts.length > 1 ? "./" + parts.slice(1).join("/") : ".";
        const pkgDir = getConfigPkgDir(pkgName);
        const pkgJsonPath = path2.join(pkgDir, "package.json");
        if (!fs2.existsSync(pkgJsonPath)) return null;
        const pkgJson = JSON.parse(fs2.readFileSync(pkgJsonPath, "utf8"));
        const exportsMap = pkgJson.exports;
        let relTarget = null;
        if (exportsMap && typeof exportsMap === "object") {
          const pickImport = (entry) => {
            if (!entry) return null;
            if (typeof entry === "string") return entry;
            if (typeof entry === "object") return entry.import || entry.default || null;
            return null;
          };
          if (exportsMap[subpath] !== void 0) {
            relTarget = pickImport(exportsMap[subpath]);
          } else {
            for (const [pattern, entry] of Object.entries(exportsMap)) {
              const starIdx = pattern.indexOf("*");
              if (starIdx === -1) continue;
              const prefix = pattern.slice(0, starIdx);
              const suffix = pattern.slice(starIdx + 1);
              if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
                const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
                const rawTarget = pickImport(entry);
                if (rawTarget) {
                  relTarget = rawTarget.replace("*", matched);
                  break;
                }
              }
            }
          }
        }
        if (!relTarget && subpath === ".") {
          relTarget = pkgJson.module || pkgJson.main || "./index.js";
        }
        if (relTarget) {
          const fullPath = path2.resolve(pkgDir, relTarget);
          if (fs2.existsSync(fullPath)) {
            return pathToFileURL(fullPath).href;
          }
        }
      } catch (_) {
      }
      return null;
    }
    function isPackageAvailable(pkgName) {
      if (fs2.existsSync(path2.join(getConfigPkgDir(pkgName), "package.json"))) {
        return true;
      }
      try {
        require.resolve(pkgName);
        return true;
      } catch (_) {
      }
      try {
        let dir = __dirname;
        for (let i = 0; i < 6; i++) {
          const candidate = path2.join(dir, "node_modules", ...pkgName.split("/"), "package.json");
          if (fs2.existsSync(candidate)) return true;
          const parent = path2.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      } catch (_) {
      }
      return false;
    }
    function ensureConfigPackageJson() {
      if (!fs2.existsSync(CONFIG_DIR2)) {
        fs2.mkdirSync(CONFIG_DIR2, { recursive: true });
      }
      const pkgPath = path2.join(CONFIG_DIR2, "package.json");
      if (!fs2.existsSync(pkgPath)) {
        fs2.writeFileSync(
          pkgPath,
          JSON.stringify({ name: "ccnow-agent-deps", version: "1.0.0", private: true }, null, 2),
          "utf8"
        );
      }
    }
    function installPackageSync(pkgName) {
      if (!hasCommand("npm")) return false;
      try {
        ensureConfigPackageJson();
        console.log(`\u{1F4E6} [ccnow-agent] Installing required fallback dependency '${pkgName}' into ${CONFIG_DIR2}...`);
        execFileSync("npm", ["install", "--prefix", CONFIG_DIR2, "--save", "--no-audit", "--no-fund", pkgName], {
          stdio: "ignore",
          timeout: 6e4
        });
        return isPackageAvailable(pkgName);
      } catch (_) {
        return false;
      }
    }
    function installPackageAsync(pkgName) {
      return new Promise((resolve) => {
        if (!hasCommand("npm")) return resolve({ pkg: pkgName, ok: false, reason: "npm not found" });
        try {
          ensureConfigPackageJson();
        } catch (err) {
          return resolve({ pkg: pkgName, ok: false, reason: err.message });
        }
        const child = spawn(
          "npm",
          ["install", "--prefix", CONFIG_DIR2, "--save", "--no-audit", "--no-fund", pkgName],
          { stdio: "ignore", env: { ...process.env, npm_config_loglevel: "error" } }
        );
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch (_) {
          }
          resolve({ pkg: pkgName, ok: false, reason: "timeout" });
        }, 12e4);
        child.on("close", (code) => {
          clearTimeout(timer);
          const ok = code === 0 && isPackageAvailable(pkgName);
          resolve({ pkg: pkgName, ok, code });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ pkg: pkgName, ok: false, reason: err.message });
        });
      });
    }
    function getMissingOptionalDeps() {
      const missing = [];
      const nodeMajor = parseInt(String(process.versions.node || "0").split(".")[0], 10) || 0;
      if (nodeMajor >= 24 && !isPackageAvailable("@botiverse/oar")) {
        missing.push("@botiverse/oar");
      }
      if (!isPackageAvailable("node-pty")) {
        missing.push("node-pty");
      }
      return missing;
    }
    function ensureOptionalDepsInBackground() {
      if (autoInstallStarted || process.env.CCNOW_SKIP_AUTO_INSTALL === "1") return;
      autoInstallStarted = true;
      const missing = getMissingOptionalDeps();
      if (missing.length === 0 || !hasCommand("npm")) return;
      console.log(`\u{1F4E6} [ccnow-agent] Installing optional enhancements in background (${missing.join(", ")}) -> ${CONFIG_DIR2}/node_modules`);
      (async () => {
        for (const pkg of missing) {
          const res = await installPackageAsync(pkg);
          if (res.ok) {
            console.log(`\u2705 [ccnow-agent] Optional dependency '${pkg}' installed and ready.`);
          } else {
            console.log(`\u2139\uFE0F [ccnow-agent] Optional dependency '${pkg}' skipped (${res.reason || `exit ${res.code}`}); fallback mode remains active.`);
          }
        }
      })();
    }
    async function runSetupCommand2() {
      const missing = getMissingOptionalDeps();
      console.log(`\u{1F4C1} Config directory: ${CONFIG_DIR2}`);
      console.log(`   - @botiverse/oar: ${isPackageAvailable("@botiverse/oar") ? "\u2705 installed" : "\u26AA missing"}`);
      console.log(`   - node-pty:       ${isPackageAvailable("node-pty") ? "\u2705 installed" : "\u26AA missing"}`);
      if (missing.length === 0) {
        console.log("\u2728 All optional dependencies are already available.");
        return;
      }
      if (!hasCommand("npm")) {
        console.error("\u274C npm not found in PATH; cannot auto-install optional dependencies.");
        process.exit(1);
      }
      for (const pkg of missing) {
        console.log(`\u2B07\uFE0F Installing ${pkg} into ${CONFIG_DIR2}/node_modules ...`);
        const res = await installPackageAsync(pkg);
        console.log(res.ok ? `\u2705 ${pkg} installed.` : `\u26A0\uFE0F ${pkg} failed (${res.reason || `exit ${res.code}`}), fallback remains active.`);
      }
    }
    module2.exports = {
      tryRequireOptional,
      resolveOptionalEsmUrl,
      isPackageAvailable,
      installPackageSync,
      installPackageAsync,
      getMissingOptionalDeps,
      ensureOptionalDepsInBackground,
      runSetupCommand: runSetupCommand2
    };
  }
});

// client/src/sessionRegistry.js
var require_sessionRegistry = __commonJS({
  "client/src/sessionRegistry.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { CONFIG_DIR: CONFIG_DIR2 } = require_config();
    var SESSIONS_FILE = path2.join(CONFIG_DIR2, "sessions.json");
    function readRegistry() {
      try {
        if (fs2.existsSync(SESSIONS_FILE)) {
          const data = JSON.parse(fs2.readFileSync(SESSIONS_FILE, "utf8"));
          if (data && typeof data === "object" && !Array.isArray(data)) {
            return data;
          }
        }
      } catch (_) {
      }
      return {};
    }
    function writeRegistry(map) {
      try {
        if (!fs2.existsSync(CONFIG_DIR2)) {
          fs2.mkdirSync(CONFIG_DIR2, { recursive: true });
        }
        const tmp = `${SESSIONS_FILE}.tmp.${process.pid}.${Date.now()}`;
        fs2.writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
        fs2.renameSync(tmp, SESSIONS_FILE);
        return true;
      } catch (err) {
        console.warn("\u26A0\uFE0F [sessionRegistry] Failed to persist sessions.json:", err.message);
        return false;
      }
    }
    function listPureChatSessions() {
      const reg = readRegistry();
      return Object.values(reg).filter((s) => s && s.name).map((s) => ({
        name: s.name,
        seqId: s.seqId || null,
        windows: 1,
        created: s.created || Date.now(),
        attached: false,
        path: s.workspacePath || "",
        workspaceName: s.workspaceName || "",
        agentType: s.agentType || "claude",
        agentModel: s.agentModel || s.modelName || "",
        sessionMode: "chat_only",
        agentSessionId: "",
        isRemote: true
      }));
    }
    function getPureChatSession(sessionName) {
      if (!sessionName) return null;
      const reg = readRegistry();
      return reg[sessionName] || null;
    }
    function upsertPureChatSession(sessionName, meta = {}) {
      if (!sessionName) return null;
      const reg = readRegistry();
      const prev = reg[sessionName] || {};
      const record = {
        name: sessionName,
        seqId: meta.seqId !== void 0 ? meta.seqId : prev.seqId || null,
        workspacePath: meta.workspacePath || prev.workspacePath || process.cwd(),
        workspaceName: meta.workspaceName !== void 0 ? meta.workspaceName : prev.workspaceName || "",
        agentType: meta.agentType || prev.agentType || "claude",
        agentModel: meta.agentModel !== void 0 ? meta.agentModel : prev.agentModel || "",
        modelName: meta.modelName !== void 0 ? meta.modelName : prev.modelName || "",
        sessionMode: "chat_only",
        created: prev.created || meta.created || Date.now()
      };
      reg[sessionName] = record;
      writeRegistry(reg);
      return record;
    }
    function deletePureChatSession(sessionName) {
      if (!sessionName) return false;
      const reg = readRegistry();
      if (!Object.prototype.hasOwnProperty.call(reg, sessionName)) return false;
      delete reg[sessionName];
      writeRegistry(reg);
      return true;
    }
    module2.exports = {
      SESSIONS_FILE,
      readRegistry,
      listPureChatSessions,
      getPureChatSession,
      upsertPureChatSession,
      deletePureChatSession
    };
  }
});

// client/src/tmuxHandlers.js
var require_tmuxHandlers = __commonJS({
  "client/src/tmuxHandlers.js"(exports2, module2) {
    var os = require("os");
    var fs2 = require("fs");
    var crypto = require("crypto");
    var { spawn, execFile, execFileSync } = require("child_process");
    var { promisify } = require("util");
    var execFileAsync = promisify(execFile);
    var { hasCommand, resolveBaseDir, tmuxArgs } = require_config();
    var { tryRequireOptional } = require_depsManager();
    var sessionRegistry = require_sessionRegistry();
    var activeTerminals = /* @__PURE__ */ new Map();
    function cleanupAllTerminals() {
      for (const [, term] of activeTerminals.entries()) {
        try {
          term.kill();
        } catch (e) {
        }
      }
      activeTerminals.clear();
    }
    function readTmuxSessionMeta(sessionName) {
      const pureChat = sessionRegistry.getPureChatSession(sessionName);
      if (pureChat) {
        return {
          workspacePath: pureChat.workspacePath && fs2.existsSync(pureChat.workspacePath) ? pureChat.workspacePath : process.env.CCNOW_DEFAULT_WORKSPACE || process.cwd(),
          agentType: pureChat.agentType || "claude",
          sessionMode: "chat_only",
          model: pureChat.modelName || pureChat.agentModel || ""
        };
      }
      let workspacePath = process.env.CCNOW_DEFAULT_WORKSPACE || process.cwd();
      let agentType = "claude";
      let sessionMode = "hybrid";
      let model = "";
      if (hasCommand("tmux") && sessionName) {
        try {
          const fmt = "#{session_path}|#{@agent_type}|#{@session_mode}|#{@agent_model}";
          const out = execFileSync("tmux", tmuxArgs(["display-message", "-p", "-t", sessionName, fmt]), {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
          }).trim();
          const parts = out.split("|");
          if (parts[0] && fs2.existsSync(parts[0])) workspacePath = parts[0];
          if (parts[1] && parts[1].trim()) agentType = parts[1].trim();
          if (parts[2] && parts[2].trim()) sessionMode = parts[2].trim();
          if (parts[3] && parts[3].trim()) model = parts[3].trim();
        } catch (_) {
        }
      }
      return { workspacePath, agentType, sessionMode, model };
    }
    function detectPaneLiveStatus(paneOutput) {
      const nonBlankLines = (paneOutput || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const lastFewLines = nonBlankLines.slice(-8);
      const recentText = lastFewLines.join("\n");
      const waitingPatterns = [
        /\[y\/N\]/i,
        /\[Y\/n\]/i,
        /\[y\/n\]/i,
        /\(y\/n\)/i,
        /allow\s+.*?\?/i,
        /confirm\s+.*?\?/i,
        /please\s+authorize/i,
        /authorize\s+.*?\?/i,
        /waiting\s+for\s+(approval|input|feedback)/i,
        /do\s+you\s+want\s+to\s+(proceed|allow|run|continue)/i,
        /escalate_admin/i,
        /enter\s+to\s+continue/i,
        /password\s+for\s+.*?:/i
      ];
      if (waitingPatterns.some((p) => p.test(recentText))) {
        return { status: "waiting", snippet: nonBlankLines.slice(-2).join(" ").slice(0, 140) };
      }
      const busyPatterns = [
        /esc\s+to\s+interrupt/i,
        /ctrl\+c\s+to\s+interrupt/i,
        /\b(thinking|working|running|generating|analyzing|searching|reading|writing|editing|compacting|retrying|streaming)\b(\.{2,3}|…)/i,
        /\bworking\s*\(\d+s/i,
        /[⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
        /[✻✽✶✢]\s+\S+.*(…|\.\.\.)/,
        /●\s+(bash|read|write|view|edit|search|grep|glob|tool|run_command)/i,
        /正在(深入思考|思考|生成|执行|压缩|重试|分析|读取|写入|搜索)/
      ];
      if (busyPatterns.some((p) => p.test(recentText))) {
        return { status: "busy", snippet: nonBlankLines.slice(-2).join(" ").slice(0, 140) };
      }
      return { status: "idle", snippet: nonBlankLines.slice(-2).join(" ").slice(0, 140) };
    }
    async function handleListSessions(send, reqId, getDeviceOarManager, msg = {}) {
      const hasTmux = hasCommand("tmux");
      const includeLiveStatus = Boolean(msg && msg.includeLiveStatus);
      const sessions = [];
      const seenNames = /* @__PURE__ */ new Set();
      if (hasTmux) {
        try {
          const fmt = "#{session_name}|#{session_windows}|#{session_created}|#{?session_attached,1,0}|#{session_path}|#{@workspace_name}|#{@agent_type}|#{@agent_model}|#{@session_mode}|#{@agent_session_id}|#{session_activity}";
          const { stdout } = await execFileAsync("tmux", tmuxArgs(["list-sessions", "-F", fmt]), {
            encoding: "utf8"
          });
          const lines = (stdout || "").trim().split("\n").filter(Boolean);
          for (const line of lines) {
            const parts = line.split("|");
            if (parts.length >= 1 && parts[0]) {
              const agentType = parts[6] || "";
              const rawMode = parts[8] || "";
              const sessionMode = rawMode || (agentType === "default" ? "terminal_only" : "hybrid");
              const createdMs = parseInt(parts[2], 10) * 1e3 || Date.now();
              const activityMs = parts[10] ? parseInt(parts[10], 10) * 1e3 : 0;
              seenNames.add(parts[0]);
              sessions.push({
                name: parts[0],
                windows: parseInt(parts[1], 10) || 1,
                created: createdMs,
                lastActiveAt: Math.max(createdMs, activityMs || 0),
                attached: parts[3] === "1",
                path: parts[4] || "",
                workspaceName: parts[5] || "",
                agentType,
                agentModel: parts[7] || "",
                sessionMode,
                agentSessionId: parts[9] || "",
                isRemote: true
              });
            }
          }
        } catch (e) {
        }
      }
      for (const s of sessionRegistry.listPureChatSessions()) {
        if (!seenNames.has(s.name)) {
          seenNames.add(s.name);
          sessions.push(s);
        }
      }
      const oarMgr = typeof getDeviceOarManager === "function" ? getDeviceOarManager() : null;
      if (oarMgr) {
        for (const s of sessions) {
          if (s.sessionMode === "chat_only") {
            try {
              const snap = oarMgr.getHistorySnapshot(s.name, {
                agentType: s.agentType || "claude",
                workspacePath: s.path || s.workspacePath || process.cwd(),
                model: s.agentModel || s.modelName || ""
              });
              if (snap) {
                s.isGenerating = Boolean(snap.isGenerating);
                s.hasPendingAction = Boolean(snap.pendingAction);
                s.liveStatus = snap.pendingAction ? "waiting" : snap.isGenerating ? "busy" : "idle";
                s.statusText = snap.statusText || "";
                if (snap.lastUpdated) {
                  s.lastActiveAt = Math.max(s.lastActiveAt || 0, Number(snap.lastUpdated) || 0);
                }
              }
            } catch (_) {
            }
          }
        }
      }
      if (includeLiveStatus && hasTmux) {
        const tmuxCandidates = sessions.filter((s) => s.sessionMode !== "chat_only").slice(0, 25);
        await Promise.all(tmuxCandidates.map(async (s) => {
          try {
            const { stdout } = await execFileAsync(
              "tmux",
              tmuxArgs(["capture-pane", "-p", "-t", s.name, "-S", "-18"]),
              { encoding: "utf8", timeout: 600 }
            );
            const live = detectPaneLiveStatus(stdout);
            s.liveStatus = live.status;
            if (live.snippet) s.paneSnippet = live.snippet;
          } catch (_) {
          }
        }));
      }
      if (!hasTmux && !sessions.some((s) => s.sessionMode !== "chat_only")) {
        sessions.push({
          name: "default",
          windows: 1,
          created: Date.now(),
          attached: true,
          sessionMode: "terminal_only",
          agentType: "default",
          isRemote: true
        });
      }
      send({ action: "tmux:sessions_list", reqId, sessions });
    }
    function handleNewSession(send, reqId, msg, getDeviceOarManager) {
      const { sessionName, seqId, workspace, workspaceName, sessionMode, agentModel, modelName } = msg;
      const agent = msg.agent || msg.agentType || "default";
      const targetMode = sessionMode || (agent === "default" ? "terminal_only" : "hybrid");
      const hasTmux = hasCommand("tmux");
      const targetDir = resolveBaseDir(workspace);
      const fallbackBase = targetMode === "chat_only" ? `oar-${agent !== "default" ? agent : "claude"}` : agent !== "default" ? agent : "shell";
      const baseName = String(sessionName || "").replace(/[^a-zA-Z0-9_-]/g, "") || (seqId ? `${fallbackBase}-${seqId}` : fallbackBase);
      const existingSet = new Set(Object.keys(sessionRegistry.readRegistry()));
      if (hasTmux) {
        try {
          const existingOut = execFileSync("tmux", tmuxArgs(["list-sessions", "-F", "#{session_name}"]), {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
          });
          for (const n of existingOut.trim().split("\n").filter(Boolean)) existingSet.add(n);
        } catch (_) {
        }
      }
      let finalName = baseName;
      if (existingSet.has(finalName)) {
        if (seqId && !existingSet.has(`${baseName}-${seqId}`)) {
          finalName = `${baseName}-${seqId}`;
        } else {
          let idx = Math.max(2, Number(seqId) || 2);
          while (existingSet.has(`${baseName}-${idx}`)) idx++;
          finalName = `${baseName}-${idx}`;
        }
      }
      if (targetMode === "chat_only") {
        try {
          const effectiveAgent = agent !== "default" ? agent : "claude";
          sessionRegistry.upsertPureChatSession(finalName, {
            seqId: seqId || void 0,
            workspacePath: targetDir,
            workspaceName: workspaceName ? String(workspaceName) : "",
            agentType: effectiveAgent,
            agentModel: agentModel ? String(agentModel) : "",
            modelName: modelName ? String(modelName) : "",
            created: Date.now()
          });
          const oarMgr = getDeviceOarManager();
          if (oarMgr) {
            oarMgr.deleteSession(finalName);
            oarMgr.getOrCreateSession(finalName, {
              agentType: effectiveAgent,
              workspacePath: targetDir,
              model: modelName || agentModel || ""
            });
          }
          send({ action: "tmux:new_session_result", reqId, success: true, sessionName: finalName });
          return;
        } catch (e) {
          send({ action: "tmux:new_session_result", reqId, error: e.message });
          return;
        }
      }
      if (hasTmux && finalName) {
        try {
          execFileSync("tmux", tmuxArgs(["new-session", "-d", "-s", finalName, "-c", targetDir]), { stdio: "ignore" });
          let agentSessionId = "";
          if (agent === "claude") {
            agentSessionId = crypto.randomUUID();
          }
          const tmuxOptions = [
            ["status", "off"],
            ["mouse", "on"],
            ["@session_mode", targetMode],
            ["@agent_type", agent]
          ];
          if (seqId) tmuxOptions.push(["@session_seq_id", String(seqId)]);
          if (workspaceName) tmuxOptions.push(["@workspace_name", String(workspaceName)]);
          if (agentSessionId) tmuxOptions.push(["@agent_session_id", agentSessionId]);
          if (agentModel) tmuxOptions.push(["@agent_model", String(agentModel)]);
          for (const [optKey, optVal] of tmuxOptions) {
            try {
              execFileSync("tmux", tmuxArgs(["set-option", "-t", finalName, optKey, optVal]), { stdio: "ignore" });
            } catch (_) {
            }
          }
          if (agent && agent !== "default" && agent !== "terminal") {
            let agentCmd = String(agent).replace(/"/g, "");
            if (agent === "agy") {
              agentCmd = "agy --dangerously-skip-permissions";
            } else if (agent === "claude") {
              const parts = [
                "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1",
                "claude",
                "--session-id",
                agentSessionId,
                "--permission-mode",
                "auto"
              ];
              if (modelName) parts.push("--model", String(modelName));
              agentCmd = parts.join(" ");
            } else if (agent === "codex") {
              const parts = ["codex", "-c", "check_for_update=false", "-c", "update_on_startup=false"];
              if (modelName) parts.push("--model", String(modelName));
              agentCmd = parts.join(" ");
            }
            try {
              execFileSync("tmux", tmuxArgs(["send-keys", "-t", finalName, agentCmd, "C-m"]), { stdio: "ignore" });
            } catch (_) {
            }
          }
          send({ action: "tmux:new_session_result", reqId, success: true, sessionName: finalName });
          return;
        } catch (e) {
          send({ action: "tmux:new_session_result", reqId, error: e.message });
          return;
        }
      }
      send({ action: "tmux:new_session_result", reqId, success: true, sessionName: finalName });
    }
    function handleKillSession(send, reqId, sessionName, getDeviceOarManager) {
      const wasPureChat = sessionRegistry.deletePureChatSession(sessionName);
      const oarMgr = getDeviceOarManager();
      if (oarMgr && sessionName) {
        try {
          oarMgr.deleteSession(sessionName);
        } catch (_) {
        }
      }
      if (!wasPureChat && hasCommand("tmux") && sessionName) {
        try {
          execFileSync("tmux", tmuxArgs(["kill-session", "-t", sessionName]), { stdio: "ignore" });
        } catch (e) {
        }
      }
      send({ action: "tmux:kill_session_result", reqId, success: true });
    }
    function handleSendKeys(send, reqId, msg) {
      const { sessionName, text, clearHistory, exitCopyMode } = msg || {};
      if (!hasCommand("tmux") || !sessionName) {
        return send({ action: "tmux:send_keys_result", reqId, success: false, error: "tmux or sessionName unavailable" });
      }
      try {
        if (exitCopyMode) {
          try {
            execFileSync("tmux", tmuxArgs(["copy-mode", "-q", "-t", sessionName]), { stdio: "ignore" });
          } catch (_) {
          }
        }
        if (clearHistory) {
          execFileSync("tmux", tmuxArgs(["send-keys", "-t", sessionName, "/clear", "C-m"]), { stdio: "ignore" });
        }
        if (typeof text === "string" && text.length > 0) {
          execFileSync("tmux", tmuxArgs(["send-keys", "-t", sessionName, "-l", text]), { stdio: "ignore" });
          execFileSync("tmux", tmuxArgs(["send-keys", "-t", sessionName, "C-m"]), { stdio: "ignore" });
        }
        send({ action: "tmux:send_keys_result", reqId, success: true });
      } catch (e) {
        send({ action: "tmux:send_keys_result", reqId, success: false, error: e.message });
      }
    }
    function handleOpenTerminal(send, msg) {
      const { termId, sessionName, cols = 80, rows = 24 } = msg;
      if (sessionName && sessionRegistry.getPureChatSession(sessionName)) {
        console.log(`\u{1F4AC} [Terminal PTY] Skipping PTY attach for tmux-free OAR session '${sessionName}'`);
        return;
      }
      if (activeTerminals.has(termId)) {
        try {
          activeTerminals.get(termId).kill();
        } catch (e) {
        }
        activeTerminals.delete(termId);
      }
      console.log(`\u{1F5A5}\uFE0F [Terminal PTY] Spawning session '${sessionName}' for termId: ${termId} (${cols}x${rows})`);
      const hasTmux = hasCommand("tmux");
      const hasPython = hasCommand("python3");
      const userShell = process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
      let targetCmd = userShell;
      let targetArgs = [];
      if (hasTmux && sessionName) {
        targetCmd = "tmux";
        targetArgs = tmuxArgs(["attach-session", "-t", sessionName]);
      }
      let ptyHandler = null;
      const nodePty = tryRequireOptional("node-pty");
      if (nodePty) {
        try {
          const ptyProcess = nodePty.spawn(targetCmd, targetArgs, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: process.cwd(),
            env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" }
          });
          ptyProcess.onData((data) => {
            send({ action: "term:output", termId, data });
          });
          ptyProcess.onExit(() => {
            activeTerminals.delete(termId);
            send({ action: "term:exit", termId });
          });
          ptyHandler = {
            write: (d) => ptyProcess.write(d),
            resize: (c, r) => ptyProcess.resize(c, r),
            kill: () => ptyProcess.kill()
          };
        } catch (e) {
        }
      }
      if (!ptyHandler && hasPython) {
        const fullCmdList = [targetCmd, ...targetArgs];
        const pyScript = `import pty, os, sys
pty.spawn(${JSON.stringify(fullCmdList)})
`;
        const pyProcess = spawn("python3", ["-c", pyScript], {
          cwd: process.cwd(),
          env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" }
        });
        pyProcess.stdout.on("data", (chunk) => send({ action: "term:output", termId, data: chunk.toString() }));
        pyProcess.stderr.on("data", (chunk) => send({ action: "term:output", termId, data: chunk.toString() }));
        pyProcess.on("close", () => {
          activeTerminals.delete(termId);
          send({ action: "term:exit", termId });
        });
        ptyHandler = {
          write: (d) => {
            if (pyProcess.stdin.writable) pyProcess.stdin.write(d);
          },
          resize: () => {
          },
          kill: () => {
            try {
              pyProcess.kill("SIGTERM");
            } catch (err) {
            }
          }
        };
      }
      if (!ptyHandler) {
        const shProcess = spawn(targetCmd, targetArgs, {
          cwd: process.cwd(),
          env: { ...process.env, TERM: "xterm-256color" }
        });
        shProcess.stdout.on("data", (chunk) => send({ action: "term:output", termId, data: chunk.toString() }));
        shProcess.stderr.on("data", (chunk) => send({ action: "term:output", termId, data: chunk.toString() }));
        shProcess.on("close", () => {
          activeTerminals.delete(termId);
          send({ action: "term:exit", termId });
        });
        ptyHandler = {
          write: (d) => {
            if (shProcess.stdin.writable) shProcess.stdin.write(d);
          },
          resize: () => {
          },
          kill: () => {
            try {
              shProcess.kill("SIGKILL");
            } catch (err) {
            }
          }
        };
      }
      activeTerminals.set(termId, ptyHandler);
    }
    function handleTerminalInput(msg) {
      const term = activeTerminals.get(msg.termId);
      if (term && term.write) term.write(msg.data);
    }
    function handleTerminalResize(msg) {
      const term = activeTerminals.get(msg.termId);
      if (term && term.resize) term.resize(msg.cols, msg.rows);
    }
    function handleTerminalClose(msg) {
      const term = activeTerminals.get(msg.termId);
      if (term) {
        term.kill();
        activeTerminals.delete(msg.termId);
      }
    }
    module2.exports = {
      activeTerminals,
      cleanupAllTerminals,
      readTmuxSessionMeta,
      handleListSessions,
      handleNewSession,
      handleKillSession,
      handleSendKeys,
      handleOpenTerminal,
      handleTerminalInput,
      handleTerminalResize,
      handleTerminalClose
    };
  }
});

// services/agentChatService.js
var require_agentChatService = __commonJS({
  "services/agentChatService.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var readline = require("readline");
    function getProjectSlug(workspacePath) {
      if (!workspacePath) return "";
      const normalized = path2.resolve(workspacePath).replace(/\/+$/, "");
      return normalized.replace(/\//g, "-");
    }
    function getClaudeProjectsDirs(userHomeDir, sysHomeDir) {
      const dirs = [];
      if (userHomeDir) {
        dirs.push(path2.join(userHomeDir, ".claude", "projects"));
      }
      if (sysHomeDir && sysHomeDir !== userHomeDir) {
        dirs.push(path2.join(sysHomeDir, ".claude", "projects"));
      }
      const defaultHome = process.env.HOME || "/home/ubuntu";
      const defPath = path2.join(defaultHome, ".claude", "projects");
      if (!dirs.includes(defPath)) {
        dirs.push(defPath);
      }
      return dirs;
    }
    function getSessionIdFromPanePid(panePid) {
      if (!panePid) return null;
      try {
        const pids = fs2.readdirSync("/proc").filter((f) => /^\d+$/.test(f));
        for (const pid of pids) {
          try {
            const stat = fs2.readFileSync(`/proc/${pid}/stat`, "utf8");
            const parts = stat.split(" ");
            const ppid = parts[3];
            if (ppid === String(panePid)) {
              const cmdline = fs2.readFileSync(`/proc/${pid}/cmdline`, "utf8");
              const match = cmdline.match(/--session-id[ \x00]+([a-f0-9-]+)/i);
              if (match && match[1]) {
                return match[1];
              }
            }
          } catch (e) {
          }
        }
      } catch (err) {
      }
      return null;
    }
    function findClaudeSessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir) {
      const slug = getProjectSlug(workspacePath);
      if (!slug) return null;
      const targetSessionId = explicitSessionId || getSessionIdFromPanePid(panePid);
      if (!targetSessionId) {
        return null;
      }
      const projectDirs = getClaudeProjectsDirs(userHomeDir, sysHomeDir);
      for (const baseDir of projectDirs) {
        const projectPath = path2.join(baseDir, slug);
        if (!fs2.existsSync(projectPath)) continue;
        const targetFile = path2.join(projectPath, `${targetSessionId}.jsonl`);
        if (fs2.existsSync(targetFile)) {
          return {
            filePath: targetFile,
            sessionId: targetSessionId,
            projectPath
          };
        }
      }
      return {
        filePath: null,
        sessionId: targetSessionId,
        projectPath: null
      };
    }
    function extractUserText(rawContent, event) {
      if (!rawContent) return "";
      if (typeof rawContent === "string") {
        if (rawContent.includes("<local-command-caveat>")) return "";
        if (rawContent.includes("<command-name>")) {
          const match = rawContent.match(/<command-message>(.*?)<\/command-message>/s) || rawContent.match(/<command-name>(.*?)<\/command-name>/s);
          if (match && match[1]) {
            const cmd = match[1].trim();
            if (cmd === "clear" || cmd === "/clear") return "";
            return cmd;
          }
        }
        return rawContent.trim();
      }
      if (Array.isArray(rawContent)) {
        const textPieces = [];
        for (const item of rawContent) {
          if (typeof item === "string") {
            const cleaned = extractUserText(item, event);
            if (cleaned) textPieces.push(cleaned);
          } else if (item && typeof item === "object") {
            if (item.type === "text" && item.text) {
              const cleaned = extractUserText(item.text, event);
              if (cleaned) textPieces.push(cleaned);
            } else if (item.type === "tool_result") {
              if (event && event.toolUseResult && event.toolUseResult.answers) {
                const ansList = Object.entries(event.toolUseResult.answers).map(([q, a]) => `**${q}**
\u21B3 ${a}`).join("\n\n");
                textPieces.push(`\u{1F4CB} **\u5DF2\u56DE\u7B54\u667A\u80FD\u4F53\u63D0\u95EE\uFF1A**

${ansList}`);
              } else if (typeof item.content === "string" && item.content.startsWith("Your questions have been answered:")) {
                const cleanContent = item.content.replace(/^Your questions have been answered:\s*/, "").replace(/\.\s*You can now continue with these answers in mind\./, "");
                textPieces.push(`\u{1F4CB} **\u5DF2\u56DE\u7B54\u667A\u80FD\u4F53\u63D0\u95EE\uFF1A**

${cleanContent}`);
              } else if (event && event.toolDenialKind === "user-rejected" || typeof item.content === "string" && item.content.includes("user doesn't want to proceed")) {
                textPieces.push(`\u{1F6D1} **\u5DF2\u62D2\u7EDD\u6B64\u5DE5\u5177\u6267\u884C\u64CD\u4F5C**`);
              }
            }
          }
        }
        return textPieces.join("\n\n").trim();
      }
      if (typeof rawContent === "object") {
        if (rawContent.type === "text" && rawContent.text) {
          return extractUserText(rawContent.text, event);
        }
        if (rawContent.text && typeof rawContent.text === "string") {
          return extractUserText(rawContent.text, event);
        }
      }
      return "";
    }
    async function parseClaudeJsonl(filePath, maxMessages = 50) {
      if (!filePath || !fs2.existsSync(filePath)) {
        return { messages: [], lastUpdated: null };
      }
      const fileStream = fs2.createReadStream(filePath, { encoding: "utf8" });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      const parsedEvents = [];
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const item = JSON.parse(trimmed);
          parsedEvents.push(item);
        } catch (err) {
        }
      }
      const messages = [];
      const toolUses = /* @__PURE__ */ new Map();
      const toolResults = /* @__PURE__ */ new Set();
      for (const event of parsedEvents) {
        if (event.commandRun && (event.commandRun.command === "clear" || event.commandRun.command === "/clear")) {
          messages.length = 0;
          toolUses.clear();
          toolResults.clear();
          continue;
        }
        if (event.type === "user" && event.message && typeof event.message.content === "string" && event.message.content.includes("<command-name>/clear")) {
          messages.length = 0;
          toolUses.clear();
          toolResults.clear();
          continue;
        }
        if (event.type === "user" && event.message && event.message.content) {
          if (event.isMeta) continue;
          if (Array.isArray(event.message.content)) {
            for (const item of event.message.content) {
              if (item && item.type === "tool_result" && item.tool_use_id) {
                toolResults.add(item.tool_use_id);
              }
            }
          }
          const cleanText = extractUserText(event.message.content, event);
          if (!cleanText) continue;
          messages.push({
            id: event.uuid || `user-${messages.length}`,
            role: "user",
            timestamp: event.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
            content: cleanText
          });
        }
        if (event.type === "assistant" && event.message && event.message.content) {
          const contentList = Array.isArray(event.message.content) ? event.message.content : [{ type: "text", text: String(event.message.content) }];
          let textParts = [];
          let thinkingParts = [];
          let tools = [];
          for (const part of contentList) {
            if (part.type === "text" && part.text) {
              textParts.push(part.text);
            } else if (part.type === "thinking" && part.thinking) {
              thinkingParts.push(part.thinking);
            } else if (part.type === "tool_use") {
              const isAskQ = part.name === "AskUserQuestion";
              const tInfo = {
                id: part.id,
                name: part.name || "tool",
                input: part.input || {},
                isAskQuestion: isAskQ,
                questions: isAskQ && part.input && part.input.questions ? part.input.questions : []
              };
              tools.push(tInfo);
              if (part.id) {
                toolUses.set(part.id, tInfo);
              }
            }
          }
          const askTool = tools.find((t) => t.isAskQuestion);
          if (askTool && textParts.length === 0 && askTool.questions && askTool.questions.length > 0) {
            const qSummary = askTool.questions.map((q, idx) => {
              const opts = (q.options || []).map((o, oIdx) => `   - **${oIdx + 1}. ${o.label}**${o.description ? `\uFF1A${o.description}` : ""}`).join("\n");
              return `${idx + 1}. **${q.question}**
${opts}`;
            }).join("\n\n");
            textParts.push(`\u2753 **\u667A\u80FD\u4F53\u53D1\u8D77\u63D0\u95EE\uFF1A**

${qSummary}`);
          }
          const combinedText = textParts.join("\n\n").trim();
          const combinedThinking = thinkingParts.join("\n\n").trim();
          if (combinedText || combinedThinking || tools.length > 0) {
            messages.push({
              id: event.uuid || `assistant-${messages.length}`,
              role: "assistant",
              timestamp: event.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
              content: combinedText,
              thinking: combinedThinking,
              tools
            });
          }
        }
      }
      let pendingAction = null;
      if (parsedEvents.length > 0) {
        let lastAssistantEvent = null;
        let lastAssistantIdx = -1;
        for (let i = parsedEvents.length - 1; i >= 0; i--) {
          if (parsedEvents[i].type === "assistant") {
            lastAssistantEvent = parsedEvents[i];
            lastAssistantIdx = i;
            break;
          }
        }
        const hasSubsequentUserMessage = parsedEvents.slice(lastAssistantIdx + 1).some((e) => e.type === "user" && !e.isMeta);
        if (lastAssistantEvent && lastAssistantEvent.message && !hasSubsequentUserMessage) {
          const contentList = Array.isArray(lastAssistantEvent.message.content) ? lastAssistantEvent.message.content : [];
          for (const part of contentList) {
            if (part.type === "tool_use" && part.id && !toolResults.has(part.id)) {
              if (part.name === "AskUserQuestion") {
                pendingAction = {
                  type: "ask_question",
                  toolUseId: part.id,
                  questions: part.input?.questions || [],
                  hint: "\u667A\u80FD\u4F53\u63D0\u51FA\u95EE\u9898\uFF0C\u8BF7\u5728\u4E0B\u65B9\u9009\u62E9\u56DE\u7B54"
                };
                break;
              } else {
                pendingAction = {
                  type: "permission",
                  toolUseId: part.id,
                  toolName: part.name || "tool",
                  toolInput: part.input || {},
                  hint: `\u667A\u80FD\u4F53\u8BF7\u6C42\u6743\u9650\u6267\u884C: ${part.name || "\u5DE5\u5177"}`
                };
                break;
              }
            }
          }
        }
      }
      if (!pendingAction && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "assistant" && lastMsg.content) {
          const contentLower = lastMsg.content.toLowerCase();
          if (contentLower.includes("(y/n)") || contentLower.includes("[y/n]") || contentLower.includes("proceed?") || contentLower.includes("continue?") || contentLower.includes("are you sure")) {
            pendingAction = {
              type: "yn",
              hint: "\u7B49\u5F85\u786E\u8BA4\u64CD\u4F5C"
            };
          }
        }
      }
      const trimmedMessages = messages.slice(-maxMessages);
      let mtime = null;
      try {
        mtime = fs2.statSync(filePath).mtimeMs;
      } catch (e) {
      }
      return {
        messages: trimmedMessages,
        pendingAction,
        lastUpdated: mtime
      };
    }
    function getAntigravityDirs(userHomeDir, sysHomeDir) {
      const dirs = [];
      if (userHomeDir) {
        dirs.push(path2.join(userHomeDir, ".gemini", "antigravity-cli"));
      }
      if (sysHomeDir && sysHomeDir !== userHomeDir) {
        dirs.push(path2.join(sysHomeDir, ".gemini", "antigravity-cli"));
      }
      const defaultHome = process.env.HOME || "/home/ubuntu";
      const defPath = path2.join(defaultHome, ".gemini", "antigravity-cli");
      if (!dirs.includes(defPath)) {
        dirs.push(defPath);
      }
      const adminUserData = "/home/ubuntu/tmux-agent-deck/user_data/admin/home/.gemini/antigravity-cli";
      if (!dirs.includes(adminUserData) && fs2.existsSync(adminUserData)) {
        dirs.push(adminUserData);
      }
      return dirs;
    }
    function getAgySessionIdFromPanePid(panePid) {
      if (!panePid) return null;
      try {
        const pids = fs2.readdirSync("/proc").filter((f) => /^\d+$/.test(f));
        const parentMap = /* @__PURE__ */ new Map();
        for (const pid of pids) {
          try {
            const stat = fs2.readFileSync(`/proc/${pid}/stat`, "utf8");
            const lastParen = stat.lastIndexOf(")");
            if (lastParen === -1) continue;
            const rest = stat.substring(lastParen + 2).split(" ");
            const ppid = rest[1];
            parentMap.set(pid, ppid);
          } catch (e) {
          }
        }
        const targetPids = /* @__PURE__ */ new Set();
        const queue = [String(panePid)];
        while (queue.length > 0) {
          const currentParent = queue.shift();
          for (const [pid, ppid] of parentMap.entries()) {
            if (ppid === currentParent && !targetPids.has(pid)) {
              targetPids.add(pid);
              queue.push(pid);
            }
          }
        }
        for (const pid of targetPids) {
          try {
            const cmdline = fs2.readFileSync(`/proc/${pid}/cmdline`, "utf8");
            const match = cmdline.match(/--conversation[ \x00=]+([a-f0-9-]{36})/i);
            if (match && match[1]) {
              return match[1];
            }
          } catch (e) {
          }
        }
        for (const pid of targetPids) {
          try {
            const fdDir = `/proc/${pid}/fd`;
            if (!fs2.existsSync(fdDir)) continue;
            const fds = fs2.readdirSync(fdDir);
            for (const fd of fds) {
              try {
                const link = fs2.readlinkSync(path2.join(fdDir, fd));
                const match = link.match(/presence\/([a-f0-9-]{36})\.lock$/i);
                if (match && match[1]) {
                  return match[1];
                }
              } catch (e) {
              }
            }
          } catch (e) {
          }
        }
        for (const pid of targetPids) {
          try {
            const fdDir = `/proc/${pid}/fd`;
            if (!fs2.existsSync(fdDir)) continue;
            const fds = fs2.readdirSync(fdDir).sort((a, b) => {
              const numA = parseInt(a, 10) || 0;
              const numB = parseInt(b, 10) || 0;
              return numB - numA;
            });
            for (const fd of fds) {
              try {
                const link = fs2.readlinkSync(path2.join(fdDir, fd));
                const match = link.match(/(?:conversations|brain)\/([a-f0-9-]{36})/i);
                if (match && match[1]) {
                  return match[1];
                }
              } catch (e) {
              }
            }
          } catch (e) {
          }
        }
      } catch (err) {
      }
      return null;
    }
    function getAgySessionIdFromHistory(workspacePath, userHomeDir, sysHomeDir) {
      if (!workspacePath) return null;
      const normalizedWs = path2.resolve(workspacePath).replace(/\/+$/, "");
      const agyDirs = getAntigravityDirs(userHomeDir, sysHomeDir);
      for (const baseDir of agyDirs) {
        const historyFile = path2.join(baseDir, "history.jsonl");
        if (!fs2.existsSync(historyFile)) continue;
        try {
          const stats = fs2.statSync(historyFile);
          const readSize = Math.min(stats.size, 65536);
          const buffer = Buffer.alloc(readSize);
          const fd = fs2.openSync(historyFile, "r");
          fs2.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
          fs2.closeSync(fd);
          const lines = buffer.toString("utf8").split("\n").filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const item = JSON.parse(lines[i]);
              if (item && item.conversationId && item.workspace) {
                const itemWs = path2.resolve(item.workspace).replace(/\/+$/, "");
                if (itemWs === normalizedWs) {
                  return item.conversationId;
                }
              }
            } catch (e) {
            }
          }
        } catch (e) {
        }
      }
      return null;
    }
    function findAgySessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir) {
      const targetSessionId = explicitSessionId || getAgySessionIdFromPanePid(panePid);
      if (!targetSessionId) {
        return null;
      }
      const agyDirs = getAntigravityDirs(userHomeDir, sysHomeDir);
      for (const baseDir of agyDirs) {
        const transcriptPath = path2.join(baseDir, "brain", targetSessionId, ".system_generated", "logs", "transcript.jsonl");
        if (fs2.existsSync(transcriptPath)) {
          return {
            filePath: transcriptPath,
            sessionId: targetSessionId,
            projectPath: path2.join(baseDir, "brain", targetSessionId),
            agentType: "agy"
          };
        }
        const transcriptFullPath = path2.join(baseDir, "brain", targetSessionId, ".system_generated", "logs", "transcript_full.jsonl");
        if (fs2.existsSync(transcriptFullPath)) {
          return {
            filePath: transcriptFullPath,
            sessionId: targetSessionId,
            projectPath: path2.join(baseDir, "brain", targetSessionId),
            agentType: "agy"
          };
        }
      }
      return {
        filePath: null,
        sessionId: targetSessionId,
        projectPath: null,
        agentType: "agy"
      };
    }
    function findAgentSessionFile(agentType, workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir) {
      const lowerAgent = (agentType || "").toLowerCase();
      if (lowerAgent === "agy" || lowerAgent === "antigravity") {
        const res = findAgySessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir);
        if (res) return res;
        return {
          filePath: null,
          sessionId: explicitSessionId || null,
          projectPath: null,
          agentType: "agy"
        };
      }
      if (lowerAgent === "claude") {
        const res = findClaudeSessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir);
        if (res) {
          res.agentType = "claude";
          return res;
        }
        return {
          filePath: null,
          sessionId: explicitSessionId || null,
          projectPath: null,
          agentType: "claude"
        };
      }
      const agyPidSess = getAgySessionIdFromPanePid(panePid);
      if (agyPidSess) {
        const agyRes = findAgySessionFile(workspacePath, agyPidSess, panePid, userHomeDir, sysHomeDir);
        if (agyRes) return agyRes;
      }
      const claudePidSess = getSessionIdFromPanePid(panePid);
      if (claudePidSess) {
        const claudeRes = findClaudeSessionFile(workspacePath, claudePidSess, panePid, userHomeDir, sysHomeDir);
        if (claudeRes) {
          claudeRes.agentType = "claude";
          return claudeRes;
        }
      }
      const claudeCheck = findClaudeSessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir);
      if (claudeCheck && claudeCheck.filePath) {
        claudeCheck.agentType = "claude";
        return claudeCheck;
      }
      const agyCheck = findAgySessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir);
      if (agyCheck && agyCheck.filePath) {
        agyCheck.agentType = "agy";
        return agyCheck;
      }
      return null;
    }
    function extractAgyUserText(content) {
      if (!content) return "";
      let text = String(content);
      const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
      if (reqMatch && reqMatch[1]) {
        return reqMatch[1].trim();
      }
      text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "");
      text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "");
      return text.trim();
    }
    async function parseAgyJsonl(filePath, maxMessages = 50) {
      if (!filePath || !fs2.existsSync(filePath)) {
        return { messages: [], lastUpdated: null, pendingAction: null };
      }
      const fileStream = fs2.createReadStream(filePath, { encoding: "utf8" });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      const parsedEvents = [];
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          parsedEvents.push(JSON.parse(trimmed));
        } catch (err) {
        }
      }
      const messages = [];
      let currentAssistantMsg = null;
      const answeredQuestionSteps = /* @__PURE__ */ new Set();
      for (const ev of parsedEvents) {
        if (ev.type === "ASK_QUESTION" && ev.step_index !== void 0) {
          answeredQuestionSteps.add(ev.step_index - 1);
        }
      }
      for (const event of parsedEvents) {
        if (event.source === "USER_EXPLICIT" && event.type === "USER_INPUT") {
          const cleanText = extractAgyUserText(event.content);
          if (!cleanText) continue;
          if (cleanText.toLowerCase() === "/clear") {
            messages.length = 0;
            currentAssistantMsg = null;
            continue;
          }
          currentAssistantMsg = null;
          messages.push({
            id: `user-${event.step_index}`,
            role: "user",
            timestamp: event.created_at || (/* @__PURE__ */ new Date()).toISOString(),
            content: cleanText
          });
          continue;
        }
        if (event.source === "MODEL" && event.type === "PLANNER_RESPONSE") {
          if (!currentAssistantMsg) {
            currentAssistantMsg = {
              id: `assistant-${event.step_index}`,
              role: "assistant",
              timestamp: event.created_at || (/* @__PURE__ */ new Date()).toISOString(),
              content: "",
              thinking: "",
              tools: []
            };
            messages.push(currentAssistantMsg);
          }
          if (event.thinking) {
            currentAssistantMsg.thinking = String(event.thinking).trim();
          }
          if (event.content) {
            const text = String(event.content).trim();
            if (text) {
              currentAssistantMsg.content = currentAssistantMsg.content ? currentAssistantMsg.content + "\n\n" + text : text;
            }
          }
          if (Array.isArray(event.tool_calls)) {
            for (const tc of event.tool_calls) {
              const isAskQ = tc.name === "ask_question" || tc.name === "AskUserQuestion";
              let rawArgs = tc.args || {};
              let normalizedArgs = {};
              if (typeof rawArgs === "string") {
                try {
                  rawArgs = JSON.parse(rawArgs);
                } catch (e) {
                }
              }
              if (rawArgs && typeof rawArgs === "object") {
                for (const [k, v] of Object.entries(rawArgs)) {
                  if (typeof v === "string") {
                    try {
                      normalizedArgs[k] = JSON.parse(v);
                    } catch (e) {
                      normalizedArgs[k] = v;
                    }
                  } else {
                    normalizedArgs[k] = v;
                  }
                }
              }
              let questions = [];
              if (isAskQ) {
                let qList = normalizedArgs.questions;
                if (typeof qList === "string") {
                  try {
                    qList = JSON.parse(qList);
                  } catch (e) {
                  }
                }
                if (Array.isArray(qList)) {
                  questions = qList.map((q) => {
                    const opts = Array.isArray(q.options) ? q.options.map((o, idx) => {
                      if (typeof o === "string") return { label: o, description: "" };
                      return { label: o.label || o.text || `\u9009\u9879 ${idx + 1}`, description: o.description || "" };
                    }) : [];
                    return {
                      question: q.question || "",
                      options: opts,
                      multiSelect: Boolean(q.is_multi_select || q.multiSelect)
                    };
                  });
                }
              }
              const toolItem = {
                id: `tool-${event.step_index}-${tc.name}`,
                name: tc.name || "tool",
                input: normalizedArgs,
                isAskQuestion: isAskQ,
                questions
              };
              currentAssistantMsg.tools.push(toolItem);
            }
          }
        }
      }
      let pendingAction = null;
      if (parsedEvents.length > 0) {
        const lastEvent = parsedEvents[parsedEvents.length - 1];
        if (lastEvent && lastEvent.source === "MODEL" && lastEvent.type === "PLANNER_RESPONSE") {
          const askCall = (lastEvent.tool_calls || []).find((t) => t.name === "ask_question" || t.name === "AskUserQuestion");
          if (askCall) {
            let rawArgs = askCall.args || {};
            if (typeof rawArgs === "string") {
              try {
                rawArgs = JSON.parse(rawArgs);
              } catch (e) {
              }
            }
            let qList = rawArgs.questions;
            if (typeof qList === "string") {
              try {
                qList = JSON.parse(qList);
              } catch (e) {
              }
            }
            const questions = Array.isArray(qList) ? qList.map((q) => {
              const opts = Array.isArray(q.options) ? q.options.map((o, idx) => {
                if (typeof o === "string") return { label: o, description: "" };
                return { label: o.label || o.text || `\u9009\u9879 ${idx + 1}`, description: o.description || "" };
              }) : [];
              return {
                question: q.question || "",
                options: opts,
                multiSelect: Boolean(q.is_multi_select || q.multiSelect)
              };
            }) : [];
            pendingAction = {
              type: "ask_question",
              toolUseId: `tool-${lastEvent.step_index}-ask_question`,
              questions,
              hint: "\u667A\u80FD\u4F53\u63D0\u51FA\u95EE\u9898\uFF0C\u8BF7\u5728\u4E0B\u65B9\u9009\u62E9\u56DE\u7B54"
            };
          }
        }
      }
      if (!pendingAction && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "assistant" && lastMsg.content) {
          const contentLower = lastMsg.content.toLowerCase();
          if (contentLower.includes("(y/n)") || contentLower.includes("[y/n]") || contentLower.includes("proceed?") || contentLower.includes("continue?") || contentLower.includes("are you sure")) {
            pendingAction = {
              type: "yn",
              hint: "\u7B49\u5F85\u786E\u8BA4\u64CD\u4F5C"
            };
          }
        }
      }
      const trimmedMessages = messages.slice(-maxMessages);
      let mtime = null;
      try {
        mtime = fs2.statSync(filePath).mtimeMs;
      } catch (e) {
      }
      return {
        messages: trimmedMessages,
        pendingAction,
        lastUpdated: mtime
      };
    }
    var PARSE_CACHE_MAX = 64;
    var parseCache = /* @__PURE__ */ new Map();
    async function parseAgentChat(agentType, filePath, maxMessages = 50) {
      const lower = (agentType || "").toLowerCase();
      if (!filePath) {
        return { messages: [], lastUpdated: null, pendingAction: null };
      }
      let stat = null;
      try {
        stat = fs2.statSync(filePath);
      } catch (e) {
        return { messages: [], lastUpdated: null, pendingAction: null };
      }
      const cacheKey = `${lower}::${filePath}::${maxMessages}`;
      const cached = parseCache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.result;
      }
      const result = lower === "agy" || lower === "antigravity" ? await parseAgyJsonl(filePath, maxMessages) : await parseClaudeJsonl(filePath, maxMessages);
      if (parseCache.size >= PARSE_CACHE_MAX) {
        const oldestKey = parseCache.keys().next().value;
        parseCache.delete(oldestKey);
      }
      parseCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, result });
      return result;
    }
    module2.exports = {
      getProjectSlug,
      getClaudeProjectsDirs,
      getSessionIdFromPanePid,
      findClaudeSessionFile,
      parseClaudeJsonl,
      getAntigravityDirs,
      getAgySessionIdFromPanePid,
      getAgySessionIdFromHistory,
      findAgySessionFile,
      findAgentSessionFile,
      parseAgyJsonl,
      parseAgentChat
    };
  }
});

// client/oar-runtime.js
var require_oar_runtime = __commonJS({
  "client/oar-runtime.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var crypto = require("crypto");
    var AGENT_TO_OAR_RUNTIME = {
      agy: "antigravity",
      antigravity: "antigravity",
      claude: "claude",
      "claude-code": "claude",
      claudecode: "claude",
      codex: "codex",
      "codex-cli": "codex",
      kimi: "kimi",
      "kimi-code": "kimi",
      "kimi-cli": "kimi",
      pi: "pi",
      grok: "grok",
      opencode: "opencode",
      qwen: "qwen",
      qoder: "qoder",
      codebuddy: "codebuddy",
      dsh: "dsh",
      devin: "devin",
      factory: "factory"
    };
    var RUNTIME_EXPORT_NAME = {
      antigravity: "antigravityRuntime",
      claude: "claudeRuntime",
      codex: "codexRuntime",
      kimi: "kimiRuntime",
      pi: "piRuntime",
      grok: "grokRuntime",
      opencode: "opencodeRuntime",
      qwen: "qwenRuntime",
      qoder: "qoderRuntime",
      codebuddy: "codebuddyRuntime",
      dsh: "dshRuntime",
      devin: "devinRuntime",
      factory: "factoryRuntime"
    };
    var OAR_RETAINED_BYTES = 8 * 1024 * 1024;
    var SUPPORTED_IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
    function createDeviceOarManager(options = {}) {
      const storageDir = options.storageDir || path2.join(os.homedir(), ".ccnow", "oar_sessions");
      const resolveEsmUrl = typeof options.resolveEsmUrl === "function" ? options.resolveEsmUrl : null;
      const activeSessions = /* @__PURE__ */ new Map();
      const runtimeCache = /* @__PURE__ */ new Map();
      let rootOarPromise = null;
      let capsModulePromise = null;
      async function importOarSpecifier(specifier) {
        try {
          return await import(specifier);
        } catch (primaryErr) {
          if (resolveEsmUrl) {
            const fallbackUrl = resolveEsmUrl(specifier);
            if (fallbackUrl) {
              return await import(fallbackUrl);
            }
          }
          throw primaryErr;
        }
      }
      function ensureStorageDir() {
        if (!fs2.existsSync(storageDir)) {
          try {
            fs2.mkdirSync(storageDir, { recursive: true });
          } catch (_) {
          }
        }
        return storageDir;
      }
      function getSessionFile(sessionName) {
        const safeName = String(sessionName || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
        return path2.join(ensureStorageDir(), `${safeName}.json`);
      }
      function getRootOar() {
        if (!rootOarPromise) {
          rootOarPromise = importOarSpecifier("@botiverse/oar").catch((err) => {
            console.warn("[DeviceOAR] @botiverse/oar not available on this device:", err.message);
            rootOarPromise = null;
            return null;
          });
        }
        return rootOarPromise;
      }
      function getCapabilitiesModule() {
        if (!capsModulePromise) {
          capsModulePromise = importOarSpecifier("@botiverse/oar/capabilities").catch(() => {
            capsModulePromise = null;
            return null;
          });
        }
        return capsModulePromise;
      }
      async function loadBuiltinRuntime(runtimeId) {
        if (!runtimeId || !RUNTIME_EXPORT_NAME[runtimeId]) return null;
        if (runtimeCache.has(runtimeId)) return runtimeCache.get(runtimeId);
        const promise = (async () => {
          try {
            const mod = await importOarSpecifier(`@botiverse/oar/runtimes/${runtimeId}`);
            return mod[RUNTIME_EXPORT_NAME[runtimeId]] || null;
          } catch (err) {
            console.warn(`[DeviceOAR] Failed to load @botiverse/oar/runtimes/${runtimeId}:`, err.message);
            runtimeCache.delete(runtimeId);
            return null;
          }
        })();
        runtimeCache.set(runtimeId, promise);
        return promise;
      }
      function resolveRuntimeId(agentType) {
        if (!agentType) return "claude";
        const norm = String(agentType).trim().toLowerCase();
        return AGENT_TO_OAR_RUNTIME[norm] || null;
      }
      function buildDeviceEnv() {
        const home = process.env.HOME || os.homedir();
        const nodeBinDir = path2.dirname(process.execPath);
        const pathParts = [
          nodeBinDir,
          path2.join(home, ".local", "bin"),
          path2.join(home, ".kimi-code", "bin"),
          "/usr/local/bin",
          process.env.PATH || "/usr/bin:/bin"
        ];
        const mergedPath = Array.from(new Set(pathParts.filter(Boolean))).join(":");
        if (process.env.PATH !== mergedPath) {
          process.env.PATH = mergedPath;
        }
        return {
          ...process.env,
          HOME: home,
          PATH: mergedPath
        };
      }
      function touchSession(sess) {
        const now = Date.now();
        sess.lastUpdated = sess.lastUpdated && now <= sess.lastUpdated ? sess.lastUpdated + 1 : now;
      }
      function loadPersisted(sessionName) {
        const file = getSessionFile(sessionName);
        if (!fs2.existsSync(file)) return null;
        try {
          return JSON.parse(fs2.readFileSync(file, "utf8"));
        } catch (_) {
          return null;
        }
      }
      function persistSession(sess) {
        if (!sess) return;
        try {
          const file = getSessionFile(sess.sessionName);
          fs2.writeFileSync(file, JSON.stringify({
            sessionName: sess.sessionName,
            agentType: sess.agentType,
            workspacePath: sess.workspacePath,
            model: sess.model || "",
            activeModel: sess.activeModel || null,
            oarSessionId: sess.oarSessionId || null,
            usage: sess.usage || null,
            contextUsage: sess.contextUsage || null,
            createdAt: sess.createdAt,
            lastUpdated: sess.lastUpdated,
            messages: sess.messages
          }, null, 2), "utf8");
        } catch (e) {
          console.warn("[DeviceOAR] Failed to persist session:", e.message);
        }
      }
      function parseToolInput(rawInput) {
        if (rawInput == null) return {};
        if (typeof rawInput === "object") return rawInput;
        const str = String(rawInput).trim();
        if (!str) return {};
        if (str.startsWith("{") || str.startsWith("[")) {
          try {
            return JSON.parse(str);
          } catch (_) {
            return { raw: str };
          }
        }
        return { command: str };
      }
      function summarizeToolOutput(contentParts) {
        if (!Array.isArray(contentParts) || contentParts.length === 0) return "";
        const chunks = [];
        for (const part of contentParts) {
          if (!part) continue;
          if (part.kind === "text" && typeof part.text === "string") chunks.push(part.text);
          else if (part.kind === "image") chunks.push(`[image: ${part.mediaType || "image"}]`);
          else if (typeof part === "string") chunks.push(part);
        }
        const combined = chunks.join("\n").trim();
        return combined.length > 4e3 ? combined.slice(0, 4e3) + "\n...(truncated)" : combined;
      }
      function validateWorkspaceImages(workspacePath, rawImages) {
        if (!Array.isArray(rawImages) || rawImages.length === 0) return [];
        const root = path2.resolve(workspacePath || process.cwd());
        const valid = [];
        for (const img of rawImages) {
          const candidate = typeof img === "string" ? img : img && (img.relativePath || img.path);
          if (!candidate || typeof candidate !== "string") continue;
          const resolved = path2.isAbsolute(candidate) ? path2.resolve(candidate) : path2.resolve(root, candidate);
          const rel = path2.relative(root, resolved);
          if (rel.startsWith("..") || path2.isAbsolute(rel)) continue;
          if (!SUPPORTED_IMAGE_EXT.test(resolved)) continue;
          if (fs2.existsSync(resolved)) {
            valid.push({ path: resolved });
          }
        }
        return valid;
      }
      function attachEvents(sess, liveSession) {
        if (typeof sess.unsubscribeEvents === "function") {
          try {
            sess.unsubscribeEvents();
          } catch (_) {
          }
          sess.unsubscribeEvents = null;
        }
        let persistTimer = null;
        const schedulePersist = () => {
          if (persistTimer) return;
          persistTimer = setTimeout(() => {
            persistTimer = null;
            persistSession(sess);
          }, 600);
        };
        const ensureAssistantMsg = () => {
          if (sess.activeAssistantMsg) return sess.activeAssistantMsg;
          const last = sess.messages[sess.messages.length - 1];
          if (last && last.role === "assistant") {
            sess.activeAssistantMsg = last;
            return last;
          }
          const msg = {
            id: `msg-asst-${Date.now()}`,
            role: "assistant",
            content: "",
            thinking: "",
            tools: [],
            timestamp: Date.now()
          };
          sess.messages.push(msg);
          sess.activeAssistantMsg = msg;
          return msg;
        };
        sess.unsubscribeEvents = liveSession.events((event) => {
          if (!event || !event.kind) return;
          const isRoot = !Array.isArray(event.agentPath) || event.agentPath.length === 0;
          switch (event.kind) {
            case "turn_started":
            case "turn_active":
              if (isRoot) {
                sess.isGenerating = true;
                sess.statusText = "OAR \u667A\u80FD\u4F53\u601D\u8003\u4E2D...";
                touchSession(sess);
              }
              break;
            case "reasoning":
              if (isRoot && event.content && event.content.kind === "text" && event.content.text) {
                const msg = ensureAssistantMsg();
                msg.thinking = (msg.thinking || "") + event.content.text;
                sess.statusText = "\u6B63\u5728\u6DF1\u5165\u601D\u8003...";
                touchSession(sess);
                schedulePersist();
              }
              break;
            case "text_delta":
              if (isRoot && event.text) {
                const msg = ensureAssistantMsg();
                msg.content = (msg.content || "") + event.text;
                sess.statusText = "\u6B63\u5728\u751F\u6210\u56DE\u590D...";
                touchSession(sess);
                schedulePersist();
              }
              break;
            case "tool_call_started":
              if (isRoot) {
                const msg = ensureAssistantMsg();
                if (!Array.isArray(msg.tools)) msg.tools = [];
                const toolName = event.toolName || event.tool || "tool";
                let entry = msg.tools.find((t) => t.id === event.callId);
                if (!entry) {
                  entry = {
                    id: event.callId,
                    name: toolName,
                    server: event.server || void 0,
                    input: parseToolInput(event.input),
                    _rawInputBuffer: typeof event.input === "string" ? event.input : "",
                    status: "running"
                  };
                  msg.tools.push(entry);
                } else {
                  entry.name = toolName;
                  if (event.input) entry.input = parseToolInput(event.input);
                  entry.status = "running";
                }
                sess.statusText = `\u6B63\u5728\u6267\u884C\u5DE5\u5177: ${toolName}...`;
                touchSession(sess);
                schedulePersist();
              }
              break;
            case "tool_call_input_delta":
              if (isRoot && event.callId && event.delta) {
                const msg = ensureAssistantMsg();
                const entry = Array.isArray(msg.tools) ? msg.tools.find((t) => t.id === event.callId) : null;
                if (entry) {
                  entry._rawInputBuffer = (entry._rawInputBuffer || "") + event.delta;
                  entry.input = parseToolInput(entry._rawInputBuffer);
                  touchSession(sess);
                }
              }
              break;
            case "tool_call_input":
              if (isRoot && event.callId) {
                const msg = ensureAssistantMsg();
                const entry = Array.isArray(msg.tools) ? msg.tools.find((t) => t.id === event.callId) : null;
                if (entry) {
                  entry._rawInputBuffer = typeof event.input === "string" ? event.input : "";
                  entry.input = parseToolInput(event.input);
                  touchSession(sess);
                  schedulePersist();
                }
              }
              break;
            case "tool_call_ended":
              if (isRoot && event.callId) {
                const msg = ensureAssistantMsg();
                const entry = Array.isArray(msg.tools) ? msg.tools.find((t) => t.id === event.callId) : null;
                if (entry) {
                  delete entry._rawInputBuffer;
                  entry.status = event.result || "ok";
                  if (event.exitCode !== void 0 && event.exitCode !== null) {
                    entry.exitCode = event.exitCode;
                  }
                  const out = summarizeToolOutput(event.content);
                  if (out) entry.output = out;
                  if (Array.isArray(event.fileChanges) && event.fileChanges.length > 0) {
                    entry.fileChanges = event.fileChanges;
                  }
                  touchSession(sess);
                  schedulePersist();
                }
              }
              break;
            case "usage":
              if (event.usage) {
                if (event.usage.total || event.usage.tokens) {
                  sess.usage = event.usage.total || event.usage.tokens;
                }
                if (event.usage.context) {
                  sess.contextUsage = event.usage.context;
                }
                if (sess.activeAssistantMsg && (event.usage.total || event.usage.tokens)) {
                  sess.activeAssistantMsg.usage = event.usage.total || event.usage.tokens;
                }
                touchSession(sess);
              }
              break;
            case "model":
              if (isRoot && event.model) {
                sess.activeModel = event.model;
                touchSession(sess);
              }
              break;
            case "compaction_started":
              if (isRoot) {
                sess.statusText = "\u6B63\u5728\u538B\u7F29\u4E0A\u4E0B\u6587...";
                touchSession(sess);
              }
              break;
            case "compaction_ended":
              if (isRoot) {
                sess.statusText = event.outcome === "completed" ? "\u4E0A\u4E0B\u6587\u538B\u7F29\u5B8C\u6210" : "\u5C31\u7EEA";
                touchSession(sess);
              }
              break;
            case "retry":
              if (isRoot) {
                sess.statusText = `\u6B63\u5728\u91CD\u8BD5 (\u7B2C ${event.attempt} \u6B21)...`;
                touchSession(sess);
              }
              break;
            case "turn_ended":
              if (isRoot) {
                const msg = sess.activeAssistantMsg;
                if (msg) {
                  if (Array.isArray(msg.tools)) {
                    for (const t of msg.tools) {
                      delete t._rawInputBuffer;
                      if (t.status === "running") t.status = "ok";
                    }
                  }
                  if (event.forkAnchor) msg.forkAnchor = event.forkAnchor;
                  const outcome = event.outcome;
                  if (outcome && outcome.kind === "aborted") {
                    if (!msg.content) msg.content = "*(\u5DF2\u4E2D\u6B62\u5F53\u524D\u751F\u6210)*";
                    else if (!msg.content.includes("\u5DF2\u4E2D\u6B62")) msg.content += "\n\n*(\u64CD\u4F5C\u5DF2\u7531\u7528\u6237\u624B\u52A8\u4E2D\u6B62)*";
                  } else if (outcome && outcome.kind === "failed") {
                    const reason = outcome.message || outcome.failure || "\u6267\u884C\u5931\u8D25";
                    if (!msg.content) msg.content = `\u274C [OAR \u8FD0\u884C\u65F6\u5F02\u5E38]: ${reason}`;
                    else msg.content += `

\u274C [\u5F02\u5E38]: ${reason}`;
                  } else if (!msg.content && (!msg.tools || msg.tools.length === 0)) {
                    msg.content = "\uFF08\u5DF2\u5B8C\u6210\u4EA4\u4E92\uFF09";
                  }
                }
                sess.isGenerating = false;
                sess.statusText = "\u5C31\u7EEA";
                sess.activeAssistantMsg = null;
                touchSession(sess);
                if (persistTimer) {
                  clearTimeout(persistTimer);
                  persistTimer = null;
                }
                persistSession(sess);
              }
              break;
            case "exited":
              if (isRoot) {
                if (sess.liveSession === liveSession) {
                  sess.liveSession = null;
                  sess.liveRuntimeId = null;
                  sess.unsubscribeEvents = null;
                }
                if (sess.isGenerating) {
                  sess.isGenerating = false;
                  sess.statusText = "\u5C31\u7EEA";
                  if (sess.activeAssistantMsg && !sess.activeAssistantMsg.content) {
                    sess.activeAssistantMsg.content = "*(\u5E95\u5C42\u8FD0\u884C\u65F6\u8FDB\u7A0B\u5DF2\u9000\u51FA\uFF0C\u4E0B\u6B21\u53D1\u9001\u6D88\u606F\u5C06\u81EA\u52A8\u6062\u590D\u4F1A\u8BDD)*";
                  }
                  sess.activeAssistantMsg = null;
                  touchSession(sess);
                  persistSession(sess);
                }
              }
              break;
            default:
              break;
          }
        }, { coalesceText: { maxHoldMs: 120 } });
      }
      async function disposeLive(sess) {
        if (!sess) return;
        if (typeof sess.unsubscribeEvents === "function") {
          try {
            sess.unsubscribeEvents();
          } catch (_) {
          }
          sess.unsubscribeEvents = null;
        }
        const live = sess.liveSession;
        sess.liveSession = null;
        sess.liveRuntimeId = null;
        if (live && typeof live.dispose === "function") {
          try {
            await live.dispose();
          } catch (_) {
          }
        }
      }
      async function ensureLiveSession(sess) {
        const runtimeId = resolveRuntimeId(sess.agentType);
        if (!runtimeId) return { session: null, error: `\u4E0D\u652F\u6301\u7684 OAR \u8FD0\u884C\u65F6\u7C7B\u578B: ${sess.agentType}` };
        if (sess.liveSession && sess.liveRuntimeId === runtimeId) {
          return { session: sess.liveSession, error: null };
        }
        if (sess.liveSession) {
          await disposeLive(sess);
        }
        const runtime = await loadBuiltinRuntime(runtimeId);
        if (!runtime || typeof runtime.session !== "function") {
          return {
            session: null,
            error: `\u5F53\u524D\u8BBE\u5907\u672A\u5B89\u88C5 @botiverse/oar \u6216\u4E0D\u652F\u6301\u8FD0\u884C\u65F6 "${runtimeId}"\uFF08\u9700 Node.js >= 24 \u4E14\u5B89\u88C5 @botiverse/oar\uFF09\u3002`
          };
        }
        const env = buildDeviceEnv();
        let installation = null;
        try {
          installation = await runtime.installation?.();
        } catch (err) {
          return { session: null, error: `\u63A2\u6D4B\u8FD0\u884C\u65F6 "${runtimeId}" \u5931\u8D25: ${err.message}` };
        }
        if (!installation || installation.kind !== "available") {
          return {
            session: null,
            error: `\u5F53\u524D\u8BBE\u5907\u672A\u68C0\u6D4B\u5230\u53EF\u7528\u7684 "${runtimeId}" CLI\uFF08\u72B6\u6001: ${installation?.kind || "not_found"}\uFF09\u3002`
          };
        }
        const capsMod = await getCapabilitiesModule();
        const preCaps = capsMod?.installedSessionCapabilities ? capsMod.installedSessionCapabilities(runtime, installation) : {};
        const refused = preCaps?.refusedSessionOptions || runtime.refusedSessionOptions || {};
        const cwd = sess.workspacePath && fs2.existsSync(sess.workspacePath) ? sess.workspacePath : process.cwd();
        const resolveLaunchModel = (rawModel) => {
          if (typeof rawModel !== "string") return null;
          const trimmed = rawModel.trim();
          if (!trimmed || trimmed === "default") return null;
          if (!/^[a-zA-Z0-9._:@/-]+$/.test(trimmed)) return null;
          return trimmed;
        };
        const resolvedModel = resolveLaunchModel(sess.model);
        const buildOpts = ({ includeResume = true, includeModel = true } = {}) => {
          const opts = { cwd, retainedBytes: OAR_RETAINED_BYTES };
          const sessionEnv = { ...env };
          if (includeModel && resolvedModel) {
            opts.model = resolvedModel;
            if (runtimeId === "claude") {
              sessionEnv.ANTHROPIC_MODEL = resolvedModel;
            } else if (runtimeId === "codex") {
              sessionEnv.OPENAI_MODEL = resolvedModel;
              sessionEnv.CODEX_MODEL = resolvedModel;
            }
          }
          if (!refused.env) opts.env = sessionEnv;
          if (includeResume && sess.oarSessionId) opts.resume = sess.oarSessionId;
          return opts;
        };
        let liveSession = null;
        try {
          liveSession = await runtime.session(installation, buildOpts({ includeResume: true, includeModel: true }));
        } catch (err) {
          const errName = err?.name || "";
          const isResumeErr = errName === "SessionNotFoundError" || errName === "SessionUnavailableError" || errName === "ResumeCwdError" || errName === "UnsupportedOptionError" && err?.option === "cwd";
          const isModelErr = errName === "ModelConfirmationError" || errName === "UnsupportedOptionError" && err?.option === "model";
          if (isResumeErr || isModelErr) {
            if (isResumeErr) sess.oarSessionId = null;
            try {
              liveSession = await runtime.session(installation, buildOpts({
                includeResume: !isResumeErr,
                includeModel: !isModelErr
              }));
            } catch (retryErr) {
              return { session: null, error: `\u542F\u52A8 "${runtimeId}" \u4F1A\u8BDD\u5931\u8D25: ${retryErr.message}` };
            }
          } else {
            return { session: null, error: `\u542F\u52A8 "${runtimeId}" \u4F1A\u8BDD\u5931\u8D25: ${err.message}` };
          }
        }
        sess.liveSession = liveSession;
        sess.liveRuntimeId = runtimeId;
        sess.oarSessionId = liveSession.id || sess.oarSessionId;
        sess.oarCapabilities = {
          runtimeId,
          version: installation.version || null,
          steer: typeof liveSession.steer === "function",
          withdraw: typeof liveSession.withdraw === "function",
          compact: typeof liveSession.compact === "function",
          images: Boolean(liveSession.capabilities?.images),
          durableQueue: Boolean(liveSession.capabilities?.queue?.durable),
          placement: liveSession.placement || null
        };
        const reportedModel = liveSession.model?.()?.value;
        if (reportedModel) sess.activeModel = reportedModel;
        attachEvents(sess, liveSession);
        touchSession(sess);
        persistSession(sess);
        return { session: liveSession, error: null };
      }
      function getOrCreateSession(sessionName, opts = {}) {
        if (activeSessions.has(sessionName)) {
          const existing = activeSessions.get(sessionName);
          if (opts.workspacePath) existing.workspacePath = opts.workspacePath;
          if (opts.agentType) existing.agentType = opts.agentType;
          if (opts.model) existing.model = opts.model;
          return existing;
        }
        const persisted = loadPersisted(sessionName);
        const agentType = opts.agentType || persisted && persisted.agentType || "claude";
        const workspacePath = opts.workspacePath || persisted && persisted.workspacePath || process.cwd();
        const sess = {
          sessionName,
          agentType,
          workspacePath,
          model: opts.model || persisted && persisted.model || "",
          activeModel: persisted && persisted.activeModel || null,
          oarSessionId: persisted && persisted.oarSessionId || null,
          usage: persisted && persisted.usage || null,
          contextUsage: persisted && persisted.contextUsage || null,
          createdAt: persisted && persisted.createdAt || Date.now(),
          lastUpdated: persisted && persisted.lastUpdated || Date.now(),
          messages: persisted && Array.isArray(persisted.messages) ? persisted.messages.filter((m) => m && m.id !== "msg-welcome") : [],
          isGenerating: false,
          statusText: "\u5C31\u7EEA",
          liveSession: null,
          liveRuntimeId: null,
          unsubscribeEvents: null,
          activeAssistantMsg: null,
          oarCapabilities: null
        };
        activeSessions.set(sessionName, sess);
        return sess;
      }
      function getHistorySnapshot(sessionName, opts = {}) {
        const sess = getOrCreateSession(sessionName, opts);
        return {
          supported: true,
          hasHistory: sess.messages.length > 0,
          sessionName: sess.sessionName,
          agentType: sess.agentType || "oar",
          sessionMode: "chat_only",
          workspacePath: sess.workspacePath,
          messages: sess.messages || [],
          pendingAction: null,
          isGenerating: Boolean(sess.isGenerating),
          statusText: sess.statusText || (sess.isGenerating ? "OAR \u667A\u80FD\u4F53\u601D\u8003\u4E2D..." : "\u5C31\u7EEA"),
          activeModel: sess.activeModel || sess.model || null,
          usage: sess.usage || null,
          contextUsage: sess.contextUsage || null,
          oarCapabilities: sess.oarCapabilities || null,
          lastUpdated: sess.lastUpdated || Date.now()
        };
      }
      async function sendMessage(sessionName, content, opts = {}) {
        const sess = getOrCreateSession(sessionName, opts);
        const trimmedText = String(content || "").trim();
        const nativeImages = validateWorkspaceImages(sess.workspacePath, opts.images);
        if (!trimmedText && nativeImages.length === 0) {
          throw new Error("Message content or images required");
        }
        const userMsg = {
          id: `msg-user-${Date.now()}`,
          role: "user",
          content: trimmedText || "[\u56FE\u7247\u9644\u4EF6]",
          timestamp: Date.now()
        };
        sess.messages.push(userMsg);
        touchSession(sess);
        const { session: liveSession, error } = await ensureLiveSession(sess);
        if (!liveSession) {
          const errMsg = {
            id: `msg-asst-${Date.now()}`,
            role: "assistant",
            content: `\u274C [\u8BBE\u5907\u7AEF OAR \u4E0D\u53EF\u7528]: ${error}`,
            timestamp: Date.now()
          };
          sess.messages.push(errMsg);
          sess.isGenerating = false;
          sess.statusText = "\u5C31\u7EEA";
          touchSession(sess);
          persistSession(sess);
          return { accepted: false, error, message: errMsg };
        }
        const inputOpts = { inputId: crypto.randomUUID() };
        if (nativeImages.length > 0 && liveSession.capabilities?.images) {
          inputOpts.images = nativeImages;
        }
        if (sess.isGenerating) {
          try {
            const delivery = await liveSession.deliver(trimmedText, { when: "now", ...inputOpts });
            sess.statusText = delivery.kind === "steered" ? "\u5DF2\u5B9E\u65F6\u8F6C\u5411\u5F53\u524D\u63A8\u7406..." : "\u5DF2\u52A0\u5165\u6267\u884C\u961F\u5217...";
            touchSession(sess);
            persistSession(sess);
            return { accepted: true, streaming: true, delivery: delivery.kind };
          } catch (deliverErr) {
            console.warn("[DeviceOAR] deliver() failed:", deliverErr.message);
          }
        }
        const assistantMsg = {
          id: `msg-asst-${Date.now()}`,
          role: "assistant",
          content: "",
          thinking: "",
          tools: [],
          timestamp: Date.now()
        };
        sess.messages.push(assistantMsg);
        sess.activeAssistantMsg = assistantMsg;
        sess.isGenerating = true;
        sess.statusText = "OAR \u667A\u80FD\u4F53\u601D\u8003\u4E2D...";
        touchSession(sess);
        persistSession(sess);
        (async () => {
          try {
            const oar = await getRootOar();
            if (oar && typeof oar.promptAndWait === "function") {
              const run = await oar.promptAndWait(liveSession, trimmedText, inputOpts);
              if (run && run.kind === "rejected") {
                assistantMsg.content = `[OAR \u8FD0\u884C\u65F6\u62D2\u7EDD]: ${run.reason || "\u5F53\u524D\u4F1A\u8BDD\u65E0\u6CD5\u63A5\u6536\u6307\u4EE4"}`;
              } else if (run && run.kind === "handled" && !assistantMsg.content) {
                assistantMsg.content = "\uFF08\u6307\u4EE4\u5DF2\u7531\u8FD0\u884C\u65F6\u539F\u751F\u5904\u7406\u5B8C\u6210\uFF09";
              }
            } else {
              await liveSession.prompt(trimmedText, inputOpts);
            }
            const latestModel = liveSession.model?.()?.value;
            if (latestModel) sess.activeModel = latestModel;
            const latestUsage = liveSession.usage?.()?.value?.total;
            if (latestUsage) {
              sess.usage = latestUsage;
              assistantMsg.usage = latestUsage;
            }
            const latestCtx = liveSession.contextUsage?.()?.value;
            if (latestCtx) sess.contextUsage = latestCtx;
            if (!assistantMsg.content && (!assistantMsg.tools || assistantMsg.tools.length === 0)) {
              assistantMsg.content = "\uFF08\u5DF2\u5B8C\u6210\u4EA4\u4E92\uFF09";
            }
          } catch (err) {
            if (!assistantMsg.content) {
              assistantMsg.content = `\u274C [OAR \u8FD0\u884C\u65F6\u5F02\u5E38]: ${err.message}`;
            }
          } finally {
            sess.isGenerating = false;
            sess.statusText = "\u5C31\u7EEA";
            sess.activeAssistantMsg = null;
            touchSession(sess);
            persistSession(sess);
          }
        })();
        return { accepted: true, streaming: true, isGenerating: true };
      }
      async function abortSession(sessionName) {
        const sess = activeSessions.get(sessionName);
        if (!sess) return false;
        let aborted = false;
        if (sess.liveSession && typeof sess.liveSession.abort === "function") {
          try {
            const outcome = await sess.liveSession.abort();
            aborted = Boolean(outcome && outcome.kind === "accepted");
          } catch (_) {
          }
        }
        if (aborted) {
          sess.isGenerating = false;
          sess.statusText = "\u5DF2\u4E2D\u6B62";
          touchSession(sess);
          persistSession(sess);
        }
        return aborted;
      }
      async function compactSession(sessionName, opts = {}) {
        const sess = getOrCreateSession(sessionName, opts);
        const { session: liveSession, error } = await ensureLiveSession(sess);
        if (!liveSession) {
          return { supported: false, outcome: "unavailable", message: error };
        }
        if (typeof liveSession.compact !== "function") {
          return {
            supported: false,
            outcome: "unsupported",
            message: `\u5F53\u524D\u8FD0\u884C\u65F6 (${sess.agentType}) \u6682\u4E0D\u652F\u6301\u539F\u751F /compact \u4E0A\u4E0B\u6587\u538B\u7F29\u3002`
          };
        }
        if (sess.isGenerating) {
          return {
            supported: true,
            outcome: "busy",
            message: "\u667A\u80FD\u4F53\u6B63\u5728\u751F\u6210\u4E2D\uFF0C\u8BF7\u7B49\u5F85\u5F53\u524D\u8F6E\u6B21\u5B8C\u6210\u540E\u518D\u6267\u884C /compact\u3002"
          };
        }
        sess.statusText = "\u6B63\u5728\u538B\u7F29\u4E0A\u4E0B\u6587...";
        touchSession(sess);
        try {
          const result = await liveSession.compact({ timeoutMs: 6e4 });
          const kind = result?.kind || "completed";
          const note = kind === "completed" ? "\u2705 \u5DF2\u5B8C\u6210\u4E0A\u4E0B\u6587\u538B\u7F29\uFF08OAR \u539F\u751F Compact\uFF09\uFF0C\u91CA\u653E\u4E86\u4E0A\u4E0B\u6587\u7A97\u53E3\u7A7A\u95F4\u3002" : `\u26A0\uFE0F \u4E0A\u4E0B\u6587\u538B\u7F29\u7ED3\u679C\uFF1A${kind}${result?.reason ? ` (${result.reason})` : ""}`;
          sess.messages.push({
            id: `msg-compact-${Date.now()}`,
            role: "assistant",
            content: note,
            timestamp: Date.now()
          });
          sess.statusText = "\u5C31\u7EEA";
          touchSession(sess);
          persistSession(sess);
          return { supported: true, outcome: kind, message: note };
        } catch (err) {
          sess.statusText = "\u5C31\u7EEA";
          touchSession(sess);
          return { supported: true, outcome: "failed", message: `\u274C \u4E0A\u4E0B\u6587\u538B\u7F29\u5931\u8D25: ${err.message}` };
        }
      }
      async function clearSession(sessionName) {
        const sess = activeSessions.get(sessionName) || getOrCreateSession(sessionName);
        await disposeLive(sess);
        sess.messages = [];
        sess.isGenerating = false;
        sess.statusText = "\u5C31\u7EEA";
        sess.activeAssistantMsg = null;
        sess.oarSessionId = null;
        sess.usage = null;
        sess.contextUsage = null;
        touchSession(sess);
        persistSession(sess);
        return true;
      }
      function deleteSession(sessionName) {
        const sess = activeSessions.get(sessionName);
        if (sess) {
          disposeLive(sess).catch(() => {
          });
          activeSessions.delete(sessionName);
        }
        const file = getSessionFile(sessionName);
        if (fs2.existsSync(file)) {
          try {
            fs2.unlinkSync(file);
          } catch (_) {
          }
        }
      }
      async function listAvailableRuntimes() {
        buildDeviceEnv();
        const oar = await getRootOar();
        if (!oar || !oar.defaultRuntimes) {
          return [];
        }
        const capsMod = await getCapabilitiesModule();
        const results = [];
        for (const rt of oar.defaultRuntimes.list()) {
          try {
            const inst = await rt.installation?.();
            const available = inst?.kind === "available";
            const caps = available && capsMod?.installedSessionCapabilities ? capsMod.installedSessionCapabilities(rt, inst) : null;
            results.push({
              id: rt.id,
              name: rt.brand?.name || rt.id,
              kind: inst?.kind || "unknown",
              available,
              version: inst?.version || null,
              command: inst?.command || null,
              execution: rt.execution || null,
              capabilities: caps ? {
                steer: Boolean(caps.steer),
                images: Boolean(caps.images),
                manualCompaction: caps.manualCompaction?.kind === "supported"
              } : null
            });
          } catch (err) {
            results.push({
              id: rt.id,
              name: rt.brand?.name || rt.id,
              kind: "error",
              available: false,
              error: err.message
            });
          }
        }
        return results;
      }
      return {
        getOrCreateSession,
        getHistorySnapshot,
        sendMessage,
        abortSession,
        compactSession,
        clearSession,
        deleteSession,
        listAvailableRuntimes
      };
    }
    module2.exports = {
      createDeviceOarManager
    };
  }
});

// client/src/chatHandlers.js
var require_chatHandlers = __commonJS({
  "client/src/chatHandlers.js"(exports2, module2) {
    var os = require("os");
    var fs2 = require("fs");
    var path2 = require("path");
    var { spawn, execFile, execFileSync } = require("child_process");
    var { promisify } = require("util");
    var execFileAsync = promisify(execFile);
    var { CONFIG_DIR: CONFIG_DIR2, hasCommand, safeResolve, tmuxArgs } = require_config();
    var { resolveOptionalEsmUrl } = require_depsManager();
    var { readTmuxSessionMeta } = require_tmuxHandlers();
    var sessionRegistry = require_sessionRegistry();
    var agentChatService = require_agentChatService();
    var { createDeviceOarManager } = require_oar_runtime();
    var runningTasks = /* @__PURE__ */ new Map();
    var deviceOarManager = null;
    function getDeviceOarManager() {
      if (deviceOarManager) return deviceOarManager;
      try {
        deviceOarManager = createDeviceOarManager({
          storageDir: path2.join(CONFIG_DIR2, "oar_sessions"),
          resolveEsmUrl: resolveOptionalEsmUrl
        });
        return deviceOarManager;
      } catch (err) {
        console.warn("\u26A0\uFE0F [ccnow-agent] Failed to initialize oar-runtime:", err.message);
        return null;
      }
    }
    async function handleClearContext(send, reqId, sessionName) {
      const oarMgr = getDeviceOarManager();
      if (oarMgr && sessionName) {
        try {
          await oarMgr.clearSession(sessionName);
        } catch (_) {
        }
      }
      const isPureChat = Boolean(sessionRegistry.getPureChatSession(sessionName));
      if (!isPureChat && hasCommand("tmux") && sessionName) {
        try {
          try {
            execFileSync("tmux", tmuxArgs(["set-option", "-u", "-t", sessionName, "@agent_session_id"]), { stdio: "ignore" });
          } catch (_) {
          }
          execFileSync("tmux", tmuxArgs(["send-keys", "-t", sessionName, "/clear", "C-m"]), { stdio: "ignore" });
        } catch (e) {
        }
      }
      if (reqId) {
        send({ action: "agent:clear_context_result", reqId, success: true });
      }
    }
    async function handleOarRuntimes(send, reqId) {
      const oarMgr = getDeviceOarManager();
      if (!oarMgr) {
        return send({ action: "oar:runtimes_result", reqId, runtimes: [], error: "OAR runtime unavailable" });
      }
      try {
        const runtimes = await oarMgr.listAvailableRuntimes();
        send({ action: "oar:runtimes_result", reqId, runtimes });
      } catch (err) {
        send({ action: "oar:runtimes_result", reqId, runtimes: [], error: err.message });
      }
    }
    async function handleOarMessage(send, reqId, msg) {
      const { sessionName, content, images } = msg;
      const oarMgr = getDeviceOarManager();
      if (!oarMgr) {
        return send({ action: "oar:message_result", reqId, accepted: false, error: "\u5F53\u524D\u8BBE\u5907\u672A\u52A0\u8F7D OAR \u7EAF\u4F1A\u8BDD\u5F15\u64CE" });
      }
      try {
        const meta = readTmuxSessionMeta(sessionName);
        const result = await oarMgr.sendMessage(sessionName, content || "", {
          agentType: meta.agentType,
          workspacePath: meta.workspacePath,
          model: meta.model,
          images: Array.isArray(images) ? images : []
        });
        send({ action: "oar:message_result", reqId, ...result });
      } catch (err) {
        send({ action: "oar:message_result", reqId, accepted: false, error: err.message });
      }
    }
    async function handleOarCompact(send, reqId, sessionName) {
      const oarMgr = getDeviceOarManager();
      if (!oarMgr) {
        return send({ action: "oar:compact_result", reqId, supported: false, message: "\u5F53\u524D\u8BBE\u5907\u672A\u52A0\u8F7D OAR \u5F15\u64CE" });
      }
      try {
        const meta = readTmuxSessionMeta(sessionName);
        const result = await oarMgr.compactSession(sessionName, {
          agentType: meta.agentType,
          workspacePath: meta.workspacePath,
          model: meta.model
        });
        send({ action: "oar:compact_result", reqId, ...result });
      } catch (err) {
        send({ action: "oar:compact_result", reqId, supported: false, error: err.message });
      }
    }
    async function handleOarAbort(send, reqId, sessionName) {
      const oarMgr = getDeviceOarManager();
      if (!oarMgr) {
        return send({ action: "oar:abort_result", reqId, aborted: false });
      }
      try {
        const aborted = await oarMgr.abortSession(sessionName);
        send({ action: "oar:abort_result", reqId, aborted });
      } catch (err) {
        send({ action: "oar:abort_result", reqId, aborted: false, error: err.message });
      }
    }
    async function handleChatHistory(send, reqId, sessionName, since) {
      try {
        const sinceNum = since !== void 0 && since !== null && since !== "" ? Number(since) : null;
        const pureChat = sessionRegistry.getPureChatSession(sessionName);
        if (pureChat) {
          const oarMgr = getDeviceOarManager();
          if (oarMgr) {
            const snapshot = oarMgr.getHistorySnapshot(sessionName, {
              agentType: pureChat.agentType || "claude",
              workspacePath: pureChat.workspacePath || process.cwd(),
              model: pureChat.modelName || ""
            });
            if (sinceNum && snapshot.lastUpdated === sinceNum && !snapshot.isGenerating && !snapshot.pendingAction) {
              return send({
                action: "agent:chat_history_result",
                reqId,
                sessionName,
                agentType: snapshot.agentType || pureChat.agentType || "claude",
                sessionMode: "chat_only",
                supported: true,
                notModified: true,
                isGenerating: false,
                lastUpdated: snapshot.lastUpdated
              });
            }
            return send({ action: "agent:chat_history_result", reqId, ...snapshot });
          }
        }
        const hasTmux = hasCommand("tmux");
        let sessionCwd = process.cwd();
        let agentType = "";
        let agentSessionId = null;
        let panePid = null;
        let sessionMode = "hybrid";
        if (hasTmux && sessionName) {
          try {
            const fmt = "#{session_path}|#{@workspace_name}|#{@agent_type}|#{@agent_session_id}|#{pane_pid}|#{@session_mode}";
            const { stdout } = await execFileAsync("tmux", tmuxArgs(["display-message", "-p", "-t", sessionName, fmt]), {
              encoding: "utf8"
            });
            const out = (stdout || "").trim();
            const parts = out.split("|");
            if (parts[0] && fs2.existsSync(parts[0])) sessionCwd = parts[0];
            agentType = (parts[2] || "").trim();
            agentSessionId = parts[3] && parts[3].trim() ? parts[3].trim() : null;
            panePid = parts[4] && parts[4].trim() ? parts[4].trim() : null;
            const rawMode = parts[5] && parts[5].trim() ? parts[5].trim() : "";
            sessionMode = rawMode || (agentType === "default" ? "terminal_only" : "hybrid");
          } catch (e) {
          }
        }
        if (sessionMode === "chat_only") {
          const oarMgr = getDeviceOarManager();
          if (oarMgr) {
            const snapshot = oarMgr.getHistorySnapshot(sessionName, {
              agentType: agentType || "claude",
              workspacePath: sessionCwd
            });
            if (sinceNum && snapshot.lastUpdated === sinceNum && !snapshot.isGenerating && !snapshot.pendingAction) {
              return send({
                action: "agent:chat_history_result",
                reqId,
                sessionName,
                agentType: snapshot.agentType || agentType || "claude",
                sessionMode: "chat_only",
                supported: true,
                notModified: true,
                isGenerating: false,
                lastUpdated: snapshot.lastUpdated
              });
            }
            return send({ action: "agent:chat_history_result", reqId, ...snapshot });
          }
        }
        const homeDir = os.homedir();
        const match = agentChatService.findAgentSessionFile(
          agentType || "claude",
          sessionCwd,
          agentSessionId,
          panePid,
          homeDir,
          homeDir
        );
        if (match && match.filePath && fs2.existsSync(match.filePath)) {
          if (sinceNum) {
            try {
              const stat = fs2.statSync(match.filePath);
              if (stat.mtimeMs === sinceNum) {
                return send({
                  action: "agent:chat_history_result",
                  reqId,
                  sessionName,
                  agentType: agentType || "claude",
                  agentSessionId: match.sessionId || agentSessionId,
                  sessionMode,
                  supported: true,
                  notModified: true,
                  lastUpdated: stat.mtimeMs
                });
              }
            } catch (_) {
            }
          }
          const parsed2 = await agentChatService.parseAgentChat(agentType || "claude", match.filePath, 50);
          return send({
            action: "agent:chat_history_result",
            reqId,
            sessionName,
            agentType: agentType || "claude",
            agentSessionId: match.sessionId || agentSessionId,
            sessionMode,
            supported: true,
            pendingAction: parsed2.pendingAction || null,
            lastUpdated: parsed2.lastUpdated || Date.now(),
            messages: parsed2.messages || []
          });
        }
        return send({
          action: "agent:chat_history_result",
          reqId,
          sessionName,
          agentType,
          agentSessionId: match && match.sessionId || agentSessionId,
          sessionMode,
          supported: true,
          pendingAction: null,
          lastUpdated: Date.now(),
          messages: []
        });
      } catch (e) {
        console.warn("\u26A0\uFE0F [ccnow-agent] Failed to parse chat history:", e.message);
        send({
          action: "agent:chat_history_result",
          reqId,
          sessionName,
          sessionMode: "hybrid",
          supported: true,
          lastUpdated: Date.now(),
          messages: []
        });
      }
    }
    function resolveSessionWorkspace(sessionName) {
      const pureChat = sessionRegistry.getPureChatSession(sessionName);
      if (pureChat && pureChat.workspacePath && fs2.existsSync(pureChat.workspacePath)) {
        return pureChat.workspacePath;
      }
      if (hasCommand("tmux") && sessionName) {
        try {
          const out = execFileSync("tmux", tmuxArgs(["display-message", "-p", "-t", sessionName, "#{session_path}"]), {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
          }).trim();
          if (out && fs2.existsSync(out)) return out;
        } catch (_) {
        }
      }
      return os.homedir();
    }
    function handleChatUpload(send, reqId, msg) {
      try {
        const { sessionName, files } = msg;
        const targetWorkspace = resolveSessionWorkspace(sessionName);
        const uploadDir = path2.join(targetWorkspace, ".deck", "uploads");
        if (!fs2.existsSync(uploadDir)) {
          fs2.mkdirSync(uploadDir, { recursive: true });
        }
        const uploadedFiles = [];
        for (const f of files || []) {
          const cleanName = path2.basename(f.originalName || "upload").replace(/[\x00-\x1f\x80-\x9f]/g, "").trim() || "upload";
          const ext = path2.extname(cleanName);
          const base = path2.basename(cleanName, ext);
          const uniqueName = `${base}_${Date.now()}${ext}`;
          const destPath = path2.join(uploadDir, uniqueName);
          const buf = Buffer.from(f.bufferBase64, "base64");
          fs2.writeFileSync(destPath, buf);
          const isImg = f.mimeType && f.mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(uniqueName);
          uploadedFiles.push({
            name: uniqueName,
            originalName: cleanName,
            relativePath: `.deck/uploads/${uniqueName}`,
            absolutePath: destPath,
            size: buf.length,
            mimeType: f.mimeType || "application/octet-stream",
            isImage: isImg
          });
        }
        send({ action: "agent:chat_upload_result", reqId, success: true, files: uploadedFiles });
      } catch (e) {
        send({ action: "agent:chat_upload_result", reqId, error: e.message });
      }
    }
    function handleChatAttachment(send, reqId, msg) {
      try {
        const { sessionName, filename } = msg || {};
        const cleanName = path2.basename(String(filename || ""));
        if (!cleanName) {
          return send({ action: "agent:chat_attachment_result", reqId, error: "Invalid filename" });
        }
        const targetWorkspace = resolveSessionWorkspace(sessionName);
        const filePath = safeResolve(targetWorkspace, path2.join(".deck", "uploads", cleanName));
        if (!fs2.existsSync(filePath)) {
          return send({ action: "agent:chat_attachment_result", reqId, error: "Attachment not found" });
        }
        const stat = fs2.statSync(filePath);
        if (stat.size > 15 * 1024 * 1024) {
          return send({ action: "agent:chat_attachment_result", reqId, error: "Attachment too large (>15MB)" });
        }
        const ext = path2.extname(cleanName).toLowerCase();
        const mimeMap = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".pdf": "application/pdf",
          ".txt": "text/plain; charset=utf-8",
          ".json": "application/json",
          ".md": "text/markdown; charset=utf-8"
        };
        const buf = fs2.readFileSync(filePath);
        send({
          action: "agent:chat_attachment_result",
          reqId,
          filename: cleanName,
          mimeType: mimeMap[ext] || "application/octet-stream",
          bufferBase64: buf.toString("base64")
        });
      } catch (e) {
        send({ action: "agent:chat_attachment_result", reqId, error: e.message });
      }
    }
    function executeAgentTask(send, msg) {
      const { sessionId, prompt, agentType, workDir } = msg;
      const targetDir = workDir && fs2.existsSync(workDir) ? workDir : process.cwd();
      console.log(`\u{1F916} [Agent Task] Session: ${sessionId} | Type: ${agentType || "claude-code"}`);
      let cmd = "claude";
      let args = ["--print", prompt];
      const hasClaude = hasCommand("claude");
      if (!hasClaude) {
        cmd = "bash";
        args = ["-c", `echo "\u{1F916} [ccnow-agent on ${os.hostname()}] Claude Code is not installed in PATH. (Install with: npm i -g @anthropic-ai/claude-code)

Running prompt as test command:"; echo "Prompt received: ${prompt.replace(/"/g, '\\"')}"`];
      }
      send({
        action: "agent:stream",
        sessionId,
        delta: `[ccnow-agent on ${os.hostname()}] Executing task with ${hasClaude ? "Claude Code" : "Local Shell"}...
`
      });
      let child;
      try {
        child = spawn(cmd, args, {
          cwd: targetDir,
          env: { ...process.env, FORCE_COLOR: "1" }
        });
      } catch (err) {
        send({ action: "agent:error", sessionId, error: `Failed to spawn agent process: ${err.message}` });
        return;
      }
      runningTasks.set(sessionId, child);
      child.stdout.on("data", (data) => send({ action: "agent:stream", sessionId, delta: data.toString() }));
      child.stderr.on("data", (data) => send({ action: "agent:stream", sessionId, delta: data.toString() }));
      child.on("close", (code) => {
        runningTasks.delete(sessionId);
        send({ action: "agent:done", sessionId, exitCode: code, status: code === 0 ? "success" : "failed" });
      });
      child.on("error", (err) => {
        runningTasks.delete(sessionId);
        send({ action: "agent:error", sessionId, error: err.message });
      });
    }
    function interruptAgentTask(sessionId) {
      if (sessionId && runningTasks.has(sessionId)) {
        console.log(`\u{1F6D1} Interrupting task for session ${sessionId}...`);
        const proc = runningTasks.get(sessionId);
        try {
          proc.kill("SIGINT");
        } catch (e) {
        }
      }
    }
    module2.exports = {
      getDeviceOarManager,
      handleClearContext,
      handleOarRuntimes,
      handleOarMessage,
      handleOarCompact,
      handleOarAbort,
      handleChatHistory,
      handleChatUpload,
      handleChatAttachment,
      executeAgentTask,
      interruptAgentTask
    };
  }
});

// client/src/updater.js
var require_updater = __commonJS({
  "client/src/updater.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { spawn } = require("child_process");
    var { CLIENT_VERSION: CLIENT_VERSION2, CONFIG_DIR: CONFIG_DIR2 } = require_config();
    function fetchUrl(targetUrl) {
      return new Promise((resolve, reject) => {
        let urlObj;
        try {
          urlObj = new URL(targetUrl);
        } catch (e) {
          return reject(new Error("Invalid URL: " + targetUrl));
        }
        const isHttps = urlObj.protocol === "https:";
        const lib = isHttps ? require("https") : require("http");
        const agent = isHttps ? new lib.Agent({ rejectUnauthorized: false }) : void 0;
        const req = lib.get(targetUrl, {
          timeout: 15e3,
          agent,
          headers: { "User-Agent": `ccnow-agent/${CLIENT_VERSION2}` }
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, targetUrl).toString();
            return fetchUrl(redirectUrl).then(resolve).catch(reject);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Server returned HTTP ${res.statusCode}`));
          }
          let rawData = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            rawData += chunk;
          });
          res.on("end", () => resolve(rawData));
        });
        req.on("error", (e) => reject(new Error(`Network error: ${e.message}`)));
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Connection timed out"));
        });
      });
    }
    async function downloadAndApplyUpdate2(serverUrl) {
      const cleanServer = serverUrl.trim().replace(/\/+$/, "");
      const agentUrl = `${cleanServer}/agent.js`;
      const code = await fetchUrl(agentUrl);
      if (!code.includes("ccnow-agent") || !code.startsWith("#!") && !code.includes("CLIENT_VERSION")) {
        throw new Error("Downloaded file does not appear to be a valid ccnow-agent script.");
      }
      const match = code.match(/CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/);
      const newVersion = match ? match[1] : "unknown";
      let targetPath = process.argv[1];
      if (!targetPath || targetPath === "-" || targetPath.includes("[eval]") || !fs2.existsSync(targetPath)) {
        if (!fs2.existsSync(CONFIG_DIR2)) {
          fs2.mkdirSync(CONFIG_DIR2, { recursive: true });
        }
        targetPath = path2.join(CONFIG_DIR2, "ccnow-agent.js");
      }
      const tmpPath = targetPath + ".tmp." + Date.now();
      fs2.writeFileSync(tmpPath, code, { mode: 493 });
      fs2.renameSync(tmpPath, targetPath);
      return { path: targetPath, version: newVersion };
    }
    function isRunningUnderServiceManager() {
      if (process.env.CCNOW_SERVICE_MANAGED === "1") return true;
      if (process.env.INVOCATION_ID) return true;
      if (process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME.includes("ccnow")) return true;
      return false;
    }
    function restartSelf() {
      if (isRunningUnderServiceManager()) {
        console.log("\u{1F504} Managed by system daemon (launchd/systemd); exiting cleanly for automatic restart...");
        process.exit(0);
        return;
      }
      let targetPath = process.argv[1];
      if (!targetPath || targetPath === "-" || targetPath.includes("[eval]") || !fs2.existsSync(targetPath)) {
        targetPath = path2.join(CONFIG_DIR2, "ccnow-agent.js");
      }
      const child = spawn(process.execPath, [targetPath, ...process.argv.slice(2)], {
        detached: true,
        stdio: "inherit"
      });
      child.unref();
      process.exit(0);
    }
    async function ensureLocalAgentScript(serverUrl, { forceDownload = false } = {}) {
      const scriptPath = path2.join(CONFIG_DIR2, "ccnow-agent.js");
      try {
        if (!fs2.existsSync(CONFIG_DIR2)) {
          fs2.mkdirSync(CONFIG_DIR2, { recursive: true });
        }
        const currentScript = process.argv[1];
        if (currentScript && currentScript !== "-" && !currentScript.includes("[eval]") && fs2.existsSync(currentScript)) {
          if (path2.resolve(currentScript) !== path2.resolve(scriptPath)) {
            fs2.copyFileSync(currentScript, scriptPath);
            fs2.chmodSync(scriptPath, 493);
            console.log(`\u{1F4BE} Agent script saved to ${scriptPath}`);
          }
          return scriptPath;
        }
        if ((forceDownload || !fs2.existsSync(scriptPath)) && serverUrl) {
          const cleanServer = serverUrl.trim().replace(/\/+$/, "");
          const code = await fetchUrl(`${cleanServer}/agent.js`);
          if (code && code.includes("ccnow-agent")) {
            const tmpPath = `${scriptPath}.tmp.${Date.now()}`;
            fs2.writeFileSync(tmpPath, code, { encoding: "utf8", mode: 493 });
            fs2.renameSync(tmpPath, scriptPath);
            fs2.chmodSync(scriptPath, 493);
            console.log(`\u{1F4BE} Agent script saved to ${scriptPath}`);
            return scriptPath;
          }
        }
        return fs2.existsSync(scriptPath) ? scriptPath : null;
      } catch (e) {
        console.warn("\u26A0\uFE0F Failed to persist local agent script:", e.message);
        return fs2.existsSync(scriptPath) ? scriptPath : null;
      }
    }
    async function handleSystemUpdate(send, defaultServerUrl, reqId, msg) {
      const serverUrl = msg.serverUrl || defaultServerUrl;
      console.log(`\u{1F504} Remote system update requested from ${serverUrl}...`);
      try {
        const updateResult = await downloadAndApplyUpdate2(serverUrl);
        send({
          reqId,
          action: "system:update_success",
          oldVersion: CLIENT_VERSION2,
          newVersion: updateResult.version,
          targetPath: updateResult.path,
          message: "Agent script updated successfully. Initiating auto-restart..."
        });
        console.log(`\u2728 Agent updated to ${updateResult.version}. Restarting daemon in 1s...`);
        setTimeout(() => restartSelf(), 1e3);
      } catch (err) {
        console.error("\u274C Remote system update failed:", err.message);
        send({ reqId, action: "system:update_error", error: err.message });
      }
    }
    module2.exports = {
      fetchUrl,
      downloadAndApplyUpdate: downloadAndApplyUpdate2,
      restartSelf,
      ensureLocalAgentScript,
      handleSystemUpdate
    };
  }
});

// client/src/serviceManager.js
var require_serviceManager = __commonJS({
  "client/src/serviceManager.js"(exports2, module2) {
    var os = require("os");
    var fs2 = require("fs");
    var path2 = require("path");
    var { execSync, spawn } = require("child_process");
    var { CONFIG_DIR: CONFIG_DIR2, readConfig: readConfig2 } = require_config();
    var MAC_LABEL = "com.ccnow.agent";
    var LINUX_UNIT = "ccnow-agent.service";
    function xmlEscape(str) {
      return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    }
    function systemdEscape(str) {
      return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }
    function getScriptDisplayPath() {
      const defaultDir = path2.join(os.homedir(), ".ccnow");
      if (path2.resolve(CONFIG_DIR2) === path2.resolve(defaultDir)) {
        return "~/.ccnow/ccnow-agent.js";
      }
      return path2.join(CONFIG_DIR2, "ccnow-agent.js");
    }
    function getLogDisplayPath() {
      const defaultDir = path2.join(os.homedir(), ".ccnow");
      if (path2.resolve(CONFIG_DIR2) === path2.resolve(defaultDir)) {
        return "~/.ccnow/agent.log";
      }
      return path2.join(CONFIG_DIR2, "agent.log");
    }
    function buildServiceEnv() {
      const home = os.homedir();
      const platform = os.platform();
      const nodeBinDir = path2.dirname(process.execPath);
      const rawParts = [
        ...process.env.PATH ? process.env.PATH.split(path2.delimiter) : [],
        nodeBinDir,
        path2.join(home, ".local", "bin"),
        path2.join(home, ".npm-global", "bin"),
        ...platform === "darwin" ? ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"] : ["/usr/local/bin", "/usr/local/sbin"],
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin"
      ];
      const seen = /* @__PURE__ */ new Set();
      const mergedPath = [];
      for (const dir of rawParts) {
        if (!dir) continue;
        if (!seen.has(dir)) {
          seen.add(dir);
          mergedPath.push(dir);
        }
      }
      const env = {
        HOME: home,
        PATH: mergedPath.join(":"),
        SHELL: process.env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
        LANG: process.env.LANG || "en_US.UTF-8",
        CCNOW_SERVICE_MANAGED: "1"
      };
      if (process.env.CCNOW_CONFIG_DIR) {
        env.CCNOW_CONFIG_DIR = process.env.CCNOW_CONFIG_DIR;
      }
      return env;
    }
    function getMacDomainTarget() {
      const uid = typeof process.getuid === "function" ? process.getuid() : Number(execSync("id -u", { encoding: "utf8" }).trim());
      return `gui/${uid}`;
    }
    function getMacPlistPath() {
      return path2.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
    }
    function getLinuxServicePath() {
      return path2.join(os.homedir(), ".config", "systemd", "user", LINUX_UNIT);
    }
    function stopMacService(plistPath) {
      const domain = getMacDomainTarget();
      try {
        execSync(`launchctl bootout "${domain}/${MAC_LABEL}" 2>/dev/null || true`, { stdio: "ignore" });
      } catch (_) {
      }
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { stdio: "ignore" });
      } catch (_) {
      }
    }
    function startMacService(plistPath) {
      const domain = getMacDomainTarget();
      try {
        execSync(`launchctl bootstrap "${domain}" "${plistPath}"`, { stdio: "pipe" });
        try {
          execSync(`launchctl kickstart -k "${domain}/${MAC_LABEL}"`, { stdio: "ignore" });
        } catch (_) {
        }
        return;
      } catch (_) {
        execSync(`launchctl load -w "${plistPath}"`, { stdio: "pipe" });
      }
    }
    function printCommonCommands(platform) {
      const scriptCmd = `node ${getScriptDisplayPath()}`;
      const logPath = getLogDisplayPath();
      console.log("");
      console.log("\u{1F4CB} \u5E38\u7528\u7BA1\u7406\u547D\u4EE4 (\u53EF\u76F4\u63A5\u590D\u5236\u6267\u884C):");
      console.log(`   \u67E5\u770B\u72B6\u6001:  ${scriptCmd} service status`);
      console.log(`   \u67E5\u770B\u65E5\u5FD7:  tail -f ${logPath}`);
      console.log(`   \u91CD\u542F\u670D\u52A1:  ${scriptCmd} service restart`);
      console.log(`   \u505C\u6B62\u670D\u52A1:  ${scriptCmd} service stop`);
      console.log(`   \u542F\u52A8\u670D\u52A1:  ${scriptCmd} service start`);
      console.log(`   \u5378\u8F7D\u670D\u52A1:  ${scriptCmd} service uninstall`);
      if (platform === "linux") {
        console.log("");
        console.log("\u{1F4A1} Linux \u670D\u52A1\u5668\u63D0\u793A: \u5982\u9700\u9000\u51FA SSH \u540E\u4ECD\u4FDD\u6301\u540E\u53F0\u5E38\u9A7B\uFF0C\u53EF\u6267\u884C:");
        console.log("   loginctl enable-linger $USER");
      }
      console.log("");
    }
    function handleServiceCommand2(action) {
      const platform = os.platform();
      const config = readConfig2();
      const scriptPath = path2.join(CONFIG_DIR2, "ccnow-agent.js");
      const logPath = path2.join(CONFIG_DIR2, "agent.log");
      const errLogPath = path2.join(CONFIG_DIR2, "agent-err.log");
      if (!fs2.existsSync(CONFIG_DIR2)) {
        fs2.mkdirSync(CONFIG_DIR2, { recursive: true });
      }
      if (action === "install") {
        if (!config || !config.deviceId || !config.deviceSecret) {
          console.error("\u274C Error: Device is not paired yet. Please run `connect` first before installing service.");
          return { ok: false, supported: true, platform, error: "not_paired" };
        }
        try {
          const currentScript = process.argv[1];
          if (currentScript && currentScript !== "-" && !currentScript.includes("[eval]") && fs2.existsSync(currentScript)) {
            if (path2.resolve(currentScript) !== path2.resolve(scriptPath)) {
              fs2.copyFileSync(currentScript, scriptPath);
              fs2.chmodSync(scriptPath, 493);
            }
          }
        } catch (_) {
        }
        if (!fs2.existsSync(scriptPath)) {
          console.error(`\u274C Error: Agent script not found at ${scriptPath}.`);
          return { ok: false, supported: true, platform, error: "script_missing" };
        }
        const serviceEnv = buildServiceEnv();
        if (platform === "darwin") {
          const launchDir = path2.join(os.homedir(), "Library", "LaunchAgents");
          if (!fs2.existsSync(launchDir)) fs2.mkdirSync(launchDir, { recursive: true });
          const plistPath = getMacPlistPath();
          const envEntries = Object.entries(serviceEnv).map(([k, v]) => `    <key>${xmlEscape(k)}</key>
    <string>${xmlEscape(v)}</string>`).join("\n");
          const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLogPath)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(os.homedir())}</string>
</dict>
</plist>
`;
          fs2.writeFileSync(plistPath, plistContent, "utf8");
          try {
            stopMacService(plistPath);
            startMacService(plistPath);
            console.log(`\u2705 \u5DF2\u5B89\u88C5\u5E76\u542F\u52A8\u540E\u53F0\u5E38\u9A7B\u670D\u52A1 (macOS launchd\uFF0C\u5DF2\u8BBE\u4E3A\u767B\u5F55\u81EA\u542F)`);
            console.log(`   \u914D\u7F6E\u6587\u4EF6: ${plistPath}`);
            console.log(`   \u8BBE\u5907\u540D\u79F0: ${config.name || os.hostname()} (${config.deviceId})`);
            printCommonCommands(platform);
            return { ok: true, supported: true, platform, servicePath: plistPath };
          } catch (err) {
            console.error("\u26A0\uFE0F Failed to load launchd service:", err.message);
            return { ok: false, supported: true, platform, error: err.message };
          }
        }
        if (platform === "linux") {
          const unitDir = path2.join(os.homedir(), ".config", "systemd", "user");
          if (!fs2.existsSync(unitDir)) fs2.mkdirSync(unitDir, { recursive: true });
          const servicePath = getLinuxServicePath();
          const envLines = Object.entries(serviceEnv).map(([k, v]) => `Environment="${k}=${systemdEscape(v)}"`).join("\n");
          const serviceContent = `[Unit]
Description=ccnow Edge Agent Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${os.homedir()}
${envLines}
ExecStart=${process.execPath} ${scriptPath} start
KillMode=process
Restart=always
RestartSec=3
StandardOutput=append:${logPath}
StandardError=append:${errLogPath}

[Install]
WantedBy=default.target
`;
          fs2.writeFileSync(servicePath, serviceContent, "utf8");
          try {
            execSync("systemctl --user daemon-reload", { stdio: "pipe" });
            execSync(`systemctl --user enable --now ${LINUX_UNIT}`, { stdio: "pipe" });
            execSync(`systemctl --user restart ${LINUX_UNIT}`, { stdio: "pipe" });
            console.log(`\u2705 \u5DF2\u5B89\u88C5\u5E76\u542F\u52A8\u540E\u53F0\u5E38\u9A7B\u670D\u52A1 (Linux systemd --user\uFF0C\u5DF2\u8BBE\u4E3A\u5F00\u673A\u81EA\u542F)`);
            console.log(`   \u670D\u52A1\u6587\u4EF6: ${servicePath}`);
            console.log(`   \u8BBE\u5907\u540D\u79F0: ${config.name || os.hostname()} (${config.deviceId})`);
            printCommonCommands(platform);
            return { ok: true, supported: true, platform, servicePath };
          } catch (err) {
            console.error("\u26A0\uFE0F Failed to enable systemd user service:", err.message);
            return { ok: false, supported: true, platform, error: err.message };
          }
        }
        console.log(`\u2139\uFE0F \u5F53\u524D\u7CFB\u7EDF (${platform}) \u6682\u4E0D\u652F\u6301\u81EA\u52A8\u6CE8\u518C\u540E\u53F0\u5E38\u9A7B\u670D\u52A1\uFF08\u76EE\u524D\u652F\u6301 macOS \u4E0E Linux\uFF09\u3002`);
        return { ok: false, supported: false, platform, error: "unsupported_platform" };
      }
      if (action === "start") {
        if (platform === "darwin") {
          const plistPath = getMacPlistPath();
          if (!fs2.existsSync(plistPath)) {
            console.error(`\u26A0\uFE0F \u5C1A\u672A\u5B89\u88C5\u540E\u53F0\u670D\u52A1\uFF0C\u8BF7\u5148\u6267\u884C: node ${getScriptDisplayPath()} service install`);
            return { ok: false, supported: true, platform };
          }
          try {
            stopMacService(plistPath);
            startMacService(plistPath);
            console.log("\u{1F680} ccnow-agent \u540E\u53F0\u670D\u52A1\u5DF2\u542F\u52A8 (macOS launchd)");
            return { ok: true, supported: true, platform };
          } catch (err) {
            console.error("\u274C \u542F\u52A8\u5931\u8D25:", err.message);
            return { ok: false, supported: true, platform, error: err.message };
          }
        }
        if (platform === "linux") {
          try {
            execSync(`systemctl --user start ${LINUX_UNIT}`, { stdio: "pipe" });
            console.log("\u{1F680} ccnow-agent \u540E\u53F0\u670D\u52A1\u5DF2\u542F\u52A8 (systemd --user)");
            return { ok: true, supported: true, platform };
          } catch (err) {
            console.error("\u274C \u542F\u52A8\u5931\u8D25:", err.message);
            return { ok: false, supported: true, platform, error: err.message };
          }
        }
        console.log(`\u2139\uFE0F \u5F53\u524D\u7CFB\u7EDF (${platform}) \u6682\u4E0D\u652F\u6301 service start\u3002`);
        return { ok: false, supported: false, platform };
      }
      if (action === "stop") {
        if (platform === "darwin") {
          const plistPath = getMacPlistPath();
          stopMacService(plistPath);
          console.log("\u{1F6D1} ccnow-agent \u540E\u53F0\u670D\u52A1\u5DF2\u505C\u6B62 (\u5982\u9700\u6062\u590D\u53EF\u6267\u884C service start)");
          return { ok: true, supported: true, platform };
        }
        if (platform === "linux") {
          try {
            execSync(`systemctl --user stop ${LINUX_UNIT}`, { stdio: "pipe" });
            console.log("\u{1F6D1} ccnow-agent \u540E\u53F0\u670D\u52A1\u5DF2\u505C\u6B62 (\u5982\u9700\u6062\u590D\u53EF\u6267\u884C service start)");
            return { ok: true, supported: true, platform };
          } catch (err) {
            console.error("\u274C \u505C\u6B62\u5931\u8D25:", err.message);
            return { ok: false, supported: true, platform, error: err.message };
          }
        }
        console.log(`\u2139\uFE0F \u5F53\u524D\u7CFB\u7EDF (${platform}) \u6682\u4E0D\u652F\u6301 service stop\u3002`);
        return { ok: false, supported: false, platform };
      }
      if (action === "restart") {
        if (platform === "darwin") {
          const plistPath = getMacPlistPath();
          if (!fs2.existsSync(plistPath)) {
            console.error(`\u26A0\uFE0F \u5C1A\u672A\u5B89\u88C5\u540E\u53F0\u670D\u52A1\uFF0C\u8BF7\u5148\u6267\u884C: node ${getScriptDisplayPath()} service install`);
            return { ok: false, supported: true, platform };
          }
          try {
            const domain = getMacDomainTarget();
            try {
              execSync(`launchctl kickstart -k "${domain}/${MAC_LABEL}"`, { stdio: "pipe" });
            } catch (_) {
              stopMacService(plistPath);
              startMacService(plistPath);
            }
            console.log("\u{1F504} ccnow-agent \u540E\u53F0\u670D\u52A1\u5DF2\u91CD\u542F (macOS launchd)");
            return { ok: true, supported: true, platform };
          } catch (e) {
            console.error("\u274C \u91CD\u542F\u5931\u8D25:", e.message);
            return { ok: false, supported: true, platform, error: e.message };
          }
        }
        if (platform === "linux") {
          try {
            execSync(`systemctl --user restart ${LINUX_UNIT}`, { stdio: "pipe" });
            console.log("\u{1F504} ccnow-agent \u540E\u53F0\u670D\u52A1\u5DF2\u91CD\u542F (systemd --user)");
            return { ok: true, supported: true, platform };
          } catch (e) {
            console.error("\u274C \u91CD\u542F\u5931\u8D25:", e.message);
            return { ok: false, supported: true, platform, error: e.message };
          }
        }
        console.log(`\u2139\uFE0F \u5F53\u524D\u7CFB\u7EDF (${platform}) \u6682\u4E0D\u652F\u6301 service restart\u3002`);
        return { ok: false, supported: false, platform };
      }
      if (action === "status") {
        if (platform === "darwin") {
          const plistPath = getMacPlistPath();
          const installed = fs2.existsSync(plistPath);
          try {
            const out = execSync(`launchctl list | grep ${MAC_LABEL} || true`, { encoding: "utf8" }).trim();
            if (out) {
              const parts = out.split(/\s+/);
              const pid = parts[0] && parts[0] !== "-" ? parts[0] : null;
              if (pid) {
                console.log(`\u{1F7E2} ccnow-agent \u540E\u53F0\u670D\u52A1\u8FD0\u884C\u4E2D (PID: ${pid})`);
              } else {
                console.log(`\u{1F7E1} ccnow-agent \u5DF2\u6CE8\u518C\u5728 launchd\uFF0C\u4F46\u5F53\u524D\u672A\u8FD0\u884C (${out})`);
              }
              if (config) {
                console.log(`   \u8BBE\u5907\u540D\u79F0: ${config.name || os.hostname()} (${config.deviceId})`);
                console.log(`   \u63A7\u5236\u9762:   ${config.server}`);
              }
              console.log(`   \u65E5\u5FD7\u6587\u4EF6: ${getLogDisplayPath()}`);
            } else {
              console.log(installed ? `\u26AA ccnow-agent \u540E\u53F0\u670D\u52A1\u5DF2\u5B89\u88C5\u4F46\u5F53\u524D\u5DF2\u505C\u6B62 (\u8FD0\u884C \`node ${getScriptDisplayPath()} service start\` \u542F\u52A8)` : `\u26AA ccnow-agent \u540E\u53F0\u670D\u52A1\u5C1A\u672A\u5B89\u88C5 (\u8FD0\u884C \`node ${getScriptDisplayPath()} service install\` \u5B89\u88C5)`);
            }
            return { ok: true, supported: true, platform };
          } catch (e) {
            console.log("\u26A0\uFE0F \u65E0\u6CD5\u67E5\u8BE2 launchctl \u72B6\u6001:", e.message);
            return { ok: false, supported: true, platform, error: e.message };
          }
        }
        if (platform === "linux") {
          try {
            execSync(`systemctl --user status ${LINUX_UNIT} --no-pager`, { stdio: "inherit" });
          } catch (_) {
          }
          return { ok: true, supported: true, platform };
        }
        console.log(`\u2139\uFE0F \u5F53\u524D\u7CFB\u7EDF (${platform}) \u6682\u4E0D\u652F\u6301 service status\u3002`);
        return { ok: false, supported: false, platform };
      }
      if (action === "logs") {
        if (!fs2.existsSync(logPath)) {
          console.log(`\u2139\uFE0F \u65E5\u5FD7\u6587\u4EF6\u5C1A\u4E0D\u5B58\u5728: ${logPath}`);
          return { ok: false, supported: true, platform };
        }
        console.log(`\u{1F4DC} \u5B9E\u65F6\u8FFD\u8E2A\u65E5\u5FD7 (${getLogDisplayPath()})\uFF0C\u6309 Ctrl+C \u9000\u51FA\u67E5\u770B...`);
        const child = spawn("tail", ["-n", "50", "-f", logPath], { stdio: "inherit" });
        child.on("error", () => {
          console.log(fs2.readFileSync(logPath, "utf8").split("\n").slice(-50).join("\n"));
        });
        return { ok: true, supported: true, platform, streaming: true };
      }
      if (action === "uninstall") {
        if (platform === "darwin") {
          const plistPath = getMacPlistPath();
          stopMacService(plistPath);
          if (fs2.existsSync(plistPath)) fs2.unlinkSync(plistPath);
          console.log("\u2705 \u5DF2\u505C\u6B62\u5E76\u5378\u8F7D macOS LaunchAgent \u540E\u53F0\u670D\u52A1\u3002");
          console.log(`   (\u672C\u5730\u914D\u5BF9\u51ED\u8BC1\u4FDD\u7559\u5728 ${path2.join(CONFIG_DIR2, "device.json")}\uFF0C\u5982\u9700\u91CD\u65B0\u542F\u7528\u540E\u53F0\u670D\u52A1\u53EF\u6267\u884C: node ${getScriptDisplayPath()} service install)`);
          return { ok: true, supported: true, platform };
        }
        if (platform === "linux") {
          const servicePath = getLinuxServicePath();
          try {
            execSync(`systemctl --user stop ${LINUX_UNIT} 2>/dev/null || true`, { stdio: "ignore" });
            execSync(`systemctl --user disable ${LINUX_UNIT} 2>/dev/null || true`, { stdio: "ignore" });
          } catch (_) {
          }
          if (fs2.existsSync(servicePath)) fs2.unlinkSync(servicePath);
          try {
            execSync("systemctl --user daemon-reload", { stdio: "ignore" });
          } catch (_) {
          }
          console.log("\u2705 \u5DF2\u505C\u6B62\u5E76\u5378\u8F7D Linux systemd \u7528\u6237\u7EA7\u540E\u53F0\u670D\u52A1\u3002");
          console.log(`   (\u672C\u5730\u914D\u5BF9\u51ED\u8BC1\u4FDD\u7559\u5728 ${path2.join(CONFIG_DIR2, "device.json")}\uFF0C\u5982\u9700\u91CD\u65B0\u542F\u7528\u540E\u53F0\u670D\u52A1\u53EF\u6267\u884C: node ${getScriptDisplayPath()} service install)`);
          return { ok: true, supported: true, platform };
        }
        console.log(`\u2139\uFE0F \u5F53\u524D\u7CFB\u7EDF (${platform}) \u6682\u4E0D\u652F\u6301 service uninstall\u3002`);
        return { ok: false, supported: false, platform };
      }
      console.log(`Unknown service action: ${action}. Available: install, start, stop, restart, status, logs, uninstall`);
      return { ok: false, supported: true, platform, error: "unknown_action" };
    }
    module2.exports = { handleServiceCommand: handleServiceCommand2, printCommonCommands };
  }
});

// client/src/client.js
var require_client = __commonJS({
  "client/src/client.js"(exports2, module2) {
    var os = require("os");
    var { CLIENT_VERSION: CLIENT_VERSION2, saveConfig, getLocalDeviceInfo, toWsUrl } = require_config();
    var fsHandlers = require_fsHandlers();
    var gitHandlers = require_gitHandlers();
    var tmuxHandlers = require_tmuxHandlers();
    var chatHandlers = require_chatHandlers();
    var { ensureLocalAgentScript, handleSystemUpdate } = require_updater();
    var { handleServiceCommand: handleServiceCommand2 } = require_serviceManager();
    var { tryRequireOptional, installPackageSync, ensureOptionalDepsInBackground } = require_depsManager();
    var WSClient = typeof WebSocket !== "undefined" ? WebSocket : tryRequireOptional("ws");
    if (!WSClient) {
      if (installPackageSync("ws")) {
        WSClient = tryRequireOptional("ws");
      }
    }
    if (!WSClient) {
      console.error("\u274C Error: Global WebSocket not available in this Node.js version.");
      console.error("Please run with Node.js >= 21 or run: npm install -g ws");
      process.exit(1);
    }
    var AgentClient2 = class {
      constructor(serverUrl, credentials = {}) {
        this.serverUrl = serverUrl;
        this.credentials = credentials;
        this.ws = null;
        this.pingTimer = null;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.isStopped = false;
        this.send = this.send.bind(this);
      }
      start() {
        this.isStopped = false;
        this.connect();
      }
      stop() {
        this.isStopped = true;
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.ws) {
          try {
            this.ws.close();
          } catch (e) {
          }
        }
        tmuxHandlers.cleanupAllTerminals();
      }
      connect() {
        if (this.isStopped) return;
        const wsUrl = toWsUrl(this.serverUrl);
        console.log(`\u{1F50C} Connecting to ccnow Control Plane at ${wsUrl}...`);
        try {
          this.ws = new WSClient(wsUrl);
        } catch (err) {
          console.error("\u274C Connection failed:", err.message);
          this.scheduleReconnect();
          return;
        }
        this.ws.onopen = () => {
          console.log(`\u2728 Connected to ${wsUrl}! Sending handshake...`);
          this.reconnectAttempts = 0;
          if (this.credentials.token) {
            console.log(`\u{1F511} Performing initial pairing with token ${this.credentials.token.substring(0, 8)}...`);
            this.send({
              action: "pair",
              token: this.credentials.token,
              version: CLIENT_VERSION2,
              deviceInfo: getLocalDeviceInfo(this.credentials.customName)
            });
          } else if (this.credentials.deviceId && this.credentials.deviceSecret) {
            console.log(`\u{1F6E1}\uFE0F Authenticating device ${this.credentials.deviceId} (v${CLIENT_VERSION2})...`);
            this.send({
              action: "auth",
              deviceId: this.credentials.deviceId,
              deviceSecret: this.credentials.deviceSecret,
              version: CLIENT_VERSION2,
              deviceInfo: getLocalDeviceInfo()
            });
          }
        };
        this.ws.onmessage = (event) => {
          try {
            const raw = typeof event.data === "string" ? event.data : event.data.toString();
            const msg = JSON.parse(raw);
            this.handleMessage(msg);
          } catch (e) {
            console.error("\u26A0\uFE0F Malformed message received:", e.message);
          }
        };
        this.ws.onclose = (event) => {
          console.warn(`\u26A0\uFE0F Connection closed (code: ${event.code || "unknown"}, reason: ${event.reason || "none"})`);
          if (this.pingTimer) clearInterval(this.pingTimer);
          if (!this.isStopped) {
            this.scheduleReconnect();
          }
        };
        this.ws.onerror = (err) => {
          console.error("\u274C WebSocket error:", err.message || err);
        };
      }
      scheduleReconnect() {
        if (this.isReconnecting || this.isStopped) return;
        this.isReconnecting = true;
        this.reconnectAttempts++;
        const delay = Math.min(2e3 * Math.pow(1.5, this.reconnectAttempts - 1), 3e4);
        console.log(`\u{1F504} Reconnecting in ${(delay / 1e3).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);
        setTimeout(() => {
          this.isReconnecting = false;
          this.connect();
        }, delay);
      }
      send(obj) {
        if (this.ws && this.ws.readyState === 1) {
          this.ws.send(JSON.stringify(obj));
        }
      }
      startHeartbeat() {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.lastPong = Date.now();
        this.pingTimer = setInterval(() => {
          if (Date.now() - this.lastPong > 45e3) {
            console.warn("\u26A0\uFE0F Heartbeat pong timed out. Forcing reconnect...");
            try {
              this.ws.close();
            } catch (e) {
            }
            this.scheduleReconnect();
            return;
          }
          this.send({ action: "ping" });
        }, 2e4);
      }
      async handoffToBackgroundDaemon() {
        const platform = os.platform();
        const savedPath = await ensureLocalAgentScript(this.serverUrl, { forceDownload: true });
        if (platform !== "darwin" && platform !== "linux") {
          console.log(`\u2139\uFE0F \u5F53\u524D\u7CFB\u7EDF (${platform}) \u6682\u4E0D\u652F\u6301\u81EA\u52A8\u5B89\u88C5\u540E\u53F0\u670D\u52A1\uFF0C\u5DF2\u81EA\u52A8\u5207\u6362\u4E3A\u524D\u53F0\u8FD0\u884C\u6A21\u5F0F\uFF08\u6309 Ctrl+C \u9000\u51FA\uFF09\u3002`);
          this.startHeartbeat();
          ensureOptionalDepsInBackground();
          return;
        }
        if (!savedPath) {
          console.warn("\u26A0\uFE0F \u65E0\u6CD5\u4E0B\u8F7D\u672C\u5730\u811A\u672C\u5230 ~/.ccnow/ccnow-agent.js\uFF0C\u5DF2\u56DE\u9000\u4E3A\u524D\u53F0\u8FD0\u884C\u6A21\u5F0F\u3002");
          this.startHeartbeat();
          ensureOptionalDepsInBackground();
          return;
        }
        console.log("\u2699\uFE0F \u6B63\u5728\u6CE8\u518C\u7CFB\u7EDF\u540E\u53F0\u5E38\u9A7B\u670D\u52A1...");
        this.stop();
        const result = handleServiceCommand2("install");
        if (result && result.ok) {
          console.log("\u2728 \u914D\u7F6E\u5B8C\u6210\uFF01\u540E\u53F0\u670D\u52A1\u5DF2\u5728\u8FD0\u884C\uFF0C\u4F60\u53EF\u4EE5\u653E\u5FC3\u5173\u95ED\u5F53\u524D\u7EC8\u7AEF\u7A97\u53E3\u3002");
          process.exit(0);
          return;
        }
        console.warn("\u26A0\uFE0F \u540E\u53F0\u670D\u52A1\u6CE8\u518C\u5931\u8D25\uFF0C\u5DF2\u81EA\u52A8\u56DE\u9000\u4E3A\u524D\u53F0\u4FDD\u6301\u8FDE\u63A5\uFF08\u6309 Ctrl+C \u9000\u51FA\uFF09\u3002");
        this.credentials = {
          deviceId: this.credentials.deviceId,
          deviceSecret: this.credentials.deviceSecret,
          daemon: false
        };
        this.start();
      }
      handleMessage(msg) {
        const { action } = msg;
        switch (action) {
          case "pair_success":
            console.log("\u{1F389} ==========================================");
            console.log("\u2705 Device successfully paired with ccnow!");
            console.log(`\u{1F4F1} Device ID:   ${msg.deviceId}`);
            console.log(`\u{1F4BB} Device Name: ${msg.device?.name || "Local Device"}`);
            console.log("==========================================");
            saveConfig({
              server: this.serverUrl,
              deviceId: msg.deviceId,
              deviceSecret: msg.deviceSecret,
              name: msg.device?.name || "Local Device"
            });
            this.credentials = {
              deviceId: msg.deviceId,
              deviceSecret: msg.deviceSecret,
              daemon: this.credentials.daemon
            };
            if (this.credentials.daemon) {
              this.handoffToBackgroundDaemon();
              return;
            }
            ensureLocalAgentScript(this.serverUrl).then(() => {
              const p = os.platform();
              if (p === "darwin" || p === "linux") {
                console.log("\u{1F4A1} \u63D0\u793A: \u5F53\u524D\u4E3A\u524D\u53F0\u8FD0\u884C\u6A21\u5F0F\uFF08\u5173\u95ED\u7EC8\u7AEF\u5C06\u65AD\u5F00\uFF09\uFF1B\u5982\u9700\u8F6C\u4E3A\u540E\u53F0\u5E38\u9A7B\uFF0C\u6309 Ctrl+C \u540E\u6267\u884C:");
                console.log("   node ~/.ccnow/ccnow-agent.js service install");
              }
            });
            this.startHeartbeat();
            ensureOptionalDepsInBackground();
            return;
          case "pair_failed":
            console.error(`\u274C Pairing failed: ${msg.error}`);
            this.stop();
            process.exit(1);
            return;
          case "auth_success":
            console.log(`\u2705 Authenticated successfully as ${msg.deviceId}! Online and ready.`);
            this.startHeartbeat();
            ensureOptionalDepsInBackground();
            return;
          case "auth_failed":
            console.error(`\u274C Authentication failed: ${msg.error}`);
            this.stop();
            process.exit(1);
            return;
          case "pong":
            this.lastPong = Date.now();
            return;
          case "system:update":
            handleSystemUpdate(this.send, this.serverUrl, msg.reqId, msg);
            return;
          // Tmux & Terminal
          case "tmux:list_sessions":
            tmuxHandlers.handleListSessions(this.send, msg.reqId, chatHandlers.getDeviceOarManager, msg);
            return;
          case "tmux:new_session":
            tmuxHandlers.handleNewSession(this.send, msg.reqId, msg, chatHandlers.getDeviceOarManager);
            return;
          case "tmux:kill_session":
            tmuxHandlers.handleKillSession(this.send, msg.reqId, msg.sessionName, chatHandlers.getDeviceOarManager);
            return;
          case "tmux:send_keys":
            tmuxHandlers.handleSendKeys(this.send, msg.reqId, msg);
            return;
          case "term:open":
            tmuxHandlers.handleOpenTerminal(this.send, msg);
            return;
          case "term:input":
            tmuxHandlers.handleTerminalInput(msg);
            return;
          case "term:resize":
            tmuxHandlers.handleTerminalResize(msg);
            return;
          case "term:close":
            tmuxHandlers.handleTerminalClose(msg);
            return;
          // Filesystem & Workspaces
          case "fs:workspaces":
            fsHandlers.handleFsWorkspaces(this.send, msg.reqId);
            return;
          case "fs:add_workspace":
            fsHandlers.handleFsAddWorkspace(this.send, msg.reqId, msg);
            return;
          case "fs:remove_workspace":
            fsHandlers.handleFsRemoveWorkspace(this.send, msg.reqId, msg);
            return;
          case "fs:list":
            fsHandlers.handleFsList(this.send, msg.reqId, msg.workspacePath, msg.relativePath);
            return;
          case "fs:read":
            fsHandlers.handleFsRead(this.send, msg.reqId, msg.workspacePath, msg.filePath);
            return;
          case "fs:write":
            fsHandlers.handleFsWrite(this.send, msg.reqId, msg.workspacePath, msg.filePath, msg.content);
            return;
          case "fs:directories":
            fsHandlers.handleDirectories(this.send, msg.reqId, msg.targetPath);
            return;
          case "fs:upload_file":
            fsHandlers.handleUploadFile(this.send, msg.reqId, msg);
            return;
          case "fs:create_file":
            fsHandlers.handleFsCreateFile(this.send, msg.reqId, msg.workspacePath, msg.filePath);
            return;
          case "fs:create_dir":
            fsHandlers.handleFsCreateDir(this.send, msg.reqId, msg.workspacePath, msg.dirPath);
            return;
          case "fs:delete":
            fsHandlers.handleFsDelete(this.send, msg.reqId, msg.workspacePath, msg.targetPath);
            return;
          case "fs:rename":
            fsHandlers.handleFsRename(this.send, msg.reqId, msg.workspacePath, msg.oldPath, msg.newPath);
            return;
          // Git
          case "git:status":
            gitHandlers.handleGitStatus(this.send, msg.reqId, msg.workspacePath);
            return;
          case "git:diff":
            gitHandlers.handleGitDiff(this.send, msg.reqId, msg.workspacePath, msg.filePath);
            return;
          case "git:stage":
            gitHandlers.handleGitStage(this.send, msg.reqId, msg.workspacePath, msg.files);
            return;
          case "git:unstage":
            gitHandlers.handleGitUnstage(this.send, msg.reqId, msg.workspacePath, msg.files);
            return;
          case "git:commit":
            gitHandlers.handleGitCommit(this.send, msg.reqId, msg.workspacePath, msg.message);
            return;
          case "git:branches":
            gitHandlers.handleGitBranches(this.send, msg.reqId, msg.workspacePath);
            return;
          case "git:checkout":
            gitHandlers.handleGitCheckout(this.send, msg.reqId, msg.workspacePath, msg.branch);
            return;
          // Agent Chat & OAR
          case "agent:chat_history":
            chatHandlers.handleChatHistory(this.send, msg.reqId, msg.sessionName, msg.since);
            return;
          case "agent:clear_context":
            chatHandlers.handleClearContext(this.send, msg.reqId, msg.sessionName);
            return;
          case "agent:chat_upload":
            chatHandlers.handleChatUpload(this.send, msg.reqId, msg);
            return;
          case "agent:chat_attachment":
            chatHandlers.handleChatAttachment(this.send, msg.reqId, msg);
            return;
          case "agent:chat":
            chatHandlers.executeAgentTask(this.send, msg);
            return;
          case "agent:interrupt":
            chatHandlers.interruptAgentTask(msg.sessionId);
            return;
          case "oar:runtimes":
            chatHandlers.handleOarRuntimes(this.send, msg.reqId);
            return;
          case "oar:message":
            chatHandlers.handleOarMessage(this.send, msg.reqId, msg);
            return;
          case "oar:compact":
            chatHandlers.handleOarCompact(this.send, msg.reqId, msg.sessionName);
            return;
          case "oar:abort":
            chatHandlers.handleOarAbort(this.send, msg.reqId, msg.sessionName);
            return;
          default:
            console.log(`[ccnow-agent] Received action: ${action}`);
        }
      }
    };
    module2.exports = { AgentClient: AgentClient2 };
  }
});

// client/src/index.js
var fs = require("fs");
var path = require("path");
var {
  CLIENT_VERSION,
  CONFIG_DIR,
  CONFIG_FILE,
  WORKSPACES_FILE,
  readConfig,
  parseArgs,
  applyManagedGatewayEnv
} = require_config();
var { AgentClient } = require_client();
var { downloadAndApplyUpdate } = require_updater();
var { handleServiceCommand } = require_serviceManager();
var { runSetupCommand } = require_depsManager();
function printHelp() {
  console.log(`
ccnow-agent (v${CLIENT_VERSION}) - Ultra-lightweight edge daemon for ccnow (tmux-agent-deck)

Usage:
  curl -fsSL https://<server>/agent.js | node - connect --server <url> --token <token> [--daemon] [--name <name>]
      Pair and connect this device to the ccnow Web Control Plane
      Add --daemon to automatically install and start as a background service (macOS / Linux)

  node ~/.ccnow/ccnow-agent.js start [--server <url>]
      Start daemon in foreground using saved credentials from ~/.ccnow/device.json

  node ~/.ccnow/ccnow-agent.js update [--server <url>]
      Download latest ccnow-agent from server and apply self-update

  node ~/.ccnow/ccnow-agent.js service <install|start|stop|restart|status|logs|uninstall>
      Manage background daemon service via macOS LaunchAgent or Linux systemd user unit

  node ~/.ccnow/ccnow-agent.js status
      Show currently paired device details

  node ~/.ccnow/ccnow-agent.js version
      Show client daemon version

  node ~/.ccnow/ccnow-agent.js unpair
      Remove local pairing configuration
`);
}
var parsed = parseArgs(process.argv.slice(2));
switch (parsed.command) {
  case "version":
  case "-v":
  case "--version": {
    console.log(`ccnow-agent v${CLIENT_VERSION}`);
    break;
  }
  case "update": {
    const config = readConfig();
    const server = parsed.options.server || config?.server;
    if (!server) {
      console.error("\u274C Error: No server URL specified. Provide --server <url> or pair first.");
      process.exit(1);
    }
    console.log(`\u2B07\uFE0F Checking for updates and downloading from ${server}...`);
    downloadAndApplyUpdate(server).then((res) => {
      console.log("\u{1F389} Update applied successfully!");
      console.log(`\u{1F4C1} Target:  ${res.path}`);
      console.log(`\u{1F3F7}\uFE0F Version: ${CLIENT_VERSION} \u2794 ${res.version}`);
      process.exit(0);
    }).catch((err) => {
      console.error(`\u274C Update failed: ${err.message}`);
      process.exit(1);
    });
    break;
  }
  case "service": {
    const subcommand = parsed.options._subcommand || process.argv[3] || "status";
    const result = handleServiceCommand(subcommand, parsed.options);
    if (result && !result.ok && !result.streaming) {
      process.exit(1);
    }
    break;
  }
  case "setup": {
    runSetupCommand().then(() => process.exit(0)).catch((err) => {
      console.error("\u274C Setup failed:", err.message);
      process.exit(1);
    });
    break;
  }
  case "connect": {
    const { server, token, name, daemon, background } = parsed.options;
    if (!server || !token) {
      console.error("\u274C Error: Both --server and --token are required for connect.");
      printHelp();
      process.exit(1);
    }
    const daemonMode = Boolean(daemon || background);
    console.log(daemonMode ? "\u{1F680} Starting ccnow-agent pairing (background daemon mode)..." : "\u{1F680} Starting ccnow-agent pairing...");
    const client = new AgentClient(server, { token, customName: name, daemon: daemonMode });
    client.start();
    process.on("SIGINT", () => {
      console.log("\n\u{1F44B} Disconnecting ccnow-agent...");
      client.stop();
      process.exit(0);
    });
    break;
  }
  case "start": {
    const config = readConfig() || {};
    const server = parsed.options.server || process.env.CCNOW_SERVER_URL || config.server;
    const deviceId = process.env.CCNOW_DEVICE_ID || config.deviceId;
    const deviceSecret = process.env.CCNOW_DEVICE_SECRET || config.deviceSecret;
    const deviceName = process.env.CCNOW_DEVICE_NAME || config.name || deviceId;
    if (!deviceId || !deviceSecret || !server) {
      console.error("\u274C Error: No valid device credentials found in ~/.ccnow/device.json or CCNOW_* env vars");
      console.error("Please run `npx ccnow-agent connect --server <url> --token <token>` first.");
      process.exit(1);
    }
    if (process.env.CCNOW_DEFAULT_WORKSPACE && !fs.existsSync(WORKSPACES_FILE)) {
      try {
        if (!fs.existsSync(CONFIG_DIR)) {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        const defaultWsName = process.env.CCNOW_DEFAULT_WORKSPACE_NAME || path.basename(process.env.CCNOW_DEFAULT_WORKSPACE) || "workspace";
        const seed = [{ name: defaultWsName, path: process.env.CCNOW_DEFAULT_WORKSPACE }];
        fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(seed, null, 2), "utf8");
      } catch (err) {
        console.warn("\u26A0\uFE0F Failed to seed default workspace:", err.message);
      }
    }
    applyManagedGatewayEnv({ server, deviceId, deviceSecret });
    console.log(`\u{1F680} Starting ccnow-agent (Device: ${deviceName})...`);
    const client = new AgentClient(server, {
      deviceId,
      deviceSecret,
      customName: deviceName
    });
    client.start();
    const shutdown = (sig) => {
      console.log(`
\u{1F44B} Disconnecting ccnow-agent (${sig})...`);
      client.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    break;
  }
  case "status": {
    const config = readConfig();
    if (!config) {
      console.log("\u2139\uFE0F No device configuration found. Device is not paired yet.");
    } else {
      console.log("\u{1F4F1} Paired Device Info:");
      console.log(`  Name:      ${config.name || "N/A"}`);
      console.log(`  Device ID: ${config.deviceId}`);
      console.log(`  Server:    ${config.server}`);
      console.log(`  Config:    ${CONFIG_FILE}`);
    }
    break;
  }
  case "unpair": {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
      console.log("\u2705 Local device configuration removed.");
    } else {
      console.log("\u2139\uFE0F No configuration file found.");
    }
    break;
  }
  case "help":
  default:
    printHelp();
    break;
}
