/**
 * HyberText Demo — client-side logic
 * Vanilla ES2022, no external dependencies.
 */

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Base-relative API fetch. Handles errors, returns { ok, status, data }. */
async function api(path, options = {}) {
  try {
    const res  = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

const $ = id => document.getElementById(id);

function setOutput(id, data, state /* 'ok' | 'error' | 'loading' */ = 'ok') {
  const el = $(id);
  if (!el) return;
  el.className = `output ${state}`;
  el.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function busy(btnId, text) {
  const btn = $(btnId);
  if (!btn) return () => {};
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = text || 'Loading…';
  return () => { btn.disabled = false; btn.innerHTML = orig; };
}

/** Copy pre content to clipboard */
function copyOutput(outputId) {
  const el = $(outputId);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = el.parentElement?.querySelector('.copy-btn');
    if (btn) { const t = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = t; }, 1200); }
  });
}

// ---------------------------------------------------------------------------
// Site hash display
// ---------------------------------------------------------------------------

function initSiteHash() {
  const base = document.querySelector('base')?.href || window.location.href;
  const m    = base.match(/\/(0x[a-fA-F0-9]{64})\//);
  const hash = m ? m[1] : null;

  if (hash) {
    const el = $('site-hash');
    if (el) el.textContent = hash.slice(0, 10) + '…' + hash.slice(-8);

    const hero = $('hero-hash');
    if (hero) {
      hero.textContent = hash.slice(0, 14) + '…' + hash.slice(-8);
      hero.closest('.hero-chain')?.style.setProperty('display', 'inline-flex');
    }
  }
}

// ---------------------------------------------------------------------------
// Section: Request Info
// ---------------------------------------------------------------------------

async function loadInfo() {
  const done = busy('btn-info', 'Fetching…');
  setOutput('out-info', 'Fetching…', 'loading');
  const { ok, data } = await api('api/info');
  setOutput('out-info', data, ok ? 'ok' : 'error');

  // Populate info tiles
  if (ok && typeof data === 'object') {
    const tiles = {
      'tile-method':    data.method,
      'tile-time':      data.time,
      'tile-rpc':       data.rpc,
      'tile-db':        data.db,
      'tile-kv':        data.kv,
      'tile-tableland': data.tableland,
    };
    for (const [id, val] of Object.entries(tiles)) {
      const el = $(id);
      if (el && val) {
        el.textContent = val;
        if (val === 'connected' || val === 'available') el.classList.add('text-green');
        if (val?.startsWith('not')) el.style.color = 'var(--muted)';
      }
    }
  }
  done();
}

// ---------------------------------------------------------------------------
// Section: Echo
// ---------------------------------------------------------------------------

async function sendEcho() {
  const body = $('echo-body').value.trim();
  if (!body) return;
  let payload;
  try { payload = JSON.parse(body); } catch { payload = body; }

  const done = busy('btn-echo', 'Sending…');
  setOutput('out-echo', 'Sending…', 'loading');
  const { ok, data } = await api('api/echo', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });
  setOutput('out-echo', data, ok ? 'ok' : 'error');
  done();
}

// ---------------------------------------------------------------------------
// Section: KV Counter
// ---------------------------------------------------------------------------

let counterValue = null;

async function loadCounter() {
  const { ok, data } = await api('api/kv?key=counter');
  if (ok && data !== null) {
    counterValue = parseInt(data.value ?? '0', 10) || 0;
    updateCounterDisplay();
  } else if (!ok) {
    $('counter-display').textContent = 'N/A';
    $('counter-display').style.fontSize = '16px';
    $('counter-display').style.color = 'var(--muted)';
    $('counter-display').textContent = data?.error || 'KV not configured';
  }
}

function updateCounterDisplay() {
  const el = $('counter-display');
  if (el && counterValue !== null) el.textContent = counterValue;
}

async function incrementCounter(by) {
  const done = busy(by > 0 ? 'btn-inc' : 'btn-dec');
  const { ok, data } = await api('api/kv/increment', {
    method: 'POST',
    body:   JSON.stringify({ key: 'counter', by }),
  });
  if (ok) { counterValue = data.value; updateCounterDisplay(); }
  setOutput('out-kv-counter', data, ok ? 'ok' : 'error');
  done();
}

async function resetCounter() {
  const done = busy('btn-reset');
  const { ok, data } = await api('api/kv', {
    method: 'POST',
    body:   JSON.stringify({ key: 'counter', value: '0' }),
  });
  if (ok) { counterValue = 0; updateCounterDisplay(); }
  setOutput('out-kv-counter', data, ok ? 'ok' : 'error');
  done();
}

// ── KV Store (get / set) ──────────────────────────────────────────────────

async function kvGet() {
  const key  = $('kv-key').value.trim();
  if (!key) return;
  const done = busy('btn-kv-get');
  setOutput('out-kv-store', 'Reading…', 'loading');
  const { ok, data } = await api(`api/kv?key=${encodeURIComponent(key)}`);
  setOutput('out-kv-store', data, ok ? 'ok' : 'error');
  done();
}

async function kvSet() {
  const key = $('kv-key').value.trim();
  const val = $('kv-val').value;
  const ttl = $('kv-ttl').value;
  if (!key) return;
  const done = busy('btn-kv-set');
  setOutput('out-kv-store', 'Writing…', 'loading');
  const { ok, data } = await api('api/kv', {
    method: 'POST',
    body:   JSON.stringify({ key, value: val, ttl: ttl || undefined }),
  });
  setOutput('out-kv-store', data, ok ? 'ok' : 'error');
  done();
}

async function kvDelete() {
  const key = $('kv-key').value.trim();
  if (!key) return;
  const done = busy('btn-kv-del');
  const { ok, data } = await api(`api/kv?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
  setOutput('out-kv-store', data, ok ? 'ok' : 'error');
  done();
}

// ---------------------------------------------------------------------------
// Section: HyberDB
// ---------------------------------------------------------------------------

async function dbQuery() {
  const ns  = $('db-ns').value.trim()  || 'hybertext-demo';
  const key = $('db-key').value.trim() || '';
  const done = busy('btn-db-query', 'Querying…');
  setOutput('out-db', 'Querying chain…', 'loading');
  const path = key ? `api/db?ns=${encodeURIComponent(ns)}&key=${encodeURIComponent(key)}` : `api/db?ns=${encodeURIComponent(ns)}`;
  const { ok, data } = await api(path);
  setOutput('out-db', data, ok ? 'ok' : 'error');
  done();
}

async function dbInfo() {
  const ns  = $('db-ns').value.trim() || 'hybertext-demo';
  const done = busy('btn-db-info');
  setOutput('out-db', 'Fetching namespace info…', 'loading');
  const { ok, data } = await api(`api/db/info?ns=${encodeURIComponent(ns)}`);
  setOutput('out-db', data, ok ? 'ok' : 'error');
  done();
}

// ---------------------------------------------------------------------------
// Section: Tableland
// ---------------------------------------------------------------------------

async function tablelandQuery() {
  const sql = $('sql-input').value.trim();
  if (!sql) return;
  const done = busy('btn-tableland', 'Querying…');
  setOutput('out-tableland', 'Querying Tableland…', 'loading');
  const { ok, data } = await api(`api/tableland?sql=${encodeURIComponent(sql)}`);
  setOutput('out-tableland', data, ok ? 'ok' : 'error');
  done();
}

// ---------------------------------------------------------------------------
// Section: Sessions
// ---------------------------------------------------------------------------

const SESSION_KEY = 'hybertext_demo_session';

let currentSession = null;

function loadSessionState() {
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) currentSession = JSON.parse(stored);
  } catch { currentSession = null; }
  renderSessionUI();
}

function saveSession(session) {
  currentSession = session;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  renderSessionUI();
}

function clearSession() {
  currentSession = null;
  localStorage.removeItem(SESSION_KEY);
  renderSessionUI();
}

function renderSessionUI() {
  const loginPanel  = $('session-login');
  const activePanel = $('session-active');
  if (!loginPanel || !activePanel) return;

  if (currentSession) {
    loginPanel.style.display  = 'none';
    activePanel.style.display = 'block';
    const nameEl = $('session-username');
    if (nameEl) nameEl.textContent = currentSession.username || 'Unknown';
    const tokenEl = $('session-token-preview');
    if (tokenEl) tokenEl.textContent = currentSession.token?.slice(0, 40) + '…';
  } else {
    loginPanel.style.display  = 'block';
    activePanel.style.display = 'none';
  }
}

async function sessionLogin() {
  const username = $('session-username-input').value.trim();
  if (!username) return;
  const done = busy('btn-session-login', 'Logging in…');
  setOutput('out-session', 'Creating session…', 'loading');
  const { ok, data } = await api('api/session/create', {
    method: 'POST',
    body:   JSON.stringify({ username }),
  });
  if (ok) {
    saveSession({ token: data.token, username: data.username });
    setOutput('out-session', data, 'ok');
  } else {
    setOutput('out-session', data, 'error');
  }
  done();
}

async function sessionVerify() {
  if (!currentSession?.token) return;
  const done = busy('btn-session-verify');
  setOutput('out-session', 'Verifying…', 'loading');
  const { ok, data } = await api('api/session/verify', {
    headers: { Authorization: `Bearer ${currentSession.token}` },
  });
  setOutput('out-session', data, ok ? 'ok' : 'error');
  done();
}

async function sessionLogout() {
  if (!currentSession?.token) { clearSession(); return; }
  const done = busy('btn-session-logout', 'Logging out…');
  setOutput('out-session', 'Destroying session…', 'loading');
  const { ok, data } = await api('api/session/destroy', {
    method: 'POST',
    body:   JSON.stringify({ token: currentSession.token }),
  });
  setOutput('out-session', data, ok ? 'ok' : 'error');
  clearSession();
  done();
}

// ---------------------------------------------------------------------------
// Section: Site Index
// ---------------------------------------------------------------------------

// Derive the gateway origin (everything before the txHash segment in the URL)
function gatewayOrigin() {
  const base = document.querySelector('base')?.href || window.location.href;
  const m = base.match(/^(https?:\/\/[^/]+)\/0x[a-fA-F0-9]{64}\//);
  return m ? m[1] : window.location.origin;
}

async function loadIndex() {
  const limit     = $('index-limit').value   || '10';
  const publisher = $('index-publisher').value.trim() || '';
  const done      = busy('btn-index', 'Loading…');
  setOutput('out-index-raw', 'Querying HyberIndex…', 'loading');

  const params = new URLSearchParams({ limit });
  if (publisher) params.set('publisher', publisher);

  const { ok, data } = await api('api/index?' + params);
  setOutput('out-index-raw', data, ok ? 'ok' : 'error');

  const tbody = $('index-tbody');
  if (tbody) {
    tbody.innerHTML = '';
    if (ok && Array.isArray(data?.entries)) {
      const origin = gatewayOrigin();
      for (const entry of data.entries) {
        const tr = document.createElement('tr');
        const ts = entry.timestamp ? new Date(entry.timestamp * 1000).toLocaleString() : '–';
        const ctLabels = { 2: 'MANIFEST', 4: 'BLOB', 5: 'INDEX', 8: 'ENCRYPTED' };
        const ct = ctLabels[entry.contentType] ?? `TYPE ${entry.contentType}`;
        // MANIFEST and ENCRYPTED sites are browseable; INDEX snapshots are not
        const isSite = entry.contentType === 2 || entry.contentType === 8;
        const siteUrl = `${origin}/${entry.txHash}/`;
        const txCell = isSite
          ? `<a class="tx-link" href="${siteUrl}" target="_blank">${entry.txHash.slice(0,10)}…</a>`
          : `<span class="mono" title="${entry.txHash}">${entry.txHash.slice(0,10)}…</span>`;
        tr.innerHTML = `
          <td>${txCell}</td>
          <td class="mono" style="font-size:11px">${entry.publisher.slice(0,10)}…</td>
          <td><span class="tag">${ct}</span></td>
          <td>${ts}</td>
          <td class="mono" style="font-size:11px">${entry.blockNumber.toLocaleString()}</td>
        `;
        tbody.appendChild(tr);
      }
      if (!data.entries.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5" style="text-align:center;color:var(--muted);padding:20px">No entries found</td>';
        tbody.appendChild(tr);
      }
    }
  }
  done();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function initTabs(containerSelector) {
  document.querySelectorAll(containerSelector + ' .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.section');
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = container.querySelector('#' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  initSiteHash();
  initTabs('.section');
  loadSessionState();

  // Auto-load info section
  loadInfo();
  loadCounter();

  // Wire buttons
  $('btn-info')?.addEventListener('click', loadInfo);

  $('btn-echo')?.addEventListener('click', sendEcho);
  $('echo-body')?.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) sendEcho(); });

  $('btn-inc')?.addEventListener('click',   () => incrementCounter(1));
  $('btn-dec')?.addEventListener('click',   () => incrementCounter(-1));
  $('btn-reset')?.addEventListener('click', resetCounter);

  $('btn-kv-get')?.addEventListener('click', kvGet);
  $('btn-kv-set')?.addEventListener('click', kvSet);
  $('btn-kv-del')?.addEventListener('click', kvDelete);

  $('btn-db-query')?.addEventListener('click', dbQuery);
  $('btn-db-info')?.addEventListener('click',  dbInfo);

  $('btn-tableland')?.addEventListener('click', tablelandQuery);
  $('sql-input')?.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) tablelandQuery(); });

  $('btn-session-login')?.addEventListener('click',  sessionLogin);
  $('btn-session-verify')?.addEventListener('click', sessionVerify);
  $('btn-session-logout')?.addEventListener('click', sessionLogout);
  $('session-username-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sessionLogin(); });

  $('btn-index')?.addEventListener('click', loadIndex);

  // Copy buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => copyOutput(btn.dataset.output));
  });
});
