// Cyberpunk Welcome Page Interactivity

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // 1. 3D Grid Parallax Effect
  const welcomeGrid3D = document.getElementById('welcomeGrid3D');
  if (welcomeGrid3D) {
    document.body.addEventListener('mousemove', (e) => {
      if (window.innerWidth <= 768) return;
      
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      const centerX = width / 2;
      const centerY = height / 2;
      
      // Calculate tilts (Max +/- 5 degrees on X, Max +/- 6 degrees on Y)
      const tiltX = ((e.clientY - centerY) / centerY) * -5;
      const tiltY = ((e.clientX - centerX) / centerX) * 6;
      
      welcomeGrid3D.style.transform = `rotateX(${30 + tiltX}deg) rotateY(${tiltY}deg) translate3d(0, 0, 0)`;
    });
    
    document.body.addEventListener('mouseleave', () => {
      if (window.innerWidth <= 768) return;
      welcomeGrid3D.style.transform = 'rotateX(30deg) rotateY(0deg) translate3d(0, 0, 0)';
    });
  }

  // 2. Interactive Feature Tabs Showcase
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');

      // Deactivate all buttons
      tabBtns.forEach(b => b.classList.remove('active'));
      // Hide all panels
      tabPanels.forEach(p => p.classList.remove('active'));

      // Activate selected button & panel
      btn.classList.add('active');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }

      // Re-trigger icon rendering in newly shown panel if needed
      if (window.lucide) {
        window.lucide.createIcons();
      }
    });
  });

  // 3. Copy Installation Command Functionality
  const copyBtn = document.getElementById('copyInstallBtn');
  const tooltip = document.getElementById('copyTooltip');
  const codeContent = document.getElementById('installCode');

  if (copyBtn && codeContent && tooltip) {
    copyBtn.addEventListener('click', async () => {
      const codeText = codeContent.textContent.trim();
      
      try {
        await navigator.clipboard.writeText(codeText);
        
        // Show success state
        tooltip.classList.add('show');
        copyBtn.style.borderColor = 'var(--neon-green)';
        copyBtn.style.color = 'var(--neon-green)';
        copyBtn.style.boxShadow = '0 0 10px rgba(57, 255, 20, 0.4)';
        
        // Reset after delay
        setTimeout(() => {
          tooltip.classList.remove('show');
          copyBtn.style.borderColor = '';
          copyBtn.style.color = '';
          copyBtn.style.boxShadow = '';
        }, 2000);
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
      }
    });
  }

  // 4. Dynamically Adjust Landing Page CTAs based on Auth Status
  fetch('/api/auth-status')
    .then(res => res.json())
    .then(data => {
      if (data.authenticated) {
        // Update main CTAs to Enter Dashboard
        const consoleBtnText = document.querySelectorAll('.console-btn-text');
        consoleBtnText.forEach(el => {
          el.textContent = 'ENTER DASHBOARD // 进入控制台';
        });

        // Update nav login button to dashboard
        const navLoginBtnText = document.querySelector('.login-btn-text');
        const navLoginBtn = document.querySelector('.nav-login-btn');
        if (navLoginBtnText && navLoginBtn) {
          navLoginBtnText.textContent = 'DASHBOARD // 控制面板';
          navLoginBtn.setAttribute('href', '/');
          // Update icon if lucide is active
          const iconEl = navLoginBtn.querySelector('i');
          if (iconEl) {
            iconEl.setAttribute('data-lucide', 'layout-dashboard');
          }
        }

        // Update footer links to login page to directly link to /
        const footerLinks = document.querySelectorAll('a[href="/login.html"]');
        footerLinks.forEach(link => {
          link.setAttribute('href', '/');
          if (link.textContent.includes('登录控制台')) {
            link.textContent = '控制面板';
          }
        });

        if (window.lucide) {
          window.lucide.createIcons();
        }
      }
    })
    .catch(err => {
      console.warn('Unable to retrieve auth-status for welcome dashboard links:', err);
    });
});
