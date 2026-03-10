/** Linear-style project management UI for the HyberText taskboard. */
export function linearPage(): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title id="page-title">Issues</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f0f0f;--bg-sidebar:#161616;--bg-hover:#1e1e1e;--bg-card:#1a1a1a;
  --border:#262626;--text:#e2e8f0;--muted:#71717a;--faint:#3f3f46;
  --accent:#5e6ad2;--accent-h:#6b77e0;
  --font:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
  --mono:'JetBrains Mono','Fira Code',monospace;
  --r:5px;--sw:220px;--pw:420px;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.5}
#app{display:flex;height:100vh;overflow:hidden}

/* ── Sidebar ─────────────────────────────────────────── */
#sidebar{width:var(--sw);min-width:var(--sw);background:var(--bg-sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden}
.ws-header{display:flex;align-items:center;gap:8px;padding:12px 12px 8px;cursor:pointer;border-radius:var(--r);margin:4px 6px}
.ws-header:hover{background:var(--bg-hover)}
.ws-icon{width:24px;height:24px;border-radius:6px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0}
.ws-name{font-weight:600;font-size:13px}
.sidebar-nav{padding:4px 6px}
.nav-item{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:var(--r);cursor:pointer;color:var(--muted);font-size:13px;user-select:none}
.nav-item:hover{background:var(--bg-hover);color:var(--text)}
.nav-item.active{background:var(--bg-hover);color:var(--text)}
.nav-item .icon{width:16px;height:16px;flex-shrink:0;opacity:.7}
.nav-item .count{margin-left:auto;font-size:11px;color:var(--faint)}
.sb-section{padding:14px 14px 4px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--faint);text-transform:uppercase;display:flex;align-items:center;justify-content:space-between}
.sb-section .add{cursor:pointer;opacity:.5;font-size:16px;line-height:1;padding:2px 4px;border-radius:4px}
.sb-section .add:hover{opacity:1;background:var(--bg-hover)}
.sb-item{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:var(--r);cursor:pointer;color:var(--muted);font-size:13px;margin:0 6px;user-select:none}
.sb-item:hover{background:var(--bg-hover);color:var(--text)}
.sb-item.active{background:var(--bg-hover);color:var(--text)}
.sb-item .ct{margin-left:auto;font-size:11px;color:var(--faint)}

/* ── Main ────────────────────────────────────────────── */
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.main-header{display:flex;align-items:center;gap:12px;padding:14px 20px 10px;border-bottom:1px solid var(--border);flex-shrink:0}
.main-header h2{font-size:15px;font-weight:600}
.tc{font-size:12px;color:var(--muted)}
.hactions{margin-left:auto;display:flex;gap:8px;align-items:center}
.vtoggle{display:flex;border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.vbtn{padding:5px 9px;cursor:pointer;border:none;background:none;color:var(--muted);font-size:12px;display:flex;align-items:center}
.vbtn:hover{background:var(--bg-hover);color:var(--text)}
.vbtn.active{background:var(--bg-hover);color:var(--text)}
.btn-new{background:var(--accent);color:#fff;border:none;border-radius:var(--r);padding:6px 12px;font-size:13px;cursor:pointer;font-weight:500}
.btn-new:hover{background:var(--accent-h)}

/* ── Filter bar ──────────────────────────────────────── */
#filter-bar{display:flex;align-items:center;gap:6px;padding:8px 20px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.fpill{display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border);border-radius:100px;font-size:12px;color:var(--muted);cursor:pointer;background:none;user-select:none;white-space:nowrap}
.fpill:hover{border-color:#444;color:var(--text)}
.fpill.active{border-color:var(--accent);color:var(--accent)}
.fpill .rm{margin-left:4px;opacity:.6}
.fpill .rm:hover{opacity:1}

/* ── Content ─────────────────────────────────────────── */
#content{flex:1;overflow-y:auto}
.group-header{display:flex;align-items:center;gap:8px;padding:12px 20px 4px;font-size:12px;font-weight:600;color:var(--muted);user-select:none;cursor:pointer}
.group-header .gc{font-weight:400;color:var(--faint)}
.group-header .chev{transition:transform .15s;margin-left:auto}
.group-header.collapsed .chev{transform:rotate(-90deg)}
.task-row{display:flex;align-items:center;gap:8px;padding:0 20px;height:36px;cursor:pointer;border-bottom:1px solid transparent;transition:background .05s}
.task-row:hover{background:var(--bg-hover)}
.task-row.sel{background:#1f2037}
.picon{width:16px;height:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.sicon{width:16px;height:16px;flex-shrink:0}
.tid{font-family:var(--mono);font-size:11px;color:var(--faint);flex-shrink:0;width:42px}
.ttitle{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.ttitle.done{text-decoration:line-through;color:var(--muted)}
.tlabels{display:flex;gap:4px;flex-shrink:0}
.lbadge{padding:1px 7px;border-radius:100px;font-size:11px;background:var(--bg-card);border:1px solid var(--border);color:var(--muted)}
.tassignee{font-size:12px;color:var(--muted);flex-shrink:0;max-width:80px;overflow:hidden;text-overflow:ellipsis}
.tdue{font-size:11px;color:var(--faint);flex-shrink:0}
.tdue.od{color:#ef4444}

/* ── Board ───────────────────────────────────────────── */
#board{display:flex;gap:12px;padding:16px 20px;overflow-x:auto;min-height:0}
.bcol{flex:0 0 260px;display:flex;flex-direction:column;gap:8px}
.bcol-header{display:flex;align-items:center;gap:6px;padding:6px 4px;font-size:12px;font-weight:600;color:var(--muted)}
.bcol-header .cc{color:var(--faint);font-weight:400}
.bcards{display:flex;flex-direction:column;gap:6px;overflow-y:auto}
.bcard{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;cursor:pointer;transition:border-color .1s}
.bcard:hover{border-color:#444}
.card-title{font-size:13px;line-height:1.4;margin-bottom:8px}
.card-footer{display:flex;align-items:center;gap:6px}
.card-id{font-family:var(--mono);font-size:10px;color:var(--faint);margin-left:auto}

/* ── Detail panel ────────────────────────────────────── */
#detail{width:var(--pw);min-width:var(--pw);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;transform:translateX(100%);transition:transform .2s ease}
#detail.open{transform:translateX(0)}
.dhead{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--border);flex-shrink:0}
.dclose{cursor:pointer;color:var(--muted);padding:4px;border-radius:4px;display:flex;background:none;border:none}
.dclose:hover{background:var(--bg-hover);color:var(--text)}
.dbody{flex:1;overflow-y:auto;padding:16px}
.dtitle{font-size:16px;font-weight:600;margin-bottom:16px;cursor:text;border-radius:4px;padding:4px;border:1px solid transparent;word-break:break-word}
.dtitle:hover{border-color:var(--border)}
.dtitle[contenteditable=true]{border-color:var(--accent);outline:none}
.dmeta{display:flex;flex-direction:column;gap:2px;margin-bottom:20px}
.mrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px}
.mrow:hover{background:var(--bg-hover)}
.mlabel{font-size:12px;color:var(--muted);width:88px;flex-shrink:0}
.mval{font-size:13px;display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.msel{background:none;border:none;color:var(--text);font-size:13px;cursor:pointer;padding:0;font-family:var(--font);flex:1}
.msel:focus{outline:none}
.minput{background:none;border:none;color:var(--text);font-size:13px;font-family:var(--font);width:100%;cursor:text}
.minput:focus{outline:none}
.dsec{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);margin:16px 0 8px;padding:0 4px}
.ddesc{font-size:13px;color:var(--muted);line-height:1.6;min-height:60px;cursor:text;border-radius:4px;padding:8px;border:1px solid transparent;white-space:pre-wrap;word-break:break-word}
.ddesc:hover{border-color:var(--border)}
.ddesc[contenteditable=true]{border-color:var(--accent);outline:none;color:var(--text)}
.ddesc:empty::before{content:'Add description…';color:var(--faint)}
.comments{display:flex;flex-direction:column;gap:12px}
.comment{display:flex;gap:8px}
.cavatar{width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;flex-shrink:0;margin-top:2px}
.cbody{flex:1}
.cauthor{font-size:12px;font-weight:600;margin-bottom:2px}
.ctext{font-size:13px;color:var(--muted);line-height:1.5}
.ctime{font-size:11px;color:var(--faint)}
.addcomment{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.cinput{width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--r);padding:8px 10px;color:var(--text);font-family:var(--font);font-size:13px;resize:none;min-height:60px;transition:border-color .15s}
.cinput:focus{outline:none;border-color:var(--accent)}
.cinput::placeholder{color:var(--faint)}
.bsm{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--r);padding:6px 12px;font-size:12px;color:var(--muted);cursor:pointer}
.bsm:hover{border-color:#444;color:var(--text)}
.bpsm{background:var(--accent);border:none;border-radius:var(--r);padding:6px 12px;font-size:12px;color:#fff;cursor:pointer;align-self:flex-end}
.bpsm:hover{background:var(--accent-h)}

/* ── Modal ───────────────────────────────────────────── */
#overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:flex;align-items:center;justify-content:center}
#overlay.h{display:none}
#modal{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:24px;width:540px;max-width:90vw;max-height:90vh;overflow-y:auto}
.mtitle{font-size:15px;font-weight:600;margin-bottom:20px}
.fg{margin-bottom:14px}
.fl{font-size:12px;color:var(--muted);margin-bottom:6px;display:block}
.fi{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:8px 10px;color:var(--text);font-family:var(--font);font-size:13px;transition:border-color .15s}
.fi:focus{outline:none;border-color:var(--accent)}
.fi::placeholder{color:var(--faint)}
.frow{display:flex;gap:12px}
.frow .fg{flex:1}
.mactions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
textarea.fi{resize:vertical;min-height:80px}
option{background:#1a1a1a}

/* ── Status colors ───────────────────────────────────── */
.s-todo{color:#6b7280}.s-inp{color:#3b82f6}.s-rev{color:#8b5cf6}.s-done{color:#10b981}.s-can{color:#374151}
.p-urg{color:#ef4444}.p-hi{color:#f97316}.p-med{color:#f59e0b}.p-lo{color:#6b7280}

/* ── Misc ────────────────────────────────────────────── */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;color:var(--faint);gap:8px}
.empty h3{font-size:14px;font-weight:500}.empty p{font-size:12px}
.loading{display:flex;align-items:center;justify-content:center;height:200px;color:var(--faint);font-size:13px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#333;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#555}
</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div class="ws-header">
      <div class="ws-icon" id="ws-icon">?</div>
      <div class="ws-name" id="ws-name">Loading…</div>
    </div>
    <div class="sidebar-nav">
      <div class="nav-item active" data-nav="all">
        <svg class="icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>
        All Issues<span class="count" id="nav-ct"></span>
      </div>
    </div>
    <div class="sb-section">Projects<span class="add" id="add-proj" title="New project">+</span></div>
    <div id="sb-projs"></div>
    <div class="sb-section">Milestones<span class="add" id="add-ms" title="New milestone">+</span></div>
    <div id="sb-ms"></div>
  </aside>

  <main id="main">
    <div class="main-header">
      <h2 id="view-title">Issues</h2>
      <span class="tc" id="tc"></span>
      <div class="hactions">
        <div class="vtoggle">
          <button class="vbtn active" id="vlist" title="List"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="2" rx="1" fill="currentColor"/><rect x="1" y="6" width="12" height="2" rx="1" fill="currentColor"/><rect x="1" y="10" width="12" height="2" rx="1" fill="currentColor"/></svg></button>
          <button class="vbtn" id="vboard" title="Board"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="3" height="12" rx="1" fill="currentColor"/><rect x="5.5" y="1" width="3" height="12" rx="1" fill="currentColor"/><rect x="10" y="1" width="3" height="12" rx="1" fill="currentColor"/></svg></button>
        </div>
        <button class="btn-new" id="btn-new">New Issue</button>
      </div>
    </div>

    <div id="filter-bar">
      <div class="fpill" id="fp-status"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.2"/></svg>Status</div>
      <div class="fpill" id="fp-priority"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="1" y="5" width="2" height="4" rx=".5" fill="currentColor"/><rect x="4" y="3" width="2" height="6" rx=".5" fill="currentColor"/><rect x="7" y="1" width="2" height="8" rx=".5" fill="currentColor"/></svg>Priority</div>
      <div class="fpill" id="fp-ms"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 5h4l2-2 2 2" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>Milestone</div>
    </div>

    <div id="content"><div class="loading" id="loader">Loading…</div></div>
  </main>

  <aside id="detail">
    <div class="dhead">
      <button class="dclose" id="dclose"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      <span id="did" style="font-family:var(--mono);font-size:12px;color:var(--faint)"></span>
    </div>
    <div class="dbody" id="dbody"></div>
  </aside>
</div>

<div id="overlay" class="h">
  <div id="modal">
    <div class="mtitle" id="modal-title">New Issue</div>
    <div class="fg"><label class="fl">Title *</label><input class="fi" id="f-title" placeholder="Issue title" autocomplete="off"></div>
    <div class="frow">
      <div class="fg"><label class="fl">Project *</label><select class="fi" id="f-proj"><option value="">Select project</option></select></div>
      <div class="fg"><label class="fl">Priority</label><select class="fi" id="f-pri"><option value="medium">Medium</option><option value="urgent">Urgent</option><option value="high">High</option><option value="low">Low</option></select></div>
    </div>
    <div class="frow">
      <div class="fg"><label class="fl">Milestone</label><select class="fi" id="f-ms"><option value="">No milestone</option></select></div>
      <div class="fg"><label class="fl">Due date</label><input class="fi" id="f-due" type="date"></div>
    </div>
    <div class="fg"><label class="fl">Assignee</label><input class="fi" id="f-assignee" placeholder="Address or name"></div>
    <div class="fg"><label class="fl">Labels (comma-separated)</label><input class="fi" id="f-labels" placeholder="bug, frontend, v2"></div>
    <div class="fg"><label class="fl">Description</label><textarea class="fi" id="f-desc" placeholder="Add description…"></textarea></div>
    <div class="mactions">
      <button class="bsm" id="mcancel">Cancel</button>
      <button class="bpsm" id="msave">Create Issue</button>
    </div>
  </div>
</div>

<script>
const WS = new URLSearchParams(location.search).get('workspace') || 'demo-team';
const S = { tasks:[], projects:[], milestones:[], filter:{project:null,status:null,priority:null,milestone:null}, view:'list', selId:null };

// ── API ─────────────────────────────────────────────────────────────
const A = {
  get: p => fetch('/api/taskboard/'+WS+p).then(r=>r.json()),
  post: (p,b) => fetch('/api/taskboard/'+WS+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()),
  patch: (p,b) => fetch('/api/taskboard/'+WS+p,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()),
};

// ── Icons ────────────────────────────────────────────────────────────
const PICON = {
  urgent: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="p-urg"><rect x="1" y="1" width="3" height="12" rx="1" fill="currentColor"/><rect x="5.5" y="1" width="3" height="12" rx="1" fill="currentColor"/><rect x="10" y="1" width="2" height="12" rx="1" fill="currentColor" opacity=".3"/></svg>',
  high:   '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="p-hi"><rect x="1" y="5" width="3.5" height="8" rx=".8" fill="currentColor"/><rect x="5.5" y="2" width="3.5" height="11" rx=".8" fill="currentColor"/><rect x="10" y="8" width="2" height="5" rx=".8" fill="currentColor" opacity=".4"/></svg>',
  medium: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="p-med"><rect x="1" y="7" width="3.5" height="6" rx=".8" fill="currentColor"/><rect x="5.5" y="4" width="3.5" height="9" rx=".8" fill="currentColor"/><rect x="10" y="7" width="2" height="6" rx=".8" fill="currentColor" opacity=".4"/></svg>',
  low:    '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="p-lo"><rect x="1" y="9" width="3.5" height="4" rx=".8" fill="currentColor"/><rect x="5.5" y="7" width="3.5" height="6" rx=".8" fill="currentColor" opacity=".5"/><rect x="10" y="9" width="2" height="4" rx=".8" fill="currentColor" opacity=".3"/></svg>',
  none:   '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="#4b5563" stroke-width="1.2" stroke-dasharray="2 2"/></svg>',
};
const SICON = {
  'todo':        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="s-todo"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/></svg>',
  'in-progress': '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="s-inp"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 8V2.1a5.9 5.9 0 0 1 0 11.8V8z" fill="currentColor"/></svg>',
  'in-review':   '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="s-rev"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5" fill="currentColor" opacity=".6"/></svg>',
  'done':        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="s-done"><circle cx="8" cy="8" r="7" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  'cancelled':   '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="s-can"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const SLABEL = {todo:'Todo','in-progress':'In Progress','in-review':'In Review',done:'Done',cancelled:'Cancelled'};
const PLABEL = {urgent:'Urgent',high:'High',medium:'Medium',low:'Low',none:'No priority'};

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmtDue(ts){
  if(!ts)return'';
  const d=new Date(ts*1000),now=new Date();
  const diff=Math.floor((d-now)/86400000);
  const label=diff<0?d.toLocaleDateString('en-US',{month:'short',day:'numeric'}):diff===0?'Today':diff===1?'Tomorrow':d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  return '<span class="tdue'+(diff<0?' od':'')+'">'+label+'</span>';
}

// ── Load ────────────────────────────────────────────────────────────
async function load(){
  document.getElementById('loader').style.display='flex';
  try{
    const [t,p,m]=await Promise.all([A.get('/tasks?limit=500'),A.get('/projects'),A.get('/milestones')]);
    S.tasks=t.tasks||[]; S.projects=p.projects||[]; S.milestones=m.milestones||[];
  }catch(e){console.error(e)}
  document.getElementById('loader').style.display='none';
  render();
}

// ── Filter ──────────────────────────────────────────────────────────
function filtered(){
  return S.tasks.filter(t=>{
    if(S.filter.project && t.project!==S.filter.project)return false;
    if(S.filter.status && t.status!==S.filter.status)return false;
    if(S.filter.priority && t.priority!==S.filter.priority)return false;
    if(S.filter.milestone && t.milestoneId!==S.filter.milestone)return false;
    return true;
  });
}

// ── Render ──────────────────────────────────────────────────────────
function render(){renderSidebar();renderFilterBar();S.view==='board'?renderBoard():renderList()}

function renderSidebar(){
  document.getElementById('ws-name').textContent=WS;
  document.getElementById('ws-icon').textContent=(WS[0]||'?').toUpperCase();
  document.getElementById('nav-ct').textContent=S.tasks.length||'';
  var SVG12='<svg width="12" height="12" viewBox="0 0 12 12" fill="none">';
  document.getElementById('sb-projs').innerHTML=S.projects.map(function(p){return '<div class="sb-item'+(S.filter.project===p.id?' active':'')+'" data-pid="'+esc(p.id)+'">'+SVG12+'<rect x=".5" y=".5" width="11" height="11" rx="2.5" stroke="currentColor"/></svg>'+esc(p.name)+'<span class="ct">'+S.tasks.filter(function(t){return t.project===p.id}).length+'</span></div>';}).join('');
  document.getElementById('sb-ms').innerHTML=S.milestones.map(function(m){return '<div class="sb-item'+(S.filter.milestone===m.id?' active':'')+'" data-mid="'+esc(m.id)+'">'+SVG12+'<path d="M2 6h4l2.5-2.5L11 6" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>'+esc(m.title)+'<span class="ct">'+S.tasks.filter(function(t){return t.milestoneId===m.id}).length+'</span></div>';}).join('');
  document.querySelectorAll('#sb-projs .sb-item').forEach(el=>el.addEventListener('click',()=>{S.filter.project=S.filter.project===el.dataset.pid?null:el.dataset.pid;render()}));
  document.querySelectorAll('#sb-ms .sb-item').forEach(el=>el.addEventListener('click',()=>{S.filter.milestone=S.filter.milestone===el.dataset.mid?null:el.dataset.mid;render()}));
}

function renderFilterBar(){
  const s=S.filter.status,p=S.filter.priority,m=S.filter.milestone;
  const fps=document.getElementById('fp-status');
  fps.className='fpill'+(s?' active':'');
  fps.innerHTML=s?((SICON[s]||'')+' '+SLABEL[s]+' <span class="rm" data-f="status">\xd7</span>'):'<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.2"/></svg>Status';
  var fpp=document.getElementById('fp-priority');
  fpp.className='fpill'+(p?' active':'');
  fpp.innerHTML=p?((PICON[p]||'')+' '+PLABEL[p]+' <span class="rm" data-f="priority">\xd7</span>'):'<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="1" y="5" width="2" height="4" rx=".5" fill="currentColor"/><rect x="4" y="3" width="2" height="6" rx=".5" fill="currentColor"/><rect x="7" y="1" width="2" height="8" rx=".5" fill="currentColor"/></svg>Priority';
  var fpm=document.getElementById('fp-ms');
  fpm.className='fpill'+(m?' active':'');
  var msName=m?((S.milestones.find(function(x){return x.id===m})||{}).title||m):null;
  fpm.innerHTML=m?(esc(msName)+' <span class="rm" data-f="milestone">\xd7</span>'):'<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 5h4l2-2 2 2" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>Milestone';
}

function renderList(){
  const tasks=filtered();
  document.getElementById('view-title').textContent=S.filter.project?(S.projects.find(p=>p.id===S.filter.project)?.name||'Issues'):'Issues';
  document.getElementById('tc').textContent=tasks.length?tasks.length+' issue'+(tasks.length!==1?'s':''):'';
  const c=document.getElementById('content');
  if(!tasks.length){c.innerHTML='<div class="empty"><h3>No issues</h3><p>Create your first issue to get started</p></div>';return}
  const GROUPS=[{k:'in-progress',l:'In Progress'},{k:'in-review',l:'In Review'},{k:'todo',l:'Todo'},{k:'done',l:'Done'},{k:'cancelled',l:'Cancelled'}]
    .map(g=>({...g,t:tasks.filter(t=>t.status===g.k)})).filter(g=>g.t.length>0);
  c.innerHTML=GROUPS.map(function(g){return '<div class="group"><div class="group-header" data-g="'+g.k+'">'+(SICON[g.k]||'')+' '+g.l+' <span class="gc">'+g.t.length+'</span><svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 5l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></div><div class="gtasks">'+g.t.map(tRow).join('')+'</div></div>';}).join('');
  c.querySelectorAll('.group-header').forEach(el=>el.addEventListener('click',()=>{el.classList.toggle('collapsed');el.nextElementSibling.style.display=el.classList.contains('collapsed')?'none':''}));
  c.querySelectorAll('.task-row').forEach(el=>{
    el.addEventListener('click',()=>openDetail(el.dataset.id));
    if(S.selId===el.dataset.id)el.classList.add('sel');
  });
}

function tRow(t){
  var labels=(t.labels||[]).slice(0,3).map(function(l){return '<span class="lbadge">'+esc(l)+'</span>';}).join('');
  var assignee=t.assignee?esc(t.assignee.slice(0,8)+'\u2026'):'';
  return '<div class="task-row" data-id="'+t.id+'"><div class="picon">'+(PICON[t.priority]||PICON.none)+'</div><div class="sicon">'+(SICON[t.status]||SICON.todo)+'</div><span class="tid">'+t.id+'</span><span class="ttitle'+(t.status==='done'||t.status==='cancelled'?' done':'')+'">'+esc(t.title)+'</span><div class="tlabels">'+labels+'</div><span class="tassignee">'+assignee+'</span>'+(t.dueDate?fmtDue(t.dueDate):'')+'</div>';
}

function renderBoard(){
  document.getElementById('view-title').textContent='Board';
  document.getElementById('tc').textContent='';
  const tasks=filtered();
  const COLS=[{k:'todo',l:'Todo'},{k:'in-progress',l:'In Progress'},{k:'in-review',l:'In Review'},{k:'done',l:'Done'}];
  const c=document.getElementById('content');
  c.innerHTML='<div id="board">'+COLS.map(col=>{
    const ct=tasks.filter(t=>t.status===col.k);
    return '<div class="bcol"><div class="bcol-header">'+(SICON[col.k]||'')+' '+col.l+' <span class="cc">'+ct.length+'</span></div><div class="bcards">'+ct.map(bCard).join('')+'</div></div>';
  }).join('')+'</div>';
  c.querySelectorAll('.bcard').forEach(el=>el.addEventListener('click',()=>openDetail(el.dataset.id)));
}

function bCard(t){
  var labels=(t.labels||[]).slice(0,2).map(function(l){return '<span class="lbadge">'+esc(l)+'</span>';}).join('');
  return '<div class="bcard" data-id="'+t.id+'"><div class="card-title">'+esc(t.title)+'</div><div class="card-footer">'+(PICON[t.priority]||PICON.none)+labels+'<span class="card-id">'+t.id+'</span></div></div>';
}

// ── Detail panel ─────────────────────────────────────────────────────
async function openDetail(id){
  const task=S.tasks.find(t=>t.id===id);
  if(!task)return;
  S.selId=id;
  document.getElementById('did').textContent=id;
  document.getElementById('detail').classList.add('open');
  document.querySelectorAll('.task-row').forEach(el=>el.classList.toggle('sel',el.dataset.id===id));
  const res=await A.get('/tasks/'+id);
  const t=res.task||task, comments=res.comments||[];
  var mOpts=S.milestones.map(function(m){return '<option value="'+esc(m.id)+'"'+(t.milestoneId===m.id?' selected':'')+'>'+esc(m.title)+'</option>';}).join('');
  var sel=function(id,val,opts){return '<select class="msel" id="'+id+'">'+opts.map(function(o){return '<option value="'+o.v+'"'+(val===o.v?' selected':'')+'>'+o.l+'</option>';}).join('')+'</select>';};
  var sOpts=[{v:'todo',l:'Todo'},{v:'in-progress',l:'In Progress'},{v:'in-review',l:'In Review'},{v:'done',l:'Done'},{v:'cancelled',l:'Cancelled'}];
  var pOpts=[{v:'urgent',l:'Urgent'},{v:'high',l:'High'},{v:'medium',l:'Medium'},{v:'low',l:'Low'}];
  var commentsHtml=comments.map(function(c){return '<div class="comment"><div class="cavatar">'+((c.author||'A').slice(0,2).toUpperCase())+'</div><div class="cbody"><div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span class="cauthor">'+esc(c.author||'Anonymous')+'</span><span class="ctime">'+new Date(c.createdAt*1000).toLocaleDateString()+'</span></div><div class="ctext">'+esc(c.body)+'</div></div></div>';}).join('');
  document.getElementById('dbody').innerHTML=
    '<div class="dtitle" id="dt" contenteditable="false">'+esc(t.title)+'</div>'+
    '<div class="dmeta">'+
      '<div class="mrow"><span class="mlabel">Status</span><span class="mval">'+(SICON[t.status]||'')+sel('d-s',t.status,sOpts)+'</span></div>'+
      '<div class="mrow"><span class="mlabel">Priority</span><span class="mval">'+(PICON[t.priority]||PICON.none)+sel('d-p',t.priority,pOpts)+'</span></div>'+
      '<div class="mrow"><span class="mlabel">Milestone</span><span class="mval"><select class="msel" id="d-m"><option value="">No milestone</option>'+mOpts+'</select></span></div>'+
      '<div class="mrow"><span class="mlabel">Assignee</span><span class="mval"><input class="minput" id="d-a" value="'+esc(t.assignee||'')+'" placeholder="Unassigned"></span></div>'+
      '<div class="mrow"><span class="mlabel">Due date</span><span class="mval"><input type="date" class="minput" id="d-d" value="'+(t.dueDate?new Date(t.dueDate*1000).toISOString().slice(0,10):'')+'">'+'</span></div>'+
      '<div class="mrow"><span class="mlabel">Labels</span><span class="mval"><input class="minput" id="d-l" value="'+esc((t.labels||[]).join(', '))+'" placeholder="Add labels\u2026"></span></div>'+
    '</div>'+
    '<div class="dsec">Description</div>'+
    '<div class="ddesc" id="d-desc" contenteditable="false">'+(t.description?esc(t.description):'')+' </div>'+
    '<div class="dsec" style="margin-top:20px">Comments</div>'+
    '<div class="comments">'+commentsHtml+'</div>'+
    '<div class="addcomment"><textarea class="cinput" id="cinput" placeholder="Add a comment\u2026"></textarea><button class="bpsm" id="csub">Comment</button></div>';

  // Inline title editing
  const dt=document.getElementById('dt');
  dt.addEventListener('click',()=>{dt.contentEditable='true';dt.focus();const sel=window.getSelection(),r=document.createRange();r.selectNodeContents(dt);sel.removeAllRanges();sel.addRange(r)});
  dt.addEventListener('blur',async()=>{dt.contentEditable='false';const v=dt.textContent.trim();if(v&&v!==t.title)await patch(id,{title:v})});
  dt.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();dt.blur()}});
  // Desc editing
  const dd=document.getElementById('d-desc');
  dd.addEventListener('click',()=>{dd.contentEditable='true';dd.focus()});
  dd.addEventListener('blur',async()=>{dd.contentEditable='false';const v=dd.textContent.trim();if(v!==(t.description||''))await patch(id,{description:v})});
  // Meta selects
  document.getElementById('d-s').addEventListener('change',e=>patch(id,{status:e.target.value}));
  document.getElementById('d-p').addEventListener('change',e=>patch(id,{priority:e.target.value}));
  document.getElementById('d-m').addEventListener('change',e=>patch(id,{milestoneId:e.target.value||null}));
  document.getElementById('d-a').addEventListener('blur',e=>{const v=e.target.value.trim();if(v!==(t.assignee||''))patch(id,{assignee:v||null})});
  document.getElementById('d-d').addEventListener('change',e=>{const d=e.target.value?Math.floor(new Date(e.target.value).getTime()/1000):null;patch(id,{dueDate:d})});
  document.getElementById('d-l').addEventListener('blur',e=>{patch(id,{labels:e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})});
  // Comment
  document.getElementById('csub').addEventListener('click',async()=>{
    const inp=document.getElementById('cinput');
    const body=inp.value.trim();if(!body)return;
    await A.post('/tasks/'+id+'/comments',{body});inp.value='';openDetail(id);
  });
}

async function patch(id,updates){
  await A.patch('/tasks/'+id,updates);
  const idx=S.tasks.findIndex(t=>t.id===id);
  if(idx>=0)Object.assign(S.tasks[idx],updates);
  render();
}

function closeDetail(){
  S.selId=null;
  document.getElementById('detail').classList.remove('open');
  document.querySelectorAll('.task-row').forEach(el=>el.classList.remove('sel'));
}

// ── Create modal ─────────────────────────────────────────────────────
function openModal(){
  document.getElementById('f-proj').innerHTML='<option value="">Select project</option>'+S.projects.map(function(p){return '<option value="'+esc(p.id)+'"'+(S.filter.project===p.id?' selected':'')+'>'+esc(p.name)+'</option>';}).join('');
  document.getElementById('f-ms').innerHTML='<option value="">No milestone</option>'+S.milestones.map(function(m){return '<option value="'+esc(m.id)+'"'+(S.filter.milestone===m.id?' selected':'')+'>'+esc(m.title)+'</option>';}).join('');
  ['f-title','f-assignee','f-labels','f-desc','f-due'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=''});
  document.getElementById('overlay').classList.remove('h');
  document.getElementById('f-title').focus();
}
function closeModal(){document.getElementById('overlay').classList.add('h')}
async function saveModal(){
  const title=document.getElementById('f-title').value.trim();
  if(!title){document.getElementById('f-title').focus();return}
  const project=document.getElementById('f-proj').value;
  if(!project){document.getElementById('f-proj').focus();return}
  const dueStr=document.getElementById('f-due').value;
  const body={
    title,project,priority:document.getElementById('f-pri').value,
    assignee:document.getElementById('f-assignee').value.trim()||null,
    milestoneId:document.getElementById('f-ms').value||null,
    labels:document.getElementById('f-labels').value.split(',').map(s=>s.trim()).filter(Boolean),
    dueDate:dueStr?Math.floor(new Date(dueStr).getTime()/1000):null,
    description:document.getElementById('f-desc').value.trim(),
  };
  const res=await A.post('/tasks',body);
  if(res.task){S.tasks.unshift(res.task);closeModal();render();openDetail(res.task.id)}
}

// ── Dropdown filter helper ───────────────────────────────────────────
function dropdown(pill,opts,fk){
  const m=document.createElement('div');
  m.style.cssText='position:fixed;background:#1a1a1a;border:1px solid var(--border);border-radius:6px;padding:4px;z-index:200;min-width:150px;box-shadow:0 4px 24px rgba(0,0,0,.6)';
  var CHECK='<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="margin-left:auto"><path d="M2 6l3 3 5-5" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/></svg>';
  m.innerHTML=opts.map(function(o){return '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px" class="dopt" data-v="'+o.v+'">'+(o.icon||'')+esc(o.l)+(S.filter[fk]===o.v?CHECK:'')+'</div>';}).join('')
    +'<div style="border-top:1px solid var(--border);margin:4px 0"></div>'
    +'<div style="padding:6px 8px;border-radius:4px;cursor:pointer;font-size:12px;color:var(--muted)" class="dopt" data-v="">Clear</div>';
  const r=pill.getBoundingClientRect();
  m.style.left=r.left+'px';m.style.top=(r.bottom+4)+'px';
  document.body.appendChild(m);
  m.querySelectorAll('.dopt').forEach(el=>{
    el.addEventListener('mouseenter',()=>el.style.background='var(--bg-hover)');
    el.addEventListener('mouseleave',()=>el.style.background='');
    el.addEventListener('click',()=>{S.filter[fk]=el.dataset.v||null;m.remove();render()});
  });
  setTimeout(()=>document.addEventListener('click',function h(e){if(!m.contains(e.target)){m.remove();document.removeEventListener('click',h)}},0));
}

// ── Events ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('page-title').textContent=WS+' — Issues';
  document.getElementById('ws-name').textContent=WS;
  document.getElementById('ws-icon').textContent=(WS[0]||'?').toUpperCase();

  document.getElementById('vlist').addEventListener('click',()=>{S.view='list';document.getElementById('vlist').classList.add('active');document.getElementById('vboard').classList.remove('active');render()});
  document.getElementById('vboard').addEventListener('click',()=>{S.view='board';document.getElementById('vboard').classList.add('active');document.getElementById('vlist').classList.remove('active');render()});
  document.getElementById('btn-new').addEventListener('click',openModal);
  document.getElementById('mcancel').addEventListener('click',closeModal);
  document.getElementById('msave').addEventListener('click',saveModal);
  document.getElementById('overlay').addEventListener('click',e=>{if(e.target===document.getElementById('overlay'))closeModal()});
  document.getElementById('dclose').addEventListener('click',closeDetail);

  document.getElementById('fp-status').addEventListener('click',e=>{
    if(e.target.dataset.f){S.filter.status=null;render();return}
    dropdown(e.currentTarget,Object.entries(SLABEL).map(([v,l])=>({v,l,icon:SICON[v]||''})),'status');
  });
  document.getElementById('fp-priority').addEventListener('click',e=>{
    if(e.target.dataset.f){S.filter.priority=null;render();return}
    dropdown(e.currentTarget,Object.entries(PLABEL).map(([v,l])=>({v,l,icon:PICON[v]||''})),'priority');
  });
  document.getElementById('fp-ms').addEventListener('click',e=>{
    if(e.target.dataset.f){S.filter.milestone=null;render();return}
    dropdown(e.currentTarget,S.milestones.map(m=>({v:m.id,l:m.title})),'milestone');
  });

  document.getElementById('add-ms').addEventListener('click',e=>{
    e.stopPropagation();
    const title=prompt('Milestone title:');if(!title)return;
    const ds=prompt('Due date (YYYY-MM-DD, optional):');
    A.post('/milestones',{title,dueDate:ds?Math.floor(new Date(ds).getTime()/1000):null}).then(ms=>{S.milestones.push(ms);render()});
  });

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      if(!document.getElementById('overlay').classList.contains('h'))closeModal();
      else closeDetail();
    }
    if(e.key==='c'&&!e.ctrlKey&&!e.metaKey&&document.activeElement===document.body)openModal();
  });

  load();
});
</script>
</body>
</html>`;
}
