export function landingPage(host: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HyberText — Publish Your Site On-Chain</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:     #0c0c0f;
      --card:   #13131a;
      --border: #2a2a3a;
      --purple: #a855f7;
      --pink:   #ec4899;
      --text:   #e2e2f0;
      --muted:  #6b6b8a;
      --green:  #4ade80;
      --red:    #f87171;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem 4rem;
    }

    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }
    header h1 {
      font-size: 2.2rem;
      font-weight: 700;
      background: linear-gradient(135deg, var(--purple), var(--pink));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.5rem;
    }
    header p {
      color: var(--muted);
      font-size: 1rem;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 560px;
      margin-bottom: 1.5rem;
    }

    .tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }
    .tab {
      flex: 1;
      padding: 0.6rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      font-size: 0.9rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .tab.active {
      background: linear-gradient(135deg, var(--purple), var(--pink));
      border-color: transparent;
      color: #fff;
      font-weight: 600;
    }

    .panel { display: none; }
    .panel.active { display: block; }

    .drop-zone {
      border: 2px dashed var(--border);
      border-radius: 10px;
      padding: 2.5rem 1rem;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      position: relative;
    }
    .drop-zone:hover, .drop-zone.dragover {
      border-color: var(--purple);
      background: rgba(168,85,247,0.05);
    }
    .drop-zone input[type="file"] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }
    .drop-zone .icon { font-size: 2rem; margin-bottom: 0.5rem; }
    .drop-zone p { color: var(--muted); font-size: 0.9rem; }
    .drop-zone .filename {
      margin-top: 0.75rem;
      font-size: 0.85rem;
      color: var(--purple);
      font-weight: 500;
    }

    label {
      display: block;
      font-size: 0.85rem;
      color: var(--muted);
      margin-bottom: 0.4rem;
    }
    input[type="text"] {
      width: 100%;
      padding: 0.7rem 0.9rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="text"]:focus { border-color: var(--purple); }
    input[type="text"]::placeholder { color: var(--muted); }

    .hint {
      font-size: 0.8rem;
      color: var(--muted);
      margin-top: 0.4rem;
    }

    .btn {
      width: 100%;
      margin-top: 1.5rem;
      padding: 0.8rem;
      border-radius: 8px;
      border: none;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      background: linear-gradient(135deg, var(--purple), var(--pink));
      color: #fff;
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.9; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .status {
      margin-top: 1rem;
      padding: 0.8rem 1rem;
      border-radius: 8px;
      font-size: 0.9rem;
      display: none;
    }
    .status.info    { display: block; background: rgba(168,85,247,0.12); color: var(--purple); }
    .status.error   { display: block; background: rgba(248,113,113,0.12); color: var(--red); }
    .status.success { display: block; background: rgba(74,222,128,0.1); color: var(--green); }

    .result {
      display: none;
      margin-top: 1.25rem;
    }
    .result.visible { display: block; }
    .result-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.6rem;
    }
    .result-label {
      font-size: 0.8rem;
      color: var(--muted);
      width: 80px;
      flex-shrink: 0;
    }
    .result-val {
      font-family: monospace;
      font-size: 0.82rem;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.35rem 0.6rem;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .result-val a { color: var(--purple); text-decoration: none; }
    .result-val a:hover { text-decoration: underline; }
    .copy-btn {
      background: var(--border);
      border: none;
      border-radius: 6px;
      color: var(--muted);
      padding: 0.35rem 0.6rem;
      font-size: 0.75rem;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .copy-btn:hover { background: var(--purple); color: #fff; }

    .info-card {
      max-width: 560px;
      width: 100%;
    }
    .info-card h3 {
      font-size: 0.85rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.75rem;
    }
    .info-card .row {
      display: flex;
      justify-content: space-between;
      font-size: 0.85rem;
      padding: 0.4rem 0;
      border-bottom: 1px solid var(--border);
    }
    .info-card .row:last-child { border-bottom: none; }
    .info-card .row span:first-child { color: var(--muted); }
    .info-card .row span:last-child  { color: var(--text); }
  </style>
</head>
<body>

<header>
  <h1>HyberText</h1>
  <p>Publish your website permanently on Berachain — gas on us.</p>
</header>

<div class="card">
  <div class="tabs">
    <button class="tab active" onclick="switchTab('zip')">Upload ZIP</button>
    <button class="tab"        onclick="switchTab('github')">GitHub Repo</button>
  </div>

  <!-- ZIP panel -->
  <div class="panel active" id="panel-zip">
    <div class="drop-zone" id="drop-zone">
      <input type="file" accept=".zip" id="zip-input" onchange="onFileChange(this)">
      <div class="icon">📦</div>
      <p>Drag &amp; drop a <strong>.zip</strong> file, or click to browse</p>
      <div class="filename" id="filename"></div>
    </div>
    <p class="hint" style="margin-top:0.75rem">Max 3 MB zip · 4 MB compressed · Static sites only</p>
  </div>

  <!-- GitHub panel -->
  <div class="panel" id="panel-github">
    <label for="github-url">GitHub repository URL</label>
    <input type="text" id="github-url" placeholder="github.com/owner/repo  or  owner/repo@branch">
    <p class="hint">Must be a public repo. Uses <code>dist/</code> or <code>public/</code> if present, otherwise the repo root.</p>
  </div>

  <button class="btn" id="publish-btn" onclick="publish()">Publish to Berachain</button>

  <div class="status" id="status"></div>

  <div class="result" id="result">
    <div class="result-row">
      <span class="result-label">Tx hash</span>
      <span class="result-val" id="res-hash"></span>
      <button class="copy-btn" onclick="copy('res-hash')">Copy</button>
    </div>
    <div class="result-row">
      <span class="result-label">View site</span>
      <span class="result-val" id="res-url"></span>
      <button class="copy-btn" onclick="copy('res-url')">Copy</button>
    </div>
  </div>
</div>

<div class="card info-card">
  <h3>How it works</h3>
  <div class="row"><span>Storage</span><span>Berachain calldata</span></div>
  <div class="row"><span>Address</span><span>Transaction hash</span></div>
  <div class="row"><span>Gas cost</span><span>Covered — free for you</span></div>
  <div class="row"><span>Permanence</span><span>Forever, immutable</span></div>
  <div class="row"><span>MCP endpoint</span><span><a href="/mcp" style="color:var(--purple)">https://${host}/mcp</a></span></div>
</div>

<script>
  let activeTab = 'zip';
  let selectedFile = null;

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab').forEach((t, i) =>
      t.classList.toggle('active', (i === 0) === (tab === 'zip')));
    document.getElementById('panel-zip').classList.toggle('active', tab === 'zip');
    document.getElementById('panel-github').classList.toggle('active', tab === 'github');
    clearStatus();
  }

  function onFileChange(input) {
    selectedFile = input.files[0] ?? null;
    document.getElementById('filename').textContent = selectedFile ? selectedFile.name : '';
  }

  const dz = document.getElementById('drop-zone');
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f?.name.endsWith('.zip')) {
      selectedFile = f;
      document.getElementById('filename').textContent = f.name;
    }
  });

  function setStatus(type, msg) {
    const el = document.getElementById('status');
    el.className = 'status ' + type;
    el.textContent = msg;
  }
  function clearStatus() {
    document.getElementById('status').className = 'status';
    document.getElementById('result').classList.remove('visible');
  }

  async function publish() {
    clearStatus();
    const btn = document.getElementById('publish-btn');
    btn.disabled = true;

    try {
      let res;
      if (activeTab === 'zip') {
        if (!selectedFile) { setStatus('error', 'Select a .zip file first'); btn.disabled = false; return; }
        setStatus('info', 'Uploading and publishing…');
        const form = new FormData();
        form.append('file', selectedFile);
        res = await fetch('/publish', { method: 'POST', body: form });
      } else {
        const url = document.getElementById('github-url').value.trim();
        if (!url) { setStatus('error', 'Enter a GitHub repo URL'); btn.disabled = false; return; }
        setStatus('info', 'Fetching repo and publishing…');
        res = await fetch('/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ github: url }),
        });
      }

      let data;
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = { error: \`Server error (\${res.status})\` }; }
      if (!res.ok) { setStatus('error', data.error ?? 'Publish failed'); btn.disabled = false; return; }

      setStatus('success', \`Published \${data.files} file\${data.files === 1 ? '' : 's'} successfully!\`);
      document.getElementById('res-hash').textContent = data.txHash;
      document.getElementById('res-url').innerHTML = \`<a href="\${data.gatewayUrl}" target="_blank">\${data.gatewayUrl}</a>\`;
      document.getElementById('result').classList.add('visible');
    } catch (e) {
      setStatus('error', e.message ?? 'Network error');
    }

    btn.disabled = false;
  }

  function copy(id) {
    const el = document.getElementById(id);
    const text = el.querySelector('a') ? el.querySelector('a').href : el.textContent;
    navigator.clipboard.writeText(text);
    const btn = el.nextElementSibling;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  }
</script>
</body>
</html>`;
}
