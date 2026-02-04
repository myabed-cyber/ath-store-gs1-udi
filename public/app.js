/* GS1/UDI Enterprise Hub — UI Rebuild (v3)
   - Static HTML/JS (no build) + PWA shell
   - Scanner: BarcodeDetector (preferred) with ZXing fallback (optional file: /public/zxing-browser.min.js)
   - Parsing: best-effort GS1 AI parsing in UI + optional remote parse/validate probing
   - API base can be set via:
       1) window.__API_BASE__ (injected by server)
       2) ?api=https://host (query param)
       3) same-origin default
*/
(() => {
  const BUILD = 'v4';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    token: localStorage.getItem('gs1hub.token') || '',
    me: safeJson(localStorage.getItem('gs1hub.me')) || null,
    apiBase: resolveApiBase(),
    lastScan: null,
    queue: safeJson(localStorage.getItem('gs1hub.queue')) || [],
    scan: {
      running: false,
      engine: 'auto',
      detector: null,
      rafId: 0,
      stream: null,
      track: null,
      deviceIds: [],
      deviceIndex: 0,
      torchOn: false,
      zxing: { reader: null, controls: null },
      lastRaw: '',
      lastAt: 0,
    },
  };

  // ---- Router
  const routes = {
    login: showLogin,
    operator: () => requireRole(['operator', 'admin', 'auditor'], showOperator),
    admin: () => requireRole(['admin', 'auditor'], showAdmin),
    docs: () => requireRole(['operator', 'admin', 'auditor'], showDocs),
    unauth: showUnauth,
  };

  function boot() {
    $('#envHint').textContent = `API=${state.apiBase || '(same-origin)'} • build=${BUILD}`;
    bindAuth();
    bindOperator();
    bindAdmin();
    bindDocs();
    registerSW();
    navigate();
    window.addEventListener('hashchange', navigate);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopScan('hidden');
    });
  }

  function navigate() {
    const page = (location.hash.replace('#/', '') || '').trim();
    const target = page || (state.token ? 'operator' : 'login');

    // Leaving operator? stop camera.
    const current = $$('.page').find(p => !p.hidden)?.dataset?.page;
    if (current === 'operator' && target !== 'operator') stopScan('nav');

    setActiveNav(target);
    if (routes[target]) routes[target]();
    else routes.login();
  }

  function showPage(name) {
    $$('.page').forEach(p => (p.hidden = p.dataset.page !== name));
  }

  function setActiveNav(name) {
    $$('[data-nav]').forEach(a => a.classList.toggle('is-active', a.dataset.nav === name));
  }

  // ---- Auth / RBAC
  function showLogin() {
    showPage('login');
    $('#btnLogout').hidden = true;
  }

  function showUnauth() {
    showPage('unauth');
    $('#btnLogout').hidden = true;
  }

  function showOperator() {
    showPage('operator');
    $('#btnLogout').hidden = false;
    $('#authBadge').textContent = roleLabel();
    renderFields({});
    renderQueue();
    updateScanButtons();
  }

  function showAdmin() {
    showPage('admin');
    $('#btnLogout').hidden = false;
    refreshDashboard().catch(() => {});
    refreshCases().catch(() => {});
    refreshUsers().catch(() => {});
  }

  function showDocs() {
    showPage('docs');
    $('#btnLogout').hidden = false;
  }

  function requireRole(allowed, ok) {
    const role = (state.me && state.me.role) || '';
    if (!state.token || !allowed.includes(role)) {
      location.hash = '#/unauth';
      showUnauth();
      return;
    }
    ok();
  }

  function roleLabel() {
    const role = (state.me && state.me.role) || 'unknown';
    const user = (state.me && state.me.username) || '—';
    return `${user} • ${role}`;
  }

  function bindAuth() {
    $('#btnGoLogin')?.addEventListener('click', () => (location.hash = '#/login'));

    $('#btnLogout')?.addEventListener('click', () => {
      stopScan('logout');
      state.token = '';
      state.me = null;
      localStorage.removeItem('gs1hub.token');
      localStorage.removeItem('gs1hub.me');
      location.hash = '#/login';
    });

    $('#btnHealth')?.addEventListener('click', async () => {
      try {
        await apiGet('/api/health');
        toast('Health OK', 'ok');
      } catch (e) {
        toast('Health failed: ' + String(e.message || e), 'bad');
      }
    });

    $('#btnDemo')?.addEventListener('click', () => {
      $('#loginUser').value = 'operator';
      $('#loginPass').value = 'operator';
    });

    $('#loginForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      setAlert('#loginAlert', null);
      $('#btnLogin').disabled = true;
      try {
        const username = $('#loginUser').value.trim();
        const password = $('#loginPass').value;
        const res = await apiPost('/api/auth/login', { username, password });

        if (!res || !res.token) throw new Error('Missing token from /api/auth/login');
        state.token = res.token;
        state.me = res.user || null;

        localStorage.setItem('gs1hub.token', state.token);
        localStorage.setItem('gs1hub.me', JSON.stringify(state.me || {}));

        toast('تم تسجيل الدخول', 'ok');
        location.hash = '#/operator';
      } catch (e) {
        setAlert('#loginAlert', e.message || String(e), 'bad');
      } finally {
        $('#btnLogin').disabled = false;
      }
    });
  }

  // ---- Operator
  function bindOperator() {
    $('#btnCopyJson')?.addEventListener('click', async () => {
      const payload = buildCommitPayload();
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      toast('تم النسخ', 'ok');
    });

    $('#btnRescan')?.addEventListener('click', () => {
      state.lastScan = null;
      $('#rawLast').textContent = '—';
      setStatus('—', 'neutral');
      renderFields({});
      $('#commitOut').textContent = 'ابدأ المسح أولاً.';
    });

    $('#btnCreateCase')?.addEventListener('click', async () => {
      try {
        const payload = {
          raw: (state.lastScan && state.lastScan.raw) || '',
          parsed: (state.lastScan && state.lastScan.parsed) || {},
          reason: 'OPERATOR_ESCALATION',
        };
        const res = await apiPost('/api/cases', payload);
        toast('تم إنشاء Case', 'ok');
        $('#commitOut').textContent = JSON.stringify(res, null, 2);
      } catch (e) {
        toast('فشل إنشاء Case: ' + (e.message || e), 'bad');
      }
    });

    $('#btnCommitReceipt')?.addEventListener('click', () => commit('RECEIPT'));
    $('#btnCommitTransfer')?.addEventListener('click', () => commit('TRANSFER'));

    $('#btnUpsertMap')?.addEventListener('click', async () => {
      setAlert('#mapAlert', null);
      try {
        const gtin = $('#gtinInput').value.trim();
        const itemNo = $('#itemInput').value.trim();
        if (!gtin || !itemNo) throw new Error('GTIN و Item No مطلوبين');
        const res = await apiPost('/api/gtin-map/upsert', { gtin, itemNo });
        setAlert('#mapAlert', 'تم الحفظ', 'ok');
        $('#commitOut').textContent = JSON.stringify(res, null, 2);
      } catch (e) {
        setAlert('#mapAlert', e.message || String(e), 'bad');
      }
    });

    $('#btnSync')?.addEventListener('click', async () => {
      await syncQueue();
    });

    // Scanner controls
    $('#btnStart')?.addEventListener('click', async () => {
      try {
        await startScan();
      } catch (e) {
        toast(e.message || String(e), 'bad');
      }
    });

    $('#btnStop')?.addEventListener('click', () => stopScan('user'));
    $('#btnTorch')?.addEventListener('click', () => toggleTorch());
    $('#btnSwap')?.addEventListener('click', () => swapCamera());
  }

  function updateScanButtons() {
    const running = state.scan.running;
    $('#btnStart').disabled = running;
    $('#btnStop').disabled = !running;
    $('#btnTorch').disabled = !running || !state.scan.track;
    $('#btnSwap').disabled = !running || (state.scan.deviceIds.length < 2);
    $('#btnTorch').textContent = state.scan.torchOn ? 'فلاش: ON' : 'فلاش';
  }

  async function startScan() {
    if (!state.token) throw new Error('سجّل الدخول أولاً');
    if (state.scan.running) return;

    state.scan.engine = ($('#engineSelect')?.value || 'auto').toLowerCase();
    await ensureCameraList();

    const preferBD = canBarcodeDetector();
    const wantsZX = state.scan.engine === 'zxing';
    const wantsBD = state.scan.engine === 'bd';

    if ((wantsBD || (state.scan.engine === 'auto' && preferBD)) && canBarcodeDetector()) {
      await startBarcodeDetectorEngine();
      toast('BarcodeDetector: تشغيل', 'ok');
      return;
    }

    if (!wantsBD) {
      await startZXingEngine();
      toast('ZXing: تشغيل', 'ok');
      return;
    }

    throw new Error('لا يوجد Engine متاح. جرّب Chrome/Edge أو أضف zxing-browser.min.js');
  }

  function stopScan(reason) {
    if (!state.scan.running && !state.scan.stream && !state.scan.zxing.reader) return;

    state.scan.running = false;
    if (state.scan.rafId) cancelAnimationFrame(state.scan.rafId);
    state.scan.rafId = 0;

    // ZXing cleanup
    try { state.scan.zxing.controls?.stop?.(); } catch {}
    try { state.scan.zxing.reader?.reset?.(); } catch {}
    state.scan.zxing.controls = null;
    state.scan.zxing.reader = null;

    // BarcodeDetector cleanup
    state.scan.detector = null;

    // Camera stream cleanup
    if (state.scan.stream) {
      try { state.scan.stream.getTracks().forEach(t => t.stop()); } catch {}
    }
    state.scan.stream = null;
    state.scan.track = null;
    state.scan.torchOn = false;

    const v = $('#video');
    if (v) {
      try { v.pause(); } catch {}
      v.srcObject = null;
    }

    updateScanButtons();
    if (reason && reason !== 'nav') console.log('scan stopped:', reason);
  }

  function canBarcodeDetector() {
    return typeof window.BarcodeDetector === 'function';
  }

  async function ensureCameraList() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devs = await navigator.mediaDevices.enumerateDevices();
    state.scan.deviceIds = devs.filter(d => d.kind === 'videoinput').map(d => d.deviceId);
    if (state.scan.deviceIndex >= state.scan.deviceIds.length) state.scan.deviceIndex = 0;
  }

  async function getStreamForCurrentDevice() {
    const deviceId = state.scan.deviceIds[state.scan.deviceIndex];
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
  }

  async function startBarcodeDetectorEngine() {
    stopScan('restart');
    state.scan.running = true;

    const v = $('#video');
    if (!v) throw new Error('Video element missing');

    let formats = ['data_matrix', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'itf'];
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      formats = formats.filter(f => supported.includes(f));
    } catch {}

    state.scan.detector = new BarcodeDetector({ formats });
    state.scan.stream = await getStreamForCurrentDevice();
    v.srcObject = state.scan.stream;
    await v.play();
    state.scan.track = state.scan.stream.getVideoTracks()[0] || null;

    updateScanButtons();
    loopBarcodeDetector(v);
  }

  async function loopBarcodeDetector(videoEl) {
    if (!state.scan.running || !state.scan.detector) return;
    try {
      const codes = await state.scan.detector.detect(videoEl);
      if (codes?.length) {
        const raw = codes[0].rawValue || '';
        if (raw) await onDecoded(raw);
      }
    } catch {}
    state.scan.rafId = requestAnimationFrame(() => loopBarcodeDetector(videoEl));
  }

  async function startZXingEngine() {
    stopScan('restart');
    state.scan.running = true;

    let Z = window.ZXingBrowser || window.ZXing;
    // If ZXing is being loaded via the local loader, wait for it.
    if (!Z && window.__ZXING_LOADING__ && typeof window.__ZXING_LOADING__.then === 'function') {
      try { await window.__ZXING_LOADING__; } catch {}
      Z = window.ZXingBrowser || window.ZXing;
    }
    if (!Z) throw new Error('ZXing غير موجود. (ملاحظة: ملف /public/zxing-browser.min.js هنا يقوم بتحميل ZXing من CDN).');

    const v = $('#video');
    if (!v) throw new Error('Video element missing');

    const ReaderCtor =
      Z.BrowserMultiFormatReader ||
      Z.BrowserMultiFormatContinuousReader ||
      Z.BrowserQRCodeReader ||
      null;

    if (!ReaderCtor) throw new Error('ZXing bundle غير متوافق');

    const reader = new ReaderCtor();
    state.scan.zxing.reader = reader;

    await ensureCameraList();
    const deviceId = state.scan.deviceIds[state.scan.deviceIndex] || null;

    updateScanButtons();

    const controls = await reader.decodeFromVideoDevice(deviceId, v, (result) => {
      if (result) {
        const txt = typeof result.getText === 'function' ? result.getText() : (result.text || result.rawValue || String(result));
        onDecoded(txt);
      }
    });

    state.scan.zxing.controls = controls || null;

    try {
      const stream = v.srcObject;
      if (stream?.getVideoTracks) state.scan.track = stream.getVideoTracks()[0] || null;
    } catch {}

    updateScanButtons();
  }

  async function swapCamera() {
    if (!state.scan.running) return;
    if (state.scan.deviceIds.length < 2) return;

    state.scan.deviceIndex = (state.scan.deviceIndex + 1) % state.scan.deviceIds.length;

    const engine = state.scan.engine;
    if (engine === 'zxing') await startZXingEngine();
    else await startBarcodeDetectorEngine();

    toast('تم تبديل الكاميرا', 'ok');
  }

  async function toggleTorch() {
    const t = state.scan.track;
    if (!t) return toast('الفلاش غير متاح في هذا الوضع', 'warn');

    const caps = t.getCapabilities ? t.getCapabilities() : {};
    if (!caps.torch) return toast('الجهاز لا يدعم Torch', 'warn');

    state.scan.torchOn = !state.scan.torchOn;
    try {
      await t.applyConstraints({ advanced: [{ torch: state.scan.torchOn }] });
      updateScanButtons();
    } catch {
      state.scan.torchOn = false;
      updateScanButtons();
      toast('فشل تشغيل الفلاش', 'bad');
    }
  }

  async function onDecoded(raw) {
    const now = Date.now();
    const clean = String(raw || '').trim();
    if (!clean) return;

    if (clean === state.scan.lastRaw && (now - state.scan.lastAt) < 1200) return;
    state.scan.lastRaw = clean;
    state.scan.lastAt = now;

    $('#rawLast').textContent = clean;
    setStatus('…', 'neutral');

    let parsed = null;
    let decision = null;

    const remote = await tryRemoteParseValidate(clean);
    if (remote) {
      parsed = remote.parsed || remote.data || remote.result?.parsed || remote.payload?.parsed || null;
      decision = remote.decision || remote.status || remote.result?.decision || remote.verdict || null;
    }

    if (!parsed) parsed = parseGS1(clean);
    if (!decision) decision = localDecision(parsed);

    applyScan({ raw: clean, parsed, status: String(decision).toUpperCase() });
  }

  function applyScan({ raw, parsed, status }) {
    // NO-BLOCK: normalize any BLOCK -> WARN
    let _status = String(status || '').toUpperCase();
    if (_status === 'BLOCK') _status = 'WARN';
    state.lastScan = { raw, parsed, status: _status };
    setStatus(_status, _status.toLowerCase());
    renderFields(parsed || {});
    renderWarnings(parsed || {}, _status);
    $('#commitOut').textContent = JSON.stringify({ status, parsed }, null, 2);
  }

  function setStatus(label, variant) {
    const el = $('#statusPill');
    const map = { pass: 'ok', warn: 'warn', block: 'bad', neutral: 'neutral' };
    const v = map[variant] || 'neutral';
    let cls = 'pill';
    if (v === 'ok') cls += ' pill--ok';
    if (v === 'warn') cls += ' pill--warn';
    if (v === 'bad') cls += ' pill--bad';
    el.innerHTML = `<span class="${cls}">${escapeHtml(label)}</span>`;
  }

  function renderFields(parsed) {
    const grid = $('#fieldsGrid');
    if (!grid) return;

    const ai = parsed.ai && typeof parsed.ai === 'object' ? parsed.ai : {};
    const core = {
      GTIN: parsed.gtin || ai['01'],
      LOT: parsed.lot || ai['10'],
      EXP: parsed.expiry || ai['17'],
      SERIAL: parsed.serial || ai['21'],
      QTY: parsed.qty || ai['30'] || ai['37'],
      UDI: parsed.udi || '',
    };

    const extraPairs = Object.entries(ai)
      .filter(([k]) => !['01', '10', '17', '21', '30', '37'].includes(k))
      .slice(0, 18);

    const items = [
      ...Object.entries(core),
      ...extraPairs.map(([k, v]) => [`AI ${k}`, v]),
    ];

    grid.innerHTML = items
      .map(([k, v]) => `
      <div class="kv">
        <div class="kv__k">${escapeHtml(k)}</div>
        <div class="kv__v mono">${escapeHtml(v || '—')}</div>
      </div>
    `).join('');
  }

  function computeWarnReasons(parsed) {
    const ai = parsed.ai && typeof parsed.ai === 'object' ? parsed.ai : {};
    const reasons = [];
    const gtin = parsed.gtin || ai['01'] || '';
    if (!gtin || String(gtin).length < 14) reasons.push('GTIN غير مكتمل أو غير موجود');
    const lot = parsed.lot || ai['10'] || '';
    if (!lot) reasons.push('LOT غير موجود');
    const expIso = parsed.expiry_iso || '';
    const exp = expIso || parsed.expiry || ai['17'] || '';
    if (exp) {
      // try ISO first
      const d = expIso ? new Date(expIso + 'T00:00:00Z') : new Date(exp);
      if (isNaN(d.valueOf())) {
        reasons.push('تاريخ الانتهاء غير قابل للقراءة');
      } else {
        const days = Math.floor((d - new Date()) / (1000*60*60*24));
        if (days < 0) reasons.push('المنتج منتهي الصلاحية');
        else if (days <= 30) reasons.push(`الصلاحية قريبة (${days} يوم)`);
      }
    } else {
      reasons.push('EXP غير موجود');
    }
    return reasons;
  }

  function renderWarnings(parsed, status) {
    // NO-BLOCK: show reasons when status is WARN (or when backend attaches warnings/checks)
    const host = $('#statusPill')?.closest('.kv')?.parentElement;
    if (!host) return;

    let box = $('#warnBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'warnBox';
      box.style.marginTop = '10px';
      box.style.padding = '10px 12px';
      box.style.borderRadius = '12px';
      box.style.border = '1px solid rgba(245,158,11,.35)';
      box.style.background = 'rgba(245,158,11,.08)';
      box.style.display = 'none';
      box.style.maxWidth = '100%';
      box.style.overflow = 'hidden';
      box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">تحذيرات</div><ul id="warnList" style="margin:0;padding:0 18px;line-height:1.7"></ul>';
      host.appendChild(box);
    }

    const list = $('#warnList');
    const reasons = [];

    // Prefer backend reasons if present on lastScan
    const last = state.lastScan || {};
    const backendChecks = last?.parsed?.checks || last?.parsed?.warnings || null;

    if (Array.isArray(backendChecks)) {
      for (const c of backendChecks) {
        const msg = c.message || c.msg || c.reason || c.code || '';
        if (msg) reasons.push(msg);
      }
    }

    // Always add computed reasons for operator clarity
    for (const r of computeWarnReasons(parsed || {})) {
      if (!reasons.includes(r)) reasons.push(r);
    }

    if (String(status).toUpperCase() === 'WARN' && reasons.length) {
      box.style.display = 'block';
      list.innerHTML = reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('');
    } else {
      box.style.display = 'none';
      list.innerHTML = '';
    }
  }


  function buildCommitPayload() {
    const tpl = $('#tplSelect')?.value || 'RECEIPT';
    const parsed = state.lastScan?.parsed || {};
    return {
      template: tpl,
      raw: state.lastScan?.raw || '',
      parsed,
      client_ts: new Date().toISOString(),
    };
  }

  async function commit(type) {
    try {
      if (!state.lastScan?.raw) throw new Error('ابدأ المسح أولاً');
      const payload = buildCommitPayload();
      const res = await apiPost('/api/commit', { ...payload, commitType: type });
      $('#commitOut').textContent = JSON.stringify(res, null, 2);
      toast('تم الإرسال', 'ok');
    } catch (e) {
      const msg = e.message || String(e);
      $('#commitOut').textContent = JSON.stringify({ error: msg }, null, 2);

      if (/Failed to fetch|NetworkError|ECONN|timeout/i.test(msg) && state.lastScan?.raw) {
        const job = { type: 'commit', commitType: type, payload: buildCommitPayload(), queuedAt: new Date().toISOString() };
        state.queue.push(job);
        localStorage.setItem('gs1hub.queue', JSON.stringify(state.queue));
        renderQueue();
        toast('تم الحفظ في Offline Queue', 'warn');
        return;
      }
      toast('Commit failed', 'bad');
    }
  }

  // ---- Offline Queue
  function renderQueue() {
    $('#qPending').textContent = String(state.queue.length);
  }

  async function syncQueue() {
    if (!state.queue.length) return toast('لا يوجد Pending', 'warn');
    try {
      const copy = [...state.queue];
      for (const job of copy) await apiPost('/api/queue/consume', job);
      state.queue = [];
      localStorage.setItem('gs1hub.queue', JSON.stringify(state.queue));
      renderQueue();
      toast('Sync OK', 'ok');
    } catch (e) {
      toast('Sync failed: ' + (e.message || e), 'bad');
    }
  }

  // ---- Admin bindings
  function bindAdmin() {
    $('#btnRefreshDash')?.addEventListener('click', () => refreshDashboard().catch(err => toast(err.message || err, 'bad')));
    $('#btnRefreshCases')?.addEventListener('click', () => refreshCases().catch(err => toast(err.message || err, 'bad')));
    $('#btnCreateUser')?.addEventListener('click', () => createUser().catch(err => toast(err.message || err, 'bad')));
    $('#btnAudit')?.addEventListener('click', () => refreshAudit().catch(err => toast(err.message || err, 'bad')));
    $('#caseStatus')?.addEventListener('change', () => refreshCases().catch(() => {}));
    $('#caseDecision')?.addEventListener('change', () => refreshCases().catch(() => {}));
    $('#caseQ')?.addEventListener('input', debounce(() => refreshCases().catch(() => {}), 300));
  }

  async function refreshDashboard() {
    const r = await apiGet('/api/admin/dashboard');
    $('#kpiTotal').textContent = String(r.total ?? '—');
    $('#kpiPass').textContent = String(r.pass ?? '—');
    $('#kpiWarn').textContent = String(r.warn ?? '—');
    $('#kpiBlock').textContent = String(r.block ?? '—');
  }

  async function refreshCases() {
    const qs = new URLSearchParams();
    const st = $('#caseStatus').value; if (st) qs.set('status', st);
    const dc = $('#caseDecision').value; if (dc) qs.set('decision', dc);
    const q = $('#caseQ').value.trim(); if (q) qs.set('q', q);

    const r = await apiGet('/api/cases?' + qs.toString());
    const body = $('#casesBody');
    if (!Array.isArray(r) || !r.length) {
      body.innerHTML = '<div class="muted">لا توجد حالات.</div>';
      return;
    }
    body.innerHTML = r.map(c => `
      <div class="list__item">
        <div class="mono">${escapeHtml(c.id || '')}</div>
        <div class="mono" style="opacity:.85">${escapeHtml((c.raw || '').slice(0, 60))}</div>
        <div class="mono" style="opacity:.75">${escapeHtml((c.checks || '').toString().slice(0, 40))}</div>
        <div><button class="btn btn--ghost" data-case="${escapeHtml(c.id || '')}">Open</button></div>
      </div>
    `).join('');

    $$('[data-case]').forEach(btn => btn.addEventListener('click', () => openCase(btn.getAttribute('data-case'))));
  }

  async function openCase(id) {
    const r = await apiGet('/api/cases/' + encodeURIComponent(id));
    alert(JSON.stringify(r, null, 2));
  }

  async function refreshUsers() {
    const r = await apiGet('/api/users');
    const body = $('#usersBody');
    if (!Array.isArray(r) || !r.length) {
      body.innerHTML = '<div class="muted">لا يوجد مستخدمين.</div>';
      return;
    }
    body.innerHTML = r.map(u => `
      <div class="list__item">
        <div class="mono">${escapeHtml(u.username || '')}</div>
        <div>${escapeHtml(u.role || '')}</div>
        <div class="mono" style="opacity:.75">${escapeHtml(u.created_at || '')}</div>
        <div class="mono" style="opacity:.75">${escapeHtml(u.status || '')}</div>
      </div>
    `).join('');
  }

  async function createUser() {
    const username = prompt('username?'); if (!username) return;
    const password = prompt('password?'); if (!password) return;
    const role = prompt('role? (admin/operator/auditor)', 'operator') || 'operator';
    await apiPost('/api/users', { username, password, role });
    toast('تم إنشاء المستخدم', 'ok');
    await refreshUsers();
  }

  async function refreshAudit() {
    const type = $('#auditType')?.value || '';
    const r = await apiGet('/api/audit' + (type ? `?type=${encodeURIComponent(type)}` : ''));
    $('#auditOut').textContent = JSON.stringify(r, null, 2);
  }

  function bindDocs() { /* static */ }

  // ---- Remote parse/validate probing (optional)
  async function tryRemoteParseValidate(raw) {
    const candidates = [
      { path: '/api/parse-validate', body: { raw } },
      { path: '/api/parse', body: { raw } },
      { path: '/api/validate', body: { raw } },
      { path: '/api/scan/validate', body: { raw } },
    ];
    for (const c of candidates) {
      const out = await tryPostNoThrow(c.path, c.body);
      if (out?.ok) return out.data;
      if (out?.status && out.status !== 404) return null;
    }
    return null;
  }

  async function tryPostNoThrow(path, body) {
    try {
      const res = await fetch(state.apiBase + path, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const txt = await res.text();
      let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  // ---- Local GS1 AI parse (best-effort)
  function parseGS1(raw) {
    const s = String(raw || '').trim();
    if (!s) return {};

    if (/\(\d{2,4}\)/.test(s)) {
      const ai = {};
      const re = /\((\d{2,4})\)/g;
      const parts = [];
      let m, lastIdx = 0, lastAI = null;

      while ((m = re.exec(s))) {
        const aiCode = m[1];
        if (lastAI !== null) parts.push([lastAI, s.slice(lastIdx, m.index)]);
        lastAI = aiCode;
        lastIdx = re.lastIndex;
      }
      if (lastAI !== null) parts.push([lastAI, s.slice(lastIdx)]);

      for (const [k, v] of parts) ai[k] = (v || '').trim();
      return normalizeAI(ai, s);
    }

    const GS = String.fromCharCode(29);
    const ai = {};
    let i = 0;

    const fixed = { '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6, '20': 2 };
    const variableMax = { '10': 20, '21': 20, '30': 8, '37': 8, '240': 30, '241': 30, '242': 6, '243': 20 };

    while (i < s.length) {
      const try4 = s.slice(i, i + 4);
      const try3 = s.slice(i, i + 3);
      const try2 = s.slice(i, i + 2);

      const code =
        (try4 in variableMax || try4 in fixed) ? try4 :
        (try3 in variableMax || try3 in fixed) ? try3 :
        try2;

      const isFixed = Object.prototype.hasOwnProperty.call(fixed, code);
      const isVar = Object.prototype.hasOwnProperty.call(variableMax, code);
      if (!isFixed && !isVar) break;

      i += code.length;

      if (isFixed) {
        ai[code] = s.slice(i, i + fixed[code]);
        i += fixed[code];
      } else {
        const max = variableMax[code];
        let end = s.indexOf(GS, i);
        if (end === -1) end = Math.min(i + max, s.length);
        ai[code] = s.slice(i, Math.min(end, i + max));
        i = end + 1;
      }
    }
    return normalizeAI(ai, s);
  }

  function normalizeAI(ai, raw) {
    const out = { ai, raw };
    if (ai['01']) out.gtin = ai['01'];
    if (ai['17']) out.expiry = ai['17'];
    if (ai['10']) out.lot = ai['10'];
    if (ai['21']) out.serial = ai['21'];
    if (ai['30'] || ai['37']) out.qty = ai['30'] || ai['37'];

    if (out.expiry && /^\d{6}$/.test(out.expiry)) {
      const yy = out.expiry.slice(0, 2);
      const mm = out.expiry.slice(2, 4);
      const dd = out.expiry.slice(4, 6);
      out.expiry_iso = `20${yy}-${mm}-${dd}`;
    }
    return out;
  }

  function localDecision(parsed) {
    const gtin = parsed.gtin || '';
    if (!gtin || gtin.length < 14) return 'WARN'; // NO-BLOCK mode

    const exp = parsed.expiry_iso || '';
    if (exp) {
      const d = new Date(exp + 'T00:00:00Z');
      if (!isNaN(d.valueOf())) {
        const days = Math.floor((d - new Date()) / (1000 * 60 * 60 * 24));
        if (days < 0) return 'WARN'; // NO-BLOCK mode
        if (days <= 30) return 'WARN';
      }
    }
    return 'PASS';
  }

  // ---- API helpers
  function resolveApiBase() {
    const qp = new URLSearchParams(location.search);
    const qApi = qp.get('api');
    const wApi = (window.__API_BASE__ || '').trim();
    if (qApi) return qApi.replace(/\/$/, '');
    if (wApi) return wApi.replace(/\/$/, '');
    return '';
  }

  async function apiGet(path) {
    const res = await fetch(state.apiBase + path, { headers: authHeaders() });
    return await handle(res);
  }
  async function apiPost(path, body) {
    const res = await fetch(state.apiBase + path, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await handle(res);
  }
  function authHeaders() {
    return state.token ? { Authorization: 'Bearer ' + state.token } : {};
  }
  async function handle(res) {
    const txt = await res.text();
    let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
    if (!res.ok) {
      const msg = data?.error ? data.error : `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- Utils
  function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function debounce(fn, ms) { let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }

  function toast(msg, kind) {
    const el = $('#toast');
    if (!el) return console.log('[toast]', kind || 'info', msg);
    el.hidden = false;
    el.className = 'toast' + (kind ? ` toast--${kind}` : '');
    el.innerHTML = `<span class="toast__dot"></span><div class="toast__msg">${escapeHtml(msg)}</div>`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), 2800);
  }

  function setAlert(sel, msg, kind) {
    const el = $(sel);
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.style.borderColor =
      kind === 'bad' ? 'rgba(255,77,109,.25)' :
      kind === 'ok'  ? 'rgba(34,197,94,.25)' :
                       'rgba(255,255,255,.10)';
    el.style.background =
      kind === 'bad' ? 'rgba(255,77,109,.08)' :
      kind === 'ok'  ? 'rgba(34,197,94,.08)' :
                       'rgba(255,255,255,.04)';
  }

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try { await navigator.serviceWorker.register('./sw.js'); } catch {}
  }

  boot();
})();
