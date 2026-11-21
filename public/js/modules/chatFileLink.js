/**
 * Chat Mode File Path Link Enhancer & Preview Opener
 * - Detects highlighted file paths in AI responses (inline <code>, file:// links, relative links)
 * - Detects file paths in tool execution items and user file attachments
 * - Clicking any highlighted file path opens it directly in the workspace Editor/Preview tab
 * - Supports optional line / line-range jump (e.g. file.js:42, file.js#L10-L20)
 */

import { state } from './state.js';
import { openFile } from './explorer.js';

// Common file extensions allowed for bare (no-slash) filename detection
const KNOWN_FILE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'd.ts',
  'html', 'htm', 'css', 'scss', 'less', 'sass', 'vue', 'svelte',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'swift', 'scala',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'prisma',
  'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf',
  'dockerfile', 'lock', 'gitignore', 'dockerignore', 'editorconfig', 'npmrc', 'nvmrc'
]);

// Bare filenames without extensions that are unmistakably project files
const KNOWN_BARE_FILENAMES = new Set([
  'Dockerfile', 'Makefile', 'Procfile', 'Vagrantfile', 'Gemfile', 'Rakefile',
  'LICENSE', 'CHANGELOG', 'README', '.gitignore', '.dockerignore', '.env', '.env.example'
]);

// Common JS/code object prefixes that should NOT be mistaken for bare filenames (e.g. res.json, e.sh)
const CODE_OBJECT_PREFIXES = new Set([
  'res', 'req', 'ctx', 'app', 'err', 'e', 'el', 'ev', 'fn', 'cb', 'obj', 'arr', 'str', 'num',
  'data', 'body', 'msg', 'item', 'node', 'elem', 'win', 'doc', 'dom', 'api', 'url', 'uri',
  'window', 'document', 'console', 'process', 'module', 'exports', 'global', 'globalThis',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Date', 'Error',
  'state', 'props', 'this', 'self', 'super', 'localStorage', 'sessionStorage', 'navigator', 'location'
]);

/**
 * Normalize workspace path (strip trailing slash)
 */
function normalizeWorkspaceRoot(workspacePath) {
  if (!workspacePath) return '';
  return String(workspacePath).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Parse a raw string (from inline <code>, <a href>, or tool args) into a workspace-relative file target.
 * Returns { path, line, endLine } or null if it is not a valid workspace file path.
 */
export function parseFilePathCandidate(rawText, workspacePath = state.currentWorkspacePath) {
  if (!rawText || typeof rawText !== 'string') return null;

  let text = rawText.trim();
  if (!text || text.length < 3 || text.length > 320) return null;

  // Reject multiline or obvious command/expression snippets
  if (/[\r\n\t|;&$`<>(){}[\]*?!"']/.test(text)) return null;

  // Reject web URLs, anchors, mailto, data URIs
  if (/^(https?:|wss?:|mailto:|tel:|data:|javascript:|#)/i.test(text)) return null;

  let isFileUri = false;
  if (/^file:\/\//i.test(text)) {
    isFileUri = true;
    try {
      text = decodeURIComponent(text.replace(/^file:\/\//i, ''));
    } catch {
      text = text.replace(/^file:\/\//i, '');
    }
    // Strip Windows leading slash before drive letter if any (e.g. /C:/...)
    text = text.replace(/^\/([a-zA-Z]:\/)/, '$1');
  }

  // Extract optional line / line-range suffix:
  // Supports: #L10-L20, #L10, :10-20, :10:5, :10
  let line = null;
  let endLine = null;

  const hashLineMatch = text.match(/#L(\d+)(?:-L?(\d+))?$/i);
  if (hashLineMatch) {
    line = parseInt(hashLineMatch[1], 10);
    endLine = hashLineMatch[2] ? parseInt(hashLineMatch[2], 10) : null;
    text = text.slice(0, hashLineMatch.index);
  } else {
    const colonLineMatch = text.match(/:(\d+)(?:(?::\d+)|(?:-(\d+)))?$/);
    if (colonLineMatch) {
      line = parseInt(colonLineMatch[1], 10);
      endLine = colonLineMatch[2] ? parseInt(colonLineMatch[2], 10) : null;
      text = text.slice(0, colonLineMatch.index);
    }
  }

  // Strip query string if any
  const qIdx = text.indexOf('?');
  if (qIdx !== -1) {
    text = text.slice(0, qIdx);
  }

  text = text.replace(/\\/g, '/').trim();
  if (!text) return null;

  // Reject paths with spaces unless it came from an explicit file:// URI
  if (!isFileUri && /\s/.test(text)) return null;

  // Reject directory traversal
  if (text.split('/').includes('..')) return null;

  const wsRoot = normalizeWorkspaceRoot(workspacePath);
  let relPath = text;

  if (text.startsWith('/')) {
    // Absolute path: only allow if it sits inside the current workspace
    if (wsRoot && text.startsWith(wsRoot + '/')) {
      relPath = text.slice(wsRoot.length + 1);
    } else {
      return null;
    }
  } else {
    // Strip leading ./
    relPath = text.replace(/^\.\//, '');
  }

  // Remove trailing slash (directories are not previewable as files)
  if (!relPath || relPath.endsWith('/')) return null;

  const segments = relPath.split('/');
  const basename = segments[segments.length - 1];
  if (!basename || basename === '.' || basename === '..') return null;

  const hasSlash = segments.length > 1;
  const dotIdx = basename.lastIndexOf('.');
  const hasExt = dotIdx > 0 && dotIdx < basename.length - 1;
  const ext = hasExt ? basename.slice(dotIdx + 1).toLowerCase() : '';
  const stem = hasExt ? basename.slice(0, dotIdx) : basename;

  if (hasSlash) {
    // Must have either a valid extension or a known bare filename (e.g. docker/Dockerfile)
    const isKnownBare = KNOWN_BARE_FILENAMES.has(basename) || basename.startsWith('Dockerfile.');
    if (!hasExt && !isKnownBare) return null;
    if (hasExt && !/^[a-z0-9]{1,12}$/i.test(ext)) return null;
    // Reject obvious version strings or dates like 2026/11/21
    if (/^\d+$/.test(ext)) return null;
  } else {
    // Bare filename without slash: be strict to avoid false positives on code tokens
    if (KNOWN_BARE_FILENAMES.has(basename)) {
      return { path: relPath, line, endLine };
    }
    if (!hasExt || !KNOWN_FILE_EXTS.has(ext)) return null;
    if (CODE_OBJECT_PREFIXES.has(stem)) return null;
    // Reject single-char stem with generic ext like a.js unless explicit line number or file://
    if (stem.length <= 1 && !line && !isFileUri) return null;
  }

  return { path: relPath, line, endLine };
}

/**
 * Format tooltip label for a parsed file target
 */
function buildPreviewTitle(parsed) {
  const lineSuffix = parsed.line
    ? (parsed.endLine ? ` (第 ${parsed.line}-${parsed.endLine} 行)` : ` (第 ${parsed.line} 行)`)
    : '';
  return `点击打开预览: ${parsed.path}${lineSuffix}`;
}

/**
 * Apply file-link attributes onto an element
 */
function markAsFileLink(el, parsed) {
  el.classList.add('chat-file-link');
  el.dataset.filePath = parsed.path;
  if (parsed.line) el.dataset.fileLine = String(parsed.line);
  if (parsed.endLine) el.dataset.fileEndLine = String(parsed.endLine);
  el.setAttribute('title', buildPreviewTitle(parsed));
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
}

/**
 * Post-process rendered Markdown HTML in Chat Mode so highlighted file paths
 * (inline <code> and file:// or relative <a> links) become directly clickable to preview.
 */
export function enhanceChatFileLinks(html, workspacePath = state.currentWorkspacePath) {
  if (!html) return html;
  if (!html.includes('<code') && !html.includes('<a ')) return html;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;

  // 1. Enhance <a> links pointing to file:// or workspace-relative file paths
  const anchors = wrapper.querySelectorAll('a[href]');
  anchors.forEach((a) => {
    const href = a.getAttribute('href') || '';
    const parsed = parseFilePathCandidate(href, workspacePath);
    if (parsed) {
      a.setAttribute('href', '#');
      markAsFileLink(a, parsed);
    }
  });

  // 2. Enhance inline <code> elements (skipping fenced <pre><code> and Mermaid source blocks)
  const codes = wrapper.querySelectorAll('code');
  codes.forEach((codeEl) => {
    if (codeEl.closest('pre')) return;
    if (codeEl.closest('.chat-mermaid-wrapper')) return;
    if (codeEl.closest('a.chat-file-link')) return;

    const text = (codeEl.textContent || '').trim();
    const parsed = parseFilePathCandidate(text, workspacePath);
    if (parsed) {
      markAsFileLink(codeEl, parsed);
    }
  });

  return wrapper.innerHTML;
}

/**
 * Handle delegated click / keyboard activation on any highlighted file path in Chat Mode.
 * Returns true if the event was handled.
 */
export function handleChatFileLinkClick(e) {
  const linkEl = e.target.closest('.chat-file-link, .chat-bubble-att-item[data-file-path]');
  if (!linkEl) return false;

  const filePath = linkEl.dataset.filePath;
  if (!filePath) return false;

  e.preventDefault();
  e.stopPropagation();

  const line = linkEl.dataset.fileLine ? parseInt(linkEl.dataset.fileLine, 10) : null;
  const endLine = linkEl.dataset.fileEndLine ? parseInt(linkEl.dataset.fileEndLine, 10) : null;

  openFile(filePath, { line, endLine });
  return true;
}
