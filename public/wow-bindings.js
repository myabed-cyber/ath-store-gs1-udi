(() => {
  const TOKEN_KEY = 'ath_token';

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  const fmtInt = (n) => {
    try { return Number(n || 0).toLocaleString('en-US'); } catch { return String(n ?? 0); }
  };

  const apiFetch = async (path, opts = {}) => {
    const headers = new Headers(opts.headers || {});
    if (!headers.has('Content-Type') && opts.body) headers.set('Content-Type', 'application/json');
    const t = getToken();
    if (t) headers.set('Authorization', `Bearer ${t}`);
    const res = await fetch(path, { ...opts, headers });
    return res;
  };

  const viewLogin = () => {
    document.getElementById('view-dashboard')?.classList.remove('active');
    setTimeout(() => document.getElementById('view-login')?.classList.add('active'), 20);
  };

  const viewDashboard = () => {
    document.getElementById('view-login')?.classList.remove('active');
    setTimeout(() => document.getElementById('view-dashboard')?.classList.add('active'), 20);
  };

  const safeToast = (title, msg, type) => {
    try {
      // Use WOW's native toast if present
      if (typeof window.showToast === 'function') return window.showToast(title, msg, type);
    } catch {}
    // Fallback minimal toast
    alert(`${title}\n${msg}`);
  };

  const setLoginBtnDefault = () => {
    const btn = document.getElementById('loginBtn');
    if (!btn) return;
    btn.innerHTML = `<span>Initialize System</span><i class="ph-bold ph-arrow-right"></i>`;
  };

  const renderThroughput = (throughputRows) => {
    const container = document.getElementById('chart-container');
    if (!container) return;
    container.innerHTML = '';

    const series = Array.isArray(throughputRows) ? throughputRows.slice() : [];
    // Normalize to 12 buckets (pad from the left)
    const counts = series.map(r => Number(r?.count || 0));
    const padded = [];
    const need = 12;
    const start = Math.max(0, counts.length - need);
    for (let i = start; i < counts.length; i++) padded.push(counts[i]);
    while (padded.length < need) padded.unshift(0);

    const max = Math.max(...padded, 1);

    padded.forEach((val, i) => {
      const bar = document.createElement('div');
      bar.style.cssText =
        `flex: 1; background: var(--glass-border); border-radius: 6px; height: 0%; ` +
        `transition: height 1s cubic-bezier(0.34, 1.56, 0.64, 1); cursor: pointer;`;
      bar.onmouseenter = () => {
        try { window.sfx?.hover?.(); } catch {}
        bar.style.background = 'var(--brand-primary)';
      };
      bar.onmouseleave = () => (bar.style.background = 'var(--glass-border)');
      container.appendChild(bar);
      const h = Math.round((val / max) * 100);
      setTimeout(() => (bar.style.height = h + '%'), i * 50);
    });
  };

  const updateDashboard = (data) => {
    // Stat cards
    const cards = document.querySelectorAll('.stat-card');
    if (cards.length >= 3) {
      // Daily scans (big number)
      const dailyVal = cards[0].querySelector('.stat-val');
      if (dailyVal) dailyVal.textContent = fmtInt(data?.daily_scans ?? 0);

      // Success rate (top-right percent)
      const sr = Number(data?.success_rate ?? 0);
      // In card #2, the top-right percent is the only div containing '%'
      const srNode = Array.from(cards[1].querySelectorAll('div'))
        .find(d => (d.textContent || '').trim().includes('%'));
      if (srNode) srNode.textContent = `${sr.toFixed(1)}%`;

      // Pending issues (big number)
      const pendingVal = cards[2].querySelector('.stat-val');
      if (pendingVal) pendingVal.textContent = String(data?.pending_issues ?? 0);
    }

    // Recent activity table
    const tbody = document.querySelector('.data-table tbody');
    if (tbody) {
      tbody.innerHTML = '';
      const rows = Array.isArray(data?.recent_scans) ? data.recent_scans.slice(0, 6) : [];
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        tr.setAttribute('onmouseenter', 'sfx.hover()');

        const scanId = (r?.scan_id || '').toString();
        const normalized = (r?.normalized || r?.raw_string || '').toString();
        const decision = (r?.decision || '').toString().toUpperCase();

        // A tiny “product” label based on GTIN if present
        let productLabel = '—';
        const m = normalized.match(/\(01\)(\d{14})/);
        if (m) productLabel = `GTIN ${m[1]}`;
        else if (normalized.length) productLabel = normalized.length > 24 ? normalized.slice(0, 24) + '…' : normalized;

        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = decision === 'PASS' ? 'VERIFIED' : (decision || '—');

        if (decision === 'PASS') {
          badge.classList.add('success');
        } else if (decision === 'WARN') {
          badge.style.cssText = 'background: rgba(245, 158, 11, 0.15); color: var(--tactical-amber); border: 1px solid rgba(245, 158, 11, 0.2);';
        } else if (decision === 'BLOCK') {
          badge.style.cssText = 'background: rgba(239, 68, 68, 0.15); color: var(--tactical-red); border: 1px solid rgba(239, 68, 68, 0.2);';
        } else {
          badge.style.cssText = 'background: rgba(148, 163, 184, 0.12); color: var(--text-muted); border: 1px solid rgba(148, 163, 184, 0.18);';
        }

        const td1 = document.createElement('td');
        td1.style.fontFamily = "'JetBrains Mono'";
        td1.textContent = scanId ? `#${scanId}` : '—';

        const td2 = document.createElement('td');
        td2.textContent = productLabel;

        const td3 = document.createElement('td');
        td3.appendChild(badge);

        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
        tbody.appendChild(tr);
      });
    }

    // Throughput chart
    renderThroughput(data?.throughput || []);
  };

  const refreshOverview = async () => {
    const t = getToken();
    if (!t) return;
    try {
      const r = await apiFetch('/api/ui/overview', { method: 'GET' });
      if (r.status === 401 || r.status === 403) {
        clearToken();
        viewLogin();
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (data?.ok) updateDashboard(data);
    } catch (e) {
      // silent
    }
  };

  // ---------------- AUTH: override WOW's fake login with real backend login ----------------
  const bindAuth = () => {
    const form = document.getElementById('loginForm');
    if (!form) return;

    // Capture phase to prevent WOW demo handler
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();

      try { window.sfx?.click?.(); } catch {}

      const inputs = form.querySelectorAll('input');
      const username = (inputs[0]?.value || '').trim();
      const password = (inputs[1]?.value || '').toString();

      const btn = document.getElementById('loginBtn');
      if (btn) btn.innerHTML = `<i class="ph-bold ph-spinner" style="animation: spin 1s infinite linear"></i> Authenticating...`;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.token) {
          setLoginBtnDefault();
          safeToast('Login Failed', (data?.error || 'Invalid credentials').toString(), 'error');
          return;
        }

        setToken(data.token);

        // Keep WOW transition timing
        document.getElementById('view-login')?.classList.remove('active');
        setTimeout(() => {
          document.getElementById('view-dashboard')?.classList.add('active');
          try { window.sfx?.play?.('success'); } catch {}
          safeToast('Welcome Back', `${data?.user?.username || username} — System Online.`, 'success');
          refreshOverview();
        }, 400);
      } catch (err) {
        setLoginBtnDefault();
        safeToast('Login Error', 'Network or server error', 'error');
      }
    }, true);
  };

  // ---------------- Logout: clear token and keep WOW transition ----------------
  const patchLogout = () => {
    window.logout = () => {
      try { window.sfx?.click?.(); } catch {}
      clearToken();
      try { window.__athStopCamera?.(); } catch {}
      document.getElementById('view-dashboard')?.classList.remove('active');
      setTimeout(() => {
        document.getElementById('view-login')?.classList.add('active');
        setLoginBtnDefault();
        document.getElementById('loginForm')?.reset?.();
      }, 400);
    };
  };

  // ---------------- Scanner: replace WOW fake scan with real capture+validate ----------------
  const patchScanner = () => {
    let stream = null;
    let videoEl = null;
    let stopLoop = false;

    const ensureVideo = () => {
      if (videoEl) return videoEl;
      const viewport = document.querySelector('#globalScanner .scanner-viewport');
      if (!viewport) return null;

      videoEl = document.createElement('video');
      videoEl.setAttribute('playsinline', '');
      videoEl.muted = true;
      videoEl.autoplay = true;
      videoEl.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;border-radius:16px;opacity:0.95;';

      viewport.prepend(videoEl);
      return videoEl;
    };

    const startCamera = async () => {
      const v = ensureVideo();
      if (!v) throw new Error('NO_VIEWPORT');

      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });
      v.srcObject = stream;
      try { await v.play(); } catch {}
    };

    const stopCamera = () => {
      stopLoop = true;
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      if (videoEl) {
        try { videoEl.pause(); } catch {}
        videoEl.srcObject = null;
      }
    };

    window.__athStopCamera = stopCamera;

    const submitScan = async (raw) => {
      const token = getToken();
      if (!token) {
        safeToast('Not Logged In', 'Please login first.', 'warn');
        return;
      }

      const scan_id = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 8).toUpperCase();
      const idem = crypto?.randomUUID ? crypto.randomUUID() : `idem-${scan_id}-${Date.now()}`;

      const payload = {
        scan_id,
        raw_string: raw,
        context: { source: 'WOW_UI', device: 'web', ts: new Date().toISOString() }
      };

      try {
        const res = await apiFetch('/api/scans/parse-validate', {
          method: 'POST',
          headers: { 'Idempotency-Key': idem },
          body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          safeToast('Scan Error', (data?.error || `HTTP ${res.status}`).toString(), 'error');
          return;
        }

        const decision = (data?.decision || '').toString().toUpperCase();
        if (decision === 'PASS') {
          try { window.sfx?.play?.('success'); } catch {}
          safeToast('Scan Verified', `UDI: ${raw}`, 'success');
        } else if (decision === 'WARN') {
          try { window.sfx?.play?.('scan_start'); } catch {}
          safeToast('Validation Warning', 'Requires review', 'warn');
        } else {
          try { window.sfx?.play?.('scan_start'); } catch {}
          safeToast('Blocked', 'Admin action required', 'error');
        }

        refreshOverview();
      } catch (e) {
        safeToast('Scan Error', 'Network or server error', 'error');
      }
    };

    window.triggerScan = async () => {
      const scanner = document.getElementById('globalScanner');
      const status = document.getElementById('scannerStatus');
      const btn = document.querySelector('.scan-trigger-btn');

      // Use WOW's state if present
      if (window.state && typeof window.state === 'object') {
        window.state.scanning = !window.state.scanning;
      } else {
        window.state = { scanning: true };
      }

      const scanning = !!window.state.scanning;

      if (scanning) {
        try { window.sfx?.play?.('scan_start'); } catch {}
        scanner?.classList.add('active');
        if (status) { status.innerText = 'ACTIVE CAPTURE'; status.style.color = 'var(--tactical-red)'; }
        if (btn) btn.innerHTML = `<i class="ph-bold ph-spinner" style="animation: spin 1s infinite linear"></i> STOP`;

        stopLoop = false;

        const hasDetector = ('BarcodeDetector' in window);
        const detector = hasDetector ? new window.BarcodeDetector({
          formats: ['data_matrix','qr_code','code_128','ean_13','ean_8','upc_a','upc_e','itf','code_39','codabar']
        }) : null;

        try {
          await startCamera();
        } catch (e) {
          // No camera: fallback to manual paste
          const manual = prompt('Paste/Type barcode value:');
          window.state.scanning = false;
          scanner?.classList.remove('active');
          if (status) { status.innerText = 'STANDBY'; status.style.color = 'var(--brand-primary)'; }
          if (btn) btn.innerHTML = `<i class="ph-bold ph-aperture"></i> SCAN`;
          if (manual) await submitScan(manual.trim());
          return;
        }

        if (!detector) {
          // No BarcodeDetector support: fallback to manual while camera is shown
          setTimeout(async () => {
            if (!window.state.scanning) return;
            const manual = prompt('Paste/Type barcode value:');
            window.state.scanning = false;
            stopCamera();
            scanner?.classList.remove('active');
            if (status) { status.innerText = 'STANDBY'; status.style.color = 'var(--brand-primary)'; }
            if (btn) btn.innerHTML = `<i class="ph-bold ph-aperture"></i> SCAN`;
            if (manual) await submitScan(manual.trim());
          }, 250);
          return;
        }

        const loop = async () => {
          if (stopLoop || !window.state.scanning) return;
          try {
            if (videoEl && videoEl.readyState >= 2) {
              const codes = await detector.detect(videoEl);
              if (codes && codes.length) {
                const raw = codes[0]?.rawValue || '';
                window.state.scanning = false;
                stopCamera();
                scanner?.classList.remove('active');
                if (status) { status.innerText = 'STANDBY'; status.style.color = 'var(--brand-primary)'; }
                if (btn) btn.innerHTML = `<i class="ph-bold ph-aperture"></i> SCAN`;
                if (raw) await submitScan(raw);
                return;
              }
            }
          } catch {}
          requestAnimationFrame(loop);
        };

        requestAnimationFrame(loop);
      } else {
        try { window.sfx?.click?.(); } catch {}
        stopCamera();
        scanner?.classList.remove('active');
        if (status) { status.innerText = 'STANDBY'; status.style.color = 'var(--brand-primary)'; }
        if (btn) btn.innerHTML = `<i class="ph-bold ph-aperture"></i> SCAN`;
      }
    };
  };

  const checkSession = async () => {
    const token = getToken();
    if (!token) { viewLogin(); return; }

    try {
      const r = await apiFetch('/api/auth/me', { method: 'GET' });
      if (!r.ok) {
        clearToken();
        viewLogin();
        return;
      }
      viewDashboard();
      refreshOverview();
    } catch {
      // If backend is down, still show login
      viewLogin();
    }
  };

  // Periodic refresh when dashboard is active
  setInterval(() => {
    const dashActive = document.getElementById('view-dashboard')?.classList.contains('active');
    if (dashActive) refreshOverview();
  }, 15000);

  // Boot
  bindAuth();
  patchLogout();
  patchScanner();
  checkSession();
})();
