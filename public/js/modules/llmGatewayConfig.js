/**
 * LLM Gateway Configuration Panel (Admin Only)
 * Allows direct viewing, editing, formatting, and saving of data/llm_gateway.json.
 */

export function initLlmGatewayAdminPanel() {
  const tabLlmGatewayBtn = document.getElementById('tabLlmGatewayBtn');
  const tabContentLlmGateway = document.getElementById('tabContentLlmGateway');

  const tabInviteCodesBtn = document.getElementById('tabInviteCodesBtn');
  const tabAgentsBtn = document.getElementById('tabAgentsBtn');
  const tabAppIconsBtn = document.getElementById('tabAppIconsBtn');

  const tabContentInviteCodes = document.getElementById('tabContentInviteCodes');
  const tabContentAgents = document.getElementById('tabContentAgents');
  const tabContentAppIcons = document.getElementById('tabContentAppIcons');

  const modalCard = document.querySelector('#adminPanelModal .modal-card');
  const editor = document.getElementById('llmGatewayJsonEditor');
  const formatBtn = document.getElementById('formatLlmGatewayJsonBtn');
  const reloadBtn = document.getElementById('reloadLlmGatewayJsonBtn');
  const saveBtn = document.getElementById('saveLlmGatewayJsonBtn');
  const statusHint = document.getElementById('llmGatewayStatusHint');

  function setStatus(msg, type = 'info') {
    if (!statusHint) return;
    statusHint.textContent = msg;
    if (type === 'error') {
      statusHint.style.color = 'var(--neon-pink, #ff0055)';
    } else if (type === 'success') {
      statusHint.style.color = 'var(--neon-cyan, #00f0ff)';
    } else {
      statusHint.style.color = 'var(--text-muted, #888)';
    }
  }

  async function loadGatewayConfig() {
    if (!editor) return;
    setStatus('正在加载网关配置...', 'info');
    try {
      const res = await fetch('/api/admin/llm-gateway/raw');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const rawText = data.raw || JSON.stringify(data.config, null, 2);
      editor.value = rawText;
      setStatus(`✅ 配置已载入 (${new Date().toLocaleTimeString()})`, 'success');
    } catch (err) {
      console.error('Failed to load raw LLM gateway config:', err);
      setStatus(`❌ 加载失败: ${err.message}`, 'error');
    }
  }

  // Bind Tab Click
  if (tabLlmGatewayBtn && tabContentLlmGateway) {
    tabLlmGatewayBtn.addEventListener('click', async () => {
      tabLlmGatewayBtn.classList.add('active');
      if (tabInviteCodesBtn) tabInviteCodesBtn.classList.remove('active');
      if (tabAgentsBtn) tabAgentsBtn.classList.remove('active');
      if (tabAppIconsBtn) tabAppIconsBtn.classList.remove('active');

      tabContentLlmGateway.classList.remove('hidden');
      if (tabContentInviteCodes) tabContentInviteCodes.classList.add('hidden');
      if (tabContentAgents) tabContentAgents.classList.add('hidden');
      if (tabContentAppIcons) tabContentAppIcons.classList.add('hidden');

      if (modalCard) {
        modalCard.classList.add('wide-modal');
      }

      await loadGatewayConfig();
    });
  }

  // Restore normal modal width when clicking other tabs
  const otherTabs = [tabInviteCodesBtn, tabAgentsBtn, tabAppIconsBtn];
  otherTabs.forEach(btn => {
    if (btn) {
      btn.addEventListener('click', () => {
        if (tabLlmGatewayBtn) tabLlmGatewayBtn.classList.remove('active');
        if (tabContentLlmGateway) tabContentLlmGateway.classList.add('hidden');
        if (modalCard) {
          modalCard.classList.remove('wide-modal');
        }
      });
    }
  });

  // Support Tab key indentation inside JSON editor
  if (editor) {
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const value = editor.value;

        editor.value = value.substring(0, start) + '  ' + value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
      }
    });
  }

  // Format Button
  if (formatBtn && editor) {
    formatBtn.addEventListener('click', () => {
      try {
        const val = editor.value.trim();
        if (!val) return;
        const parsed = JSON.parse(val);
        editor.value = JSON.stringify(parsed, null, 2);
        setStatus('✅ JSON 格式化完成', 'success');
      } catch (err) {
        setStatus(`❌ JSON 语法错误: ${err.message}`, 'error');
      }
    });
  }

  // Reload Button
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      loadGatewayConfig();
    });
  }

  // Save Button
  if (saveBtn && editor) {
    saveBtn.addEventListener('click', async () => {
      const val = editor.value.trim();
      let parsed;
      try {
        parsed = JSON.parse(val);
      } catch (err) {
        setStatus(`❌ 保存失败，JSON 格式错误: ${err.message}`, 'error');
        return;
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setStatus('❌ 保存失败: 配置必须是 JSON 根对象', 'error');
        return;
      }

      saveBtn.disabled = true;
      const originalHtml = saveBtn.innerHTML;
      saveBtn.innerHTML = '<span class="btn-text">保存中...</span>';
      setStatus('正在保存配置到磁盘...', 'info');

      try {
        const res = await fetch('/api/admin/llm-gateway/raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: val })
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          editor.value = JSON.stringify(data.config || parsed, null, 2);
          setStatus(`✅ 配置已成功保存并立即生效 (${new Date().toLocaleTimeString()})`, 'success');
        } else {
          setStatus(`❌ 保存失败: ${data.error || '未知错误'}`, 'error');
        }
      } catch (err) {
        console.error('Failed to save LLM gateway config:', err);
        setStatus(`❌ 网络异常: ${err.message}`, 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalHtml;
      }
    });
  }
}
