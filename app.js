// ── STATE ──────────────────────────────────────────────────────────────
const NODE_COLORS=['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#6366f1','#a855f7'];

const S = {
  nodes: {},      // id → {id,name,x,y,baseValue,modifier,color}
  edges: {},      // id → {id,childId,parentId,variable}
  formulas: {},   // nodeId → expression string
  computed: {},   // nodeId → {baseValue,modifiedValue,initiativeValue,hasOverride,error}
  initiatives: {},     // id → {id,name,overrides:{nodeId→modifier}}
  activeInitiativeId: null,
  sel: null,      // {type:'node'|'edge', id}
  connMode: false,
  connSrc: null,
  selMode: false,
  multiSel: new Set(),
  rectDraw: null,
  T: {x:0, y:0, s:1},
  nextId: 1,
  drag: null,
  pan: null,
  history: [],
  historyIdx: -1,
  _histTimer: null,
  fileHandle: null,
  savedSnapshot: null,
};
function gid(){ return 'n'+(S.nextId++) }

// ── DAG UTILS ─────────────────────────────────────────────────────────
function childEdges(pid){ return Object.values(S.edges).filter(e=>e.parentId===pid).sort((a,b)=>a.variable<b.variable?-1:1) }
function isLeaf(id){ return childEdges(id).length===0 }

function hasCycle(childId, parentId){
  const vis=new Set(), q=[childId];
  while(q.length){
    const n=q.pop();
    if(n===parentId) return true;
    if(vis.has(n)) continue;
    vis.add(n);
    for(const e of Object.values(S.edges)) if(e.childId===n) q.push(e.parentId);
  }
  return false;
}

function topoSort(){
  const ids=Object.keys(S.nodes);
  const deg={};
  for(const id of ids) deg[id]=0;
  const adj={};
  for(const e of Object.values(S.edges)){
    deg[e.parentId]=(deg[e.parentId]||0)+1;
    if(!adj[e.childId]) adj[e.childId]=[];
    adj[e.childId].push(e.parentId);
  }
  const q=ids.filter(id=>deg[id]===0), out=[];
  while(q.length){
    const n=q.shift(); out.push(n);
    for(const p of (adj[n]||[])){
      if(--deg[p]===0) q.push(p);
    }
  }
  return out;
}

// ── FORMULA EVAL ──────────────────────────────────────────────────────
function evalFormula(expr, vars){
  if(!/^[\sA-Za-z0-9+\-*/().,%_]+$/.test(expr)) throw new Error('Invalid characters');
  const keys=Object.keys(vars), vals=keys.map(k=>vars[k]);
  const fn=new Function('Math',...keys,`"use strict";return(${expr});`);
  const r=fn(Math,...vals);
  if(typeof r!=='number'||!isFinite(r)) throw new Error('Result is not a finite number');
  return r;
}

function fmt(v){
  if(v===null||v===undefined||isNaN(v)) return '—';
  const rounded=parseFloat(v.toFixed(3));
  return rounded.toLocaleString('ru-RU',{maximumFractionDigits:3});
}

function fmtPct(v){
  if(v===null||v===undefined||isNaN(v)) return '—';
  const rounded=parseFloat((v*100).toFixed(3));
  return rounded.toLocaleString('ru-RU',{maximumFractionDigits:3})+'%';
}

// ── HISTORY (UNDO/REDO) ───────────────────────────────────────────────
function snapshotState(){
  return JSON.stringify({nodes:S.nodes,edges:S.edges,formulas:S.formulas,initiatives:S.initiatives,nextId:S.nextId});
}

function pushHistory(){
  clearTimeout(S._histTimer); S._histTimer=null;
  S.history.splice(S.historyIdx+1);
  S.history.push(snapshotState());
  while(S.history.length>40) S.history.shift();
  S.historyIdx=S.history.length-1;
  updateUndoRedo();
}

function scheduleHistory(){
  clearTimeout(S._histTimer);
  S._histTimer=setTimeout(()=>{ S._histTimer=null; pushHistory(); },800);
}

function restoreState(snap){
  const d=JSON.parse(snap);
  S.nodes=d.nodes; S.edges=d.edges; S.formulas=d.formulas; S.nextId=d.nextId;
  S.initiatives=d.initiatives||{};
  if(S.activeInitiativeId&&!S.initiatives[S.activeInitiativeId]) S.activeInitiativeId=null;
  S.sel=null; S.connSrc=null;
  updateInitBanner(); render();
}

function undo(){
  if(S.historyIdx<=0) return;
  S.historyIdx--;
  restoreState(S.history[S.historyIdx]);
  updateUndoRedo();
}

function redo(){
  if(S.historyIdx>=S.history.length-1) return;
  S.historyIdx++;
  restoreState(S.history[S.historyIdx]);
  updateUndoRedo();
}

function updateUndoRedo(){
  document.getElementById('bUndo').disabled=S.historyIdx<=0;
  document.getElementById('bRedo').disabled=S.historyIdx>=S.history.length-1;
}

function initHistory(){
  clearTimeout(S._histTimer); S._histTimer=null;
  S.history=[snapshotState()]; S.historyIdx=0;
  updateUndoRedo();
}

// ── SAVE ─────────────────────────────────────────────────────────────
function buildSaveData(){
  return {
    nodes:Object.values(S.nodes).map(n=>({id:n.id,name:n.name,x:n.x,y:n.y,baseValue:n.baseValue,modifier:n.modifier||0,baseValueIsPercent:n.baseValueIsPercent||false,color:n.color||null})),
    edges:Object.values(S.edges).map(e=>({id:e.id,childId:e.childId,parentId:e.parentId,variable:e.variable})),
    formulas:Object.entries(S.formulas).map(([nodeId,expression])=>({nodeId,expression})),
    initiatives:Object.values(S.initiatives),
    _meta:{nextId:S.nextId},
  };
}

function setSaveStatus(text,cls){
  const el=document.getElementById('saveStatus');
  if(!el) return;
  el.textContent=text; el.className='save-status'+(cls?' '+cls:'');
}

function updateFileName(){
  const el=document.getElementById('fileName');
  if(!el) return;
  el.textContent=S.fileHandle?S.fileHandle.name:'';
}

function updateSaveStatus(){
  const cur=snapshotState();
  const saved=S.savedSnapshot&&cur===S.savedSnapshot;
  setSaveStatus(saved?'No unsaved changes':'Unsaved changes', saved?'ok':'warn');
}

async function writeToHandle(){
  const json=JSON.stringify(buildSaveData(),null,2);
  const w=await S.fileHandle.createWritable();
  await w.write(json); await w.close();
  S.savedSnapshot=snapshotState();
  updateSaveStatus(); updateFileName();
}

async function doSave(){
  try{
    if(!S.fileHandle){
      if(!window.showSaveFilePicker){ downloadFallback(); return; }
      S.fileHandle=await window.showSaveFilePicker({
        suggestedName:'metric-tree.json',
        types:[{description:'JSON',accept:{'application/json':['.json']}}],
      });
    }
    await writeToHandle();
  } catch(e){
    if(e.name==='AbortError') return;
    S.fileHandle=null; downloadFallback();
  }
}

async function doSaveAs(){
  try{
    if(!window.showSaveFilePicker){ downloadFallback(); return; }
    S.fileHandle=await window.showSaveFilePicker({
      suggestedName:S.fileHandle?.name||'metric-tree.json',
      types:[{description:'JSON',accept:{'application/json':['.json']}}],
    });
    await writeToHandle();
  } catch(e){
    if(e.name==='AbortError') return;
    S.fileHandle=null; downloadFallback();
  }
}

function downloadFallback(){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(buildSaveData(),null,2)],{type:'application/json'}));
  a.download='metric-tree.json'; a.click();
  S.savedSnapshot=snapshotState(); updateSaveStatus();
}

// ── COMPUTE ───────────────────────────────────────────────────────────
function computeAll(){
  S.computed={};
  const initiative=S.activeInitiativeId?S.initiatives[S.activeInitiativeId]:null;
  const overrides=initiative?.overrides||{};
  for(const id of topoSort()){
    const n=S.nodes[id]; if(!n) continue;
    const ownMod=parseFloat(n.modifier)||0;
    const hasOverride=!!(initiative&&(id in overrides));
    const initMod=hasOverride?(parseFloat(overrides[id])||0):ownMod;
    if(isLeaf(id)){
      const b=parseFloat(n.baseValue)||0;
      S.computed[id]={baseValue:b, modifiedValue:b*(1+ownMod/100), initiativeValue:initiative?b*(1+initMod/100):null, hasOverride, error:null};
    } else {
      const ch=childEdges(id), expr=S.formulas[id]||'';
      if(!expr.trim()){ S.computed[id]={baseValue:null,modifiedValue:null,initiativeValue:null,hasOverride,error:'No formula'}; continue; }
      try {
        const bv={}, mv={}, iv={};
        for(const e of ch){
          const c=S.computed[e.childId];
          if(!c||c.error!==null) throw new Error('Child error');
          bv[e.variable]=c.baseValue; mv[e.variable]=c.modifiedValue;
          if(initiative) iv[e.variable]=c.initiativeValue??c.modifiedValue;
        }
        const base=evalFormula(expr,bv);
        const modified=evalFormula(expr,mv)*(1+ownMod/100);
        const initiativeValue=initiative?evalFormula(expr,iv)*(1+initMod/100):null;
        S.computed[id]={baseValue:base, modifiedValue:modified, initiativeValue, hasOverride, error:null};
      } catch(err){ S.computed[id]={baseValue:null,modifiedValue:null,initiativeValue:null,hasOverride,error:err.message}; }
    }
  }
}

// ── RENDER ────────────────────────────────────────────────────────────
function render(){ computeAll(); renderNodes(); renderEdges(); renderInspector(); updateSaveStatus(); }

function renderNodes(){
  const layer=document.getElementById('nodes-layer');
  const existing={};
  for(const el of layer.children) existing[el.dataset.id]=el;
  for(const id of Object.keys(existing)) if(!S.nodes[id]){ layer.removeChild(existing[id]); delete existing[id]; }
  const initiative=S.activeInitiativeId?S.initiatives[S.activeInitiativeId]:null;

  for(const id of Object.keys(S.nodes)){
    const n=S.nodes[id], c=S.computed[id]||{};
    let card=existing[id];
    if(!card){ card=document.createElement('div'); card.className='nc'; card.dataset.id=id; layer.appendChild(card); bindCard(card); }
    card.style.left=n.x+'px'; card.style.top=n.y+'px';
    const isSel=S.sel?.type==='node'&&S.sel.id===id;
    const isSrc=S.connSrc===id;
    const isMsel=S.multiSel.has(id);
    const initDelta=c.initiativeValue!=null&&c.modifiedValue!=null?c.initiativeValue-c.modifiedValue:null;
    const isInitAffected=initiative&&!c.hasOverride&&initDelta!==null&&Math.abs(initDelta)>1e-9;
    card.className='nc'+(isSel?' sel':'')+(isSrc?' csrc':'')+(c.error?' err':'')+(isMsel?' msel':'')+(n.color?' colored':'')+(c.hasOverride?' init-changed':isInitAffected?' init-affected':'');
    card.style.borderLeftColor=n.color||'';
    const isPct=!!n.baseValueIsPercent;
    const fv=(v)=>isPct?fmtPct(v):fmt(v);
    let h=`<div class="nh">${esc(n.name)}</div><div class="nb">`;
    if(initiative&&c.initiativeValue!=null&&!c.error){
      h+=`<div class="nr"><span class="nl">Base</span><span class="nv">${fv(c.baseValue)}</span></div>`;
      h+=`<div class="nr"><span class="nl">Main</span><span class="nv">${fv(c.modifiedValue)}</span></div>`;
      const noChange=initDelta===null||Math.abs(initDelta)<1e-9;
      h+=`<div class="nr"><span class="nl">Initiative</span><span class="nv ${noChange?'':'amber'}">${fv(c.initiativeValue)}</span></div>`;
      if(!noChange){
        const initDeltaPct=(Math.abs(c.modifiedValue)>1e-9)?(initDelta/c.modifiedValue*100):null;
        const sign=initDelta>0?'+':'';
        if(initDeltaPct!==null) h+=`<div class="nr"><span class="nl">Δ init</span><span class="nv ${initDelta>0?'pos':'neg'}">${sign}${fmt(initDeltaPct)}%</span></div>`;
      }
    } else {
      const mod=parseFloat(n.modifier)||0, hasM=mod!==0;
      const delta=(c.baseValue!=null&&c.modifiedValue!=null&&!c.error)?(c.modifiedValue-c.baseValue):null;
      const hasDelta=delta!==null&&Math.abs(delta)>1e-9;
      const deltaPct=(hasDelta&&c.baseValue!=null&&Math.abs(c.baseValue)>1e-9)?(delta/c.baseValue*100):null;
      h+=`<div class="nr"><span class="nl">Base</span><span class="nv">${fv(c.baseValue)}</span></div>`;
      h+=`<div class="nr"><span class="nl">Modified</span><span class="nv ${hasDelta?'amber':''}">${fv(c.modifiedValue)}</span></div>`;
      h+=`<div class="nr"><span class="nl">Modifier</span><span class="nm ${hasM?'nz':''}">${mod>0?'+':''}${fmt(mod)}%</span></div>`;
      if(hasDelta){ const sign=delta>0?'+':''; h+=`<div class="nr"><span class="nl">Δ</span><span class="nv ${delta>0?'pos':'neg'}">${sign}${fv(delta)}</span></div>`; }
      if(deltaPct!==null){ const sign=deltaPct>0?'+':''; h+=`<div class="nr"><span class="nl">Δ%</span><span class="nv ${deltaPct>0?'pos':'neg'}">${sign}${fmt(deltaPct)}%</span></div>`; }
    }
    h+=`</div>`;
    if(c.error) h+=`<div class="nerr">${esc(c.error)}</div>`;
    card.innerHTML=h;
  }
}

function nodeH(id){
  const c=S.computed[id]||{}, n=S.nodes[id];
  if(!n) return 88;
  if(S.activeInitiativeId&&c.initiativeValue!=null&&!c.error){
    const initDelta=Math.abs((c.initiativeValue??0)-(c.modifiedValue??0))>1e-9;
    return 36+6+18+18+18+(initDelta?18:0)+14; // header+pad+base+main+initiative+[Δ]+bottom
  }
  const delta=(c.baseValue!=null&&c.modifiedValue!=null&&!c.error)?(c.modifiedValue-c.baseValue):null;
  const hasDelta=delta!==null&&Math.abs(delta)>1e-9;
  const hasDeltaPct=hasDelta&&c.baseValue!=null&&Math.abs(c.baseValue)>1e-9;
  let h=36+6+18+18+18;
  if(hasDelta) h+=18;
  if(hasDeltaPct) h+=18;
  if(c.error) h+=24;
  return h+14;
}

const NW=168;
function nodeCenter(id){ const n=S.nodes[id]; return {x:n.x+NW/2, y:n.y+nodeH(id)/2}; }
function rectExitPoint(id,tx,ty){
  const n=S.nodes[id], hw=NW/2, hh=nodeH(id)/2;
  const cx=n.x+hw, cy=n.y+hh;
  const dx=tx-cx, dy=ty-cy;
  if(!dx&&!dy) return {x:cx,y:cy,nx:0,ny:-1};
  const tx_=dx?hw/Math.abs(dx):Infinity, ty_=dy?hh/Math.abs(dy):Infinity;
  const t=Math.min(tx_,ty_);
  const nx=tx_<=ty_?(dx>0?1:-1):0, ny=tx_>ty_?(dy>0?1:-1):0;
  return {x:cx+dx*t, y:cy+dy*t, nx, ny};
}
function bez(t,p0,p1,p2,p3){ const m=1-t; return m*m*m*p0+3*m*m*t*p1+3*m*t*t*p2+t*t*t*p3 }

function renderEdges(){
  const g=document.getElementById('edges-g');
  g.innerHTML='';
  for(const e of Object.values(S.edges)){
    const ch=S.nodes[e.childId], pa=S.nodes[e.parentId];
    if(!ch||!pa) continue;
    const isSel=S.sel?.type==='edge'&&S.sel.id===e.id;
    const cc2=nodeCenter(e.childId), cp=nodeCenter(e.parentId);
    const start=rectExitPoint(e.childId,cp.x,cp.y);
    const end=rectExitPoint(e.parentId,cc2.x,cc2.y);
    const dist=Math.hypot(end.x-start.x,end.y-start.y);
    const off=Math.max(30,dist*0.38);
    const cp1x=start.x+start.nx*off, cp1y=start.y+start.ny*off;
    const cp2x=end.x+end.nx*off,     cp2y=end.y+end.ny*off;
    const d=`M${start.x} ${start.y} C${cp1x} ${cp1y},${cp2x} ${cp2y},${end.x} ${end.y}`;
    const col=isSel?'#3b82f6':'#888';
    const mk=isSel?'url(#arr-sel)':'url(#arr)';

    const hit=ns('path'); hit.setAttribute('d',d);
    hit.setAttribute('stroke','transparent'); hit.setAttribute('stroke-width','14');
    hit.setAttribute('fill','none'); hit.style.pointerEvents='stroke'; hit.style.cursor='pointer';
    hit.addEventListener('mousedown',ev=>ev.stopPropagation());
    hit.addEventListener('click',ev=>{ev.stopPropagation();selEdge(e.id)});
    g.appendChild(hit);

    const path=ns('path'); path.setAttribute('d',d);
    path.setAttribute('stroke',col); path.setAttribute('stroke-width',isSel?2:1.5);
    path.setAttribute('fill','none'); path.setAttribute('marker-end',mk);
    path.style.pointerEvents='none';
    g.appendChild(path);

    const mx=bez(.5,start.x,cp1x,cp2x,end.x), my=bez(.5,start.y,cp1y,cp2y,end.y);
    const rect=ns('rect'); rect.setAttribute('x',mx-10); rect.setAttribute('y',my-10);
    rect.setAttribute('width',20); rect.setAttribute('height',20); rect.setAttribute('rx',4);
    rect.setAttribute('fill',col); rect.style.pointerEvents='none';
    g.appendChild(rect);

    const txt=ns('text'); txt.setAttribute('x',mx); txt.setAttribute('y',my+4.5);
    txt.setAttribute('text-anchor','middle'); txt.setAttribute('fill','#fff');
    txt.setAttribute('font-size','11'); txt.setAttribute('font-weight','700');
    txt.style.pointerEvents='none'; txt.textContent=e.variable;
    g.appendChild(txt);
  }
}

function ns(tag){ return document.createElementNS('http://www.w3.org/2000/svg',tag) }

// ── INSPECTOR ─────────────────────────────────────────────────────────
function renderInspector(){
  const empty=document.getElementById('iEmpty'), cont=document.getElementById('iContent');
  if(!S.sel){ empty.style.display=''; cont.style.display='none'; renderInitiativesPanel(); return; }
  empty.style.display='none'; cont.style.display='';
  S.sel.type==='node'?inspNode(S.sel.id):inspEdge(S.sel.id);
}

function inspNode(id){
  const n=S.nodes[id]; if(!n) return;
  const cont=document.getElementById('iContent');
  const c=S.computed[id]||{}, leaf=isLeaf(id);
  const mod=parseFloat(n.modifier)||0;
  const initiative=S.activeInitiativeId?S.initiatives[S.activeInitiativeId]:null;
  const hasOverride=!!(initiative&&(id in initiative.overrides));
  const overrideMod=hasOverride?(parseFloat(initiative.overrides[id])||0):mod;
  const fv=(v)=>n.baseValueIsPercent?fmtPct(v):fmt(v);

  let h=`<div class="ititle">${leaf?'Leaf Node':'Parent Node'}</div>`;
  h+=fg('Name',`<input class="fi" id="iName" type="text" value="${ea(n.name)}">`);
  const dots=[`<span class="cdot none${!n.color?' active':''}" data-c=""></span>`,...NODE_COLORS.map(col=>`<span class="cdot${n.color===col?' active':''}" style="background:${col}" data-c="${col}"></span>`)].join('');
  h+=fg('Color',`<div class="color-row" id="iColorRow">${dots}</div>`);

  if(leaf){
    const baseDisp=n.baseValueIsPercent?parseFloat((n.baseValue*100).toFixed(8)):n.baseValue;
    h+=fg('Base Value',`<div class="fi-row"><input class="fi" id="iBase" type="number" step="any" value="${baseDisp}"><button class="pct-toggle${n.baseValueIsPercent?' active':''}" id="iPctToggle">%</button></div>`);
    if(initiative){
      h+=fg('Modifier (main)',`<input class="fi" type="text" value="${mod>0?'+':''}${fmt(mod)}%" readonly>`);
      h+=`<div class="fg"><div class="fl init-label">Modifier (initiative)</div><div class="fi-row"><input class="fi init-field" id="iInitMod" type="number" value="${overrideMod}" step="any"><span class="fsufx">%</span></div>${hasOverride?`<button class="btn init-reset-btn" id="iInitReset">↩ Reset to main (${fmt(mod)}%)</button>`:''}</div>`;
      h+=fg('Modified (main)',`<input class="fi" id="iModMainVal" type="text" value="${fv(c.modifiedValue)}" readonly>`);
      h+=fg('Initiative (computed)',`<input class="fi init-field" id="iInitVal" type="text" value="${fv(c.initiativeValue)}" readonly>`);
    } else {
      h+=fg('Modifier',`<div class="fi-row"><input class="fi" id="iMod" type="number" value="${mod}" step="any"><span class="fsufx">%</span></div>`);
      h+=fg('Modified Value (computed)',`<input class="fi" id="iModVal" type="text" value="${fv(c.modifiedValue)}" readonly>`);
    }
  } else {
    const expr=S.formulas[id]||'';
    h+=fg('Formula',`<input class="fi" id="iFormula" type="text" value="${ea(expr)}" placeholder="e.g. A * B">`);
    const ch=childEdges(id);
    h+=`<div class="fg"><div class="fl">Children (${ch.length})</div><div class="clist">`;
    for(const e of ch){
      const cc=S.nodes[e.childId], cv=S.computed[e.childId]||{};
      if(!cc) continue;
      h+=`<div class="ci"><span class="vbadge">${e.variable}</span><div class="ci-info"><div class="ci-name">${esc(cc.name)}</div><div class="ci-vals">Base: ${fmt(cv.baseValue)} | Mod: ${fmt(cv.modifiedValue)}</div></div></div>`;
    }
    h+=`</div></div>`;
    h+=fg('Formula Preview',`<div class="fprev" id="iPrev">—</div>`);
    if(initiative){
      h+=fg('Modifier (main)',`<input class="fi" type="text" value="${mod>0?'+':''}${fmt(mod)}%" readonly>`);
      h+=`<div class="fg"><div class="fl init-label">Modifier (initiative)</div><div class="fi-row"><input class="fi init-field" id="iInitMod" type="number" value="${overrideMod}" step="any"><span class="fsufx">%</span></div>${hasOverride?`<button class="btn init-reset-btn" id="iInitReset">↩ Reset to main (${fmt(mod)}%)</button>`:''}</div>`;
      h+=fg('Base (computed)',`<div class="fi-row"><input class="fi" id="iBaseVal" type="text" value="${fv(c.baseValue)}" readonly><button class="pct-toggle${n.baseValueIsPercent?' active':''}" id="iPctToggle">%</button></div>`);
      h+=fg('Modified (main)',`<input class="fi" id="iModMainVal" type="text" value="${fv(c.modifiedValue)}" readonly>`);
      h+=fg('Initiative (computed)',`<input class="fi init-field" id="iInitVal" type="text" value="${fv(c.initiativeValue)}" readonly>`);
    } else {
      h+=fg('Modifier',`<div class="fi-row"><input class="fi" id="iMod" type="number" value="${mod}" step="any"><span class="fsufx">%</span></div>`);
      h+=fg('Base (computed)',`<div class="fi-row"><input class="fi" id="iBaseVal" type="text" value="${fv(c.baseValue)}" readonly><button class="pct-toggle${n.baseValueIsPercent?' active':''}" id="iPctToggle">%</button></div>`);
      h+=fg('Modified (computed)',`<input class="fi" id="iModifiedVal" type="text" value="${fv(c.modifiedValue)}" readonly>`);
    }
  }
  h+=`<hr class="divider"><button class="btn danger" id="iDel" style="width:100%">Delete Node</button>`;
  cont.innerHTML=h;

  document.getElementById('iName').addEventListener('input',e=>{ n.name=e.target.value; renderNodes(); renderEdges(); scheduleHistory(); });
  document.getElementById('iColorRow').addEventListener('click',e=>{
    const dot=e.target.closest('.cdot'); if(!dot) return;
    n.color=dot.dataset.c||null;
    dot.parentNode.querySelectorAll('.cdot').forEach(d=>d.classList.toggle('active',d===dot));
    renderNodes(); pushHistory();
  });

  if(leaf){
    const refreshLeaf=()=>{
      computeAll(); renderNodes(); renderEdges();
      const c2=S.computed[id]||{};
      const mv=document.getElementById('iModVal'), mm=document.getElementById('iModMainVal'), iv=document.getElementById('iInitVal');
      if(mv) mv.value=fv(c2.modifiedValue);
      if(mm) mm.value=fv(c2.modifiedValue);
      if(iv) iv.value=fv(c2.initiativeValue);
    };
    document.getElementById('iBase').addEventListener('input',e=>{
      const val=parseFloat(e.target.value)||0;
      n.baseValue=n.baseValueIsPercent?val/100:val;
      refreshLeaf(); scheduleHistory();
    });
    document.getElementById('iPctToggle').addEventListener('click',()=>{
      n.baseValueIsPercent=!n.baseValueIsPercent;
      const inp=document.getElementById('iBase');
      inp.value=n.baseValueIsPercent?parseFloat((n.baseValue*100).toFixed(8)):n.baseValue;
      document.getElementById('iPctToggle').classList.toggle('active',n.baseValueIsPercent);
      refreshLeaf(); pushHistory();
    });
    if(initiative){
      document.getElementById('iInitMod').addEventListener('input',e=>{ setInitiativeOverride(id,parseFloat(e.target.value)||0); refreshLeaf(); });
      const rb=document.getElementById('iInitReset');
      if(rb) rb.addEventListener('click',()=>clearInitiativeOverride(id));
    } else {
      document.getElementById('iMod').addEventListener('input',e=>{ n.modifier=parseFloat(e.target.value)||0; refreshLeaf(); scheduleHistory(); });
    }
  } else {
    const refreshParent=()=>{
      computeAll(); renderNodes(); renderEdges();
      const c2=S.computed[id]||{};
      const bvEl=document.getElementById('iBaseVal'), mvEl=document.getElementById('iModifiedVal');
      const mmEl=document.getElementById('iModMainVal'), ivEl=document.getElementById('iInitVal');
      if(bvEl) bvEl.value=fv(c2.baseValue);
      if(mvEl) mvEl.value=fv(c2.modifiedValue);
      if(mmEl) mmEl.value=fv(c2.modifiedValue);
      if(ivEl) ivEl.value=fv(c2.initiativeValue);
      updatePrev(id);
    };
    document.getElementById('iFormula').addEventListener('input',e=>{ S.formulas[id]=e.target.value; refreshParent(); scheduleHistory(); });
    document.getElementById('iPctToggle').addEventListener('click',()=>{
      n.baseValueIsPercent=!n.baseValueIsPercent;
      document.getElementById('iPctToggle').classList.toggle('active',n.baseValueIsPercent);
      refreshParent(); pushHistory();
    });
    if(initiative){
      document.getElementById('iInitMod').addEventListener('input',e=>{ setInitiativeOverride(id,parseFloat(e.target.value)||0); refreshParent(); });
      const rb=document.getElementById('iInitReset');
      if(rb) rb.addEventListener('click',()=>clearInitiativeOverride(id));
    } else {
      document.getElementById('iMod').addEventListener('input',e=>{ n.modifier=parseFloat(e.target.value)||0; refreshParent(); scheduleHistory(); });
    }
    updatePrev(id);
  }
  document.getElementById('iDel').addEventListener('click',()=>delNode(id));
}

function updatePrev(id){
  const prev=document.getElementById('iPrev'); if(!prev) return;
  const expr=S.formulas[id]||'';
  if(!expr.trim()){ prev.textContent='No formula'; prev.className='fprev'; return; }
  const ch=childEdges(id);
  try {
    const bv={}, mv={};
    let bExpr=expr, mExpr=expr;
    for(const e of ch){
      const cv=S.computed[e.childId]||{};
      bv[e.variable]=cv.baseValue??0; mv[e.variable]=cv.modifiedValue??0;
      bExpr=bExpr.replace(new RegExp(`\\b${e.variable}\\b`,'g'),fmt(bv[e.variable]));
      mExpr=mExpr.replace(new RegExp(`\\b${e.variable}\\b`,'g'),fmt(mv[e.variable]));
    }
    const br=evalFormula(expr,bv), mr=evalFormula(expr,mv);
    prev.textContent=`Base:     ${bExpr} = ${fmt(br)}\nModified: ${mExpr} = ${fmt(mr)}`;
    prev.className='fprev';
  } catch(err){ prev.textContent=`Error: ${err.message}`; prev.className='fprev ferr'; }
}

function inspEdge(id){
  const e=S.edges[id]; if(!e) return;
  const cont=document.getElementById('iContent');
  const ch=S.nodes[e.childId], pa=S.nodes[e.parentId];
  cont.innerHTML=`<div class="ititle">Connection</div>
    ${fg('Child',`<input class="fi" type="text" value="${ea(ch?.name||'')}" readonly>`)}
    ${fg('Parent',`<input class="fi" type="text" value="${ea(pa?.name||'')}" readonly>`)}
    ${fg('Variable',`<input class="fi" type="text" value="${e.variable}" readonly>`)}
    <hr class="divider"><button class="btn danger" id="iRemove" style="width:100%">Remove Connection</button>`;
  document.getElementById('iRemove').addEventListener('click',()=>removeEdge(id));
}

function fg(label, html){ return `<div class="fg"><div class="fl">${label}</div>${html}</div>` }

// ── NODE EVENTS ───────────────────────────────────────────────────────
function bindCard(card){
  card.addEventListener('mousedown',ev=>{
    if(ev.target.tagName==='INPUT'||ev.target.contentEditable==='true') return;
    ev.preventDefault(); ev.stopPropagation();
    const id=card.dataset.id;
    if(ev.shiftKey && S.sel?.type==='node' && S.sel.id!==id){ connect(S.sel.id,id); return; }
    if(S.connMode && S.connSrc && S.connSrc!==id){ connect(S.connSrc,id); return; }
    if(S.connMode && !S.connSrc){ S.connSrc=id; render(); return; }
    if(S.multiSel.has(id)&&S.multiSel.size>1){
      S.drag={id,sx:ev.clientX,sy:ev.clientY,ox:S.nodes[id].x,oy:S.nodes[id].y,
        multi:Array.from(S.multiSel).map(nid=>({id:nid,ox:S.nodes[nid].x,oy:S.nodes[nid].y}))};
      return;
    }
    S.multiSel.clear();
    selNode(id);
    S.drag={id, sx:ev.clientX, sy:ev.clientY, ox:S.nodes[id].x, oy:S.nodes[id].y};
  });
  card.addEventListener('dblclick',ev=>{
    if(ev.target.tagName==='INPUT') return;
    ev.stopPropagation();
    const id=card.dataset.id, hdr=card.querySelector('.nh');
    if(!hdr) return;
    hdr.contentEditable='true'; hdr.focus();
    const rng=document.createRange(); rng.selectNodeContents(hdr);
    const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(rng);
    const finish=()=>{ S.nodes[id].name=hdr.textContent.trim()||'Node'; hdr.contentEditable='false'; render(); };
    hdr.addEventListener('blur',finish,{once:true});
    hdr.addEventListener('keydown',ke=>{ if(ke.key==='Enter'){ke.preventDefault();hdr.blur();} });
  });
}

// ── SELECTION ─────────────────────────────────────────────────────────
function selNode(id){ S.sel={type:'node',id}; if(S.connMode) S.connSrc=id; render(); }
function selEdge(id){ S.sel={type:'edge',id}; render(); }
function clearSel(){ S.sel=null; if(S.connMode) S.connSrc=null; render(); }

// ── NODE OPS ──────────────────────────────────────────────────────────
function addNode(){
  const id=gid(), cc=document.getElementById('cc');
  const cx=(cc.clientWidth/2-S.T.x)/S.T.s, cy=(cc.clientHeight/2-S.T.y)/S.T.s;
  S.nodes[id]={id,name:'New Metric',x:cx-84,y:cy-44,baseValue:0,modifier:0,baseValueIsPercent:false,color:null};
  selNode(id); render(); pushHistory();
}

function delNode(id){
  for(const eid of Object.keys(S.edges)){ const e=S.edges[eid]; if(e.childId===id||e.parentId===id) delete S.edges[eid]; }
  delete S.nodes[id]; delete S.formulas[id];
  if(S.sel?.id===id) S.sel=null;
  if(S.connSrc===id) S.connSrc=null;
  render(); pushHistory();
}

function connect(childId, parentId){
  if(childId===parentId){ alert('Cannot connect a node to itself.'); return; }
  if(hasCycle(childId,parentId)){ alert('This connection would create a cycle.'); return; }
  if(Object.values(S.edges).find(e=>e.childId===childId&&e.parentId===parentId)){ alert('Already connected.'); return; }
  const used=Object.values(S.edges).filter(e=>e.parentId===parentId).map(e=>e.variable);
  let v='A'; while(used.includes(v)) v=String.fromCharCode(v.charCodeAt(0)+1);
  const eid=gid();
  S.edges[eid]={id:eid,childId,parentId,variable:v};
  if(S.connMode) S.connSrc=null;
  selNode(parentId); render(); pushHistory();
}

function removeEdge(eid){
  const e=S.edges[eid]; if(!e) return;
  const pid=e.parentId; delete S.edges[eid];
  const rem=Object.values(S.edges).filter(e=>e.parentId===pid).sort((a,b)=>a.variable<b.variable?-1:1);
  rem.forEach((e,i)=>e.variable=String.fromCharCode(65+i));
  if(S.sel?.id===eid) S.sel=null;
  render(); pushHistory();
}

// ── ZOOM / PAN ────────────────────────────────────────────────────────
function applyT(){
  document.getElementById('canvas').style.transform=`translate(${S.T.x}px,${S.T.y}px) scale(${S.T.s})`;
  const cc=document.getElementById('cc');
  const gs=24*S.T.s;
  cc.style.backgroundImage='radial-gradient(circle, var(--grid) 1.5px, transparent 1.5px)';
  cc.style.backgroundSize=`${gs}px ${gs}px`;
  cc.style.backgroundPosition=`${S.T.x}px ${S.T.y}px`;
}

const cc=document.getElementById('cc');

cc.addEventListener('wheel',ev=>{
  ev.preventDefault();
  const r=cc.getBoundingClientRect();
  const mx=ev.clientX-r.left, my=ev.clientY-r.top;
  const factor=Math.exp(-ev.deltaY*.001);
  const newS=Math.min(4,Math.max(.1,S.T.s*factor));
  const sr=newS/S.T.s;
  S.T.x=mx-sr*(mx-S.T.x); S.T.y=my-sr*(my-S.T.y); S.T.s=newS;
  applyT();
},{passive:false});

function toCanvas(clientX,clientY){ const r=cc.getBoundingClientRect(); return {x:(clientX-r.left-S.T.x)/S.T.s, y:(clientY-r.top-S.T.y)/S.T.s}; }

function updateSelRect(){
  const sr=document.getElementById('sel-rect'); if(!sr||!S.rectDraw){if(sr)sr.style.display='none';return;}
  const {sx,sy,ex,ey}=S.rectDraw;
  const x=Math.min(sx,ex),y=Math.min(sy,ey),w=Math.abs(ex-sx),h=Math.abs(ey-sy);
  sr.setAttribute('x',x);sr.setAttribute('y',y);sr.setAttribute('width',w);sr.setAttribute('height',h);sr.style.display='';
  S.multiSel.clear();
  for(const[id,n]of Object.entries(S.nodes)){if(n.x+NW>x&&n.x<x+w&&n.y+nodeH(id)>y&&n.y<y+h) S.multiSel.add(id);}
  renderNodes();
}

cc.addEventListener('mousedown',ev=>{
  if(ev.target!==cc&&ev.target!==document.getElementById('canvas')&&!ev.target.closest('#svg-layer')) return;
  if(ev.button!==0) return;
  if(S.selMode){
    if(!ev.shiftKey){ S.sel=null; S.multiSel.clear(); if(S.connMode) S.connSrc=null; renderInspector(); renderNodes(); }
    const p=toCanvas(ev.clientX,ev.clientY);
    S.rectDraw={sx:p.x,sy:p.y,ex:p.x,ey:p.y};
    return;
  }
  if(!ev.shiftKey){ S.sel=null; S.multiSel.clear(); if(S.connMode) S.connSrc=null; renderInspector(); renderNodes(); }
  S.pan={sx:ev.clientX,sy:ev.clientY,ox:S.T.x,oy:S.T.y};
  cc.classList.add('panning');
});

document.addEventListener('mousemove',ev=>{
  if(S.drag){
    const dx=(ev.clientX-S.drag.sx)/S.T.s, dy=(ev.clientY-S.drag.sy)/S.T.s;
    if(S.drag.multi){
      for(const m of S.drag.multi){
        S.nodes[m.id].x=m.ox+dx; S.nodes[m.id].y=m.oy+dy;
        const card=document.querySelector(`.nc[data-id="${m.id}"]`);
        if(card){card.style.left=S.nodes[m.id].x+'px';card.style.top=S.nodes[m.id].y+'px';}
      }
    } else {
      const n=S.nodes[S.drag.id]; n.x=S.drag.ox+dx; n.y=S.drag.oy+dy;
      const card=document.querySelector(`.nc[data-id="${S.drag.id}"]`);
      if(card){card.style.left=n.x+'px';card.style.top=n.y+'px';}
    }
    renderEdges(); return;
  }
  if(S.rectDraw){
    const p=toCanvas(ev.clientX,ev.clientY); S.rectDraw.ex=p.x; S.rectDraw.ey=p.y;
    updateSelRect(); return;
  }
  if(S.pan){
    S.T.x=S.pan.ox+(ev.clientX-S.pan.sx); S.T.y=S.pan.oy+(ev.clientY-S.pan.sy);
    applyT();
  }
});

document.addEventListener('mouseup',()=>{
  if(S.drag) pushHistory();
  if(S.rectDraw){
    const {sx,sy,ex,ey}=S.rectDraw;
    if(Math.abs(ex-sx)<4&&Math.abs(ey-sy)<4){ S.multiSel.clear(); renderNodes(); }
    document.getElementById('sel-rect').style.display='none';
    S.rectDraw=null;
  }
  S.drag=null; S.pan=null; cc.classList.remove('panning');
});

document.addEventListener('keydown',ev=>{
  const inInput=ev.target.tagName==='INPUT'||ev.target.contentEditable==='true';
  if((ev.ctrlKey||ev.metaKey)&&ev.key==='z'&&!ev.shiftKey){ ev.preventDefault(); undo(); return; }
  if((ev.ctrlKey||ev.metaKey)&&(ev.key==='y'||(ev.key==='z'&&ev.shiftKey))){ ev.preventDefault(); redo(); return; }
  if((ev.ctrlKey||ev.metaKey)&&ev.key==='s'){ ev.preventDefault(); doSave(); return; }
  if(inInput) return;
  if(ev.key==='Delete'||ev.key==='Backspace'){
    if(S.multiSel.size>1){ for(const id of [...S.multiSel]) delNode(id); S.multiSel.clear(); }
    else if(S.sel){ if(S.sel.type==='node') delNode(S.sel.id); else removeEdge(S.sel.id); }
  }
  if(ev.key==='Escape'){
    S.multiSel.clear(); renderNodes();
    clearSel();
    if(S.selMode){ S.selMode=false; document.getElementById('bSel').classList.remove('active'); cc.classList.remove('sel-mode'); }
    if(S.connMode){ S.connMode=false; S.connSrc=null; document.getElementById('bConn').classList.remove('active'); cc.classList.remove('connect-mode'); setHint(''); render(); }
  }
});

// ── TOOLBAR ───────────────────────────────────────────────────────────
document.getElementById('bAdd').addEventListener('click',addNode);
document.getElementById('bUndo').addEventListener('click',undo);
document.getElementById('bRedo').addEventListener('click',redo);
document.getElementById('bSel').addEventListener('click',()=>{
  S.selMode=!S.selMode;
  document.getElementById('bSel').classList.toggle('active',S.selMode);
  cc.classList.toggle('sel-mode',S.selMode);
  if(!S.selMode){ S.multiSel.clear(); renderNodes(); }
  if(S.selMode&&S.connMode){ S.connMode=false; document.getElementById('bConn').classList.remove('active'); cc.classList.remove('connect-mode'); setHint(''); }
});

document.getElementById('bConn').addEventListener('click',()=>{
  S.connMode=!S.connMode; S.connSrc=null;
  document.getElementById('bConn').classList.toggle('active',S.connMode);
  cc.classList.toggle('connect-mode',S.connMode);
  setHint(S.connMode?'Connect mode: click a child node, then click the parent node.':'');
  render();
});

document.getElementById('bSave').addEventListener('click',doSave);
document.getElementById('bSaveAs').addEventListener('click',doSaveAs);

document.getElementById('bLoad').addEventListener('click',()=>document.getElementById('fileIn').click());
document.getElementById('fileIn').addEventListener('change',ev=>{
  const f=ev.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=e=>{
    try {
      const d=JSON.parse(e.target.result);
      S.nodes={}; S.edges={}; S.formulas={}; S.computed={}; S.sel=null;
      S.initiatives={}; S.activeInitiativeId=null;
      for(const n of d.nodes||[]) S.nodes[n.id]=n;
      for(const e of d.edges||[]) S.edges[e.id]=e;
      for(const f of d.formulas||[]) S.formulas[f.nodeId]=f.expression;
      for(const i of d.initiatives||[]) S.initiatives[i.id]=i;
      if(d._meta?.nextId) S.nextId=d._meta.nextId;
      updateInitBanner(); render(); initHistory(); S.savedSnapshot=snapshotState(); updateSaveStatus();
    } catch(err){ alert('Failed to load: '+err.message); }
  };
  r.readAsText(f); ev.target.value='';
});

document.getElementById('bInitBack').addEventListener('click',exitInitiative);

document.getElementById('bReset').addEventListener('click',()=>{
  if(confirm('Reset? All nodes and edges will be cleared.')){
    S.nodes={}; S.edges={}; S.formulas={}; S.computed={}; S.sel=null; S.nextId=1;
    S.initiatives={}; S.activeInitiativeId=null;
    updateInitBanner(); render(); initHistory();
  }
});

// ── INITIATIVES ───────────────────────────────────────────────────────
function addInitiative(){
  const id=gid(), count=Object.keys(S.initiatives).length+1;
  S.initiatives[id]={id,name:'Initiative '+count,overrides:{}};
  render(); pushHistory();
}

function deleteInitiative(id){
  if(S.activeInitiativeId===id) exitInitiative();
  delete S.initiatives[id];
  render(); pushHistory();
}

function renameInitiative(id,name){
  if(!S.initiatives[id]) return;
  S.initiatives[id].name=name;
  updateInitBanner(); render(); pushHistory();
}

function enterInitiative(id){
  S.activeInitiativeId=id;
  S.sel=null;
  updateInitBanner(); render();
}

function exitInitiative(){
  S.activeInitiativeId=null;
  S.sel=null;
  updateInitBanner(); render();
}

function setInitiativeOverride(nodeId,mod){
  if(!S.activeInitiativeId) return;
  S.initiatives[S.activeInitiativeId].overrides[nodeId]=mod;
  scheduleHistory();
}

function clearInitiativeOverride(nodeId){
  if(!S.activeInitiativeId) return;
  delete S.initiatives[S.activeInitiativeId].overrides[nodeId];
  computeAll(); renderNodes(); renderEdges(); renderInspector(); scheduleHistory();
}

function updateInitBanner(){
  const banner=document.getElementById('init-banner');
  if(!banner) return;
  if(!S.activeInitiativeId){ banner.style.display='none'; return; }
  const init=S.initiatives[S.activeInitiativeId];
  banner.style.display='';
  const nameEl=document.getElementById('initBannerName');
  if(nameEl) nameEl.textContent=init?.name||'';
}

function renderInitiativesPanel(){
  const empty=document.getElementById('iEmpty');
  const inits=Object.values(S.initiatives);
  let h=`<div class="init-panel">`;
  h+=`<div class="ititle">Initiatives</div>`;
  h+=`<button class="btn primary" style="width:100%;margin-bottom:12px" id="bInitAdd">+ Add initiative</button>`;
  if(inits.length===0){
    h+=`<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px 0">No initiatives yet</div>`;
  } else {
    for(const init of inits){
      const isActive=S.activeInitiativeId===init.id;
      const overrideCount=Object.keys(init.overrides).length;
      h+=`<div class="init-item${isActive?' active':''}">`;
      h+=`<div class="init-item-name">${esc(init.name)}${overrideCount?`<span class="init-ov-badge">${overrideCount}</span>`:''}</div>`;
      h+=`<div class="init-item-btns">`;
      if(!isActive) h+=`<button class="btn" id="bEnter_${init.id}">Open →</button>`;
      else h+=`<button class="btn active" id="bExit_${init.id}">Exit</button>`;
      h+=`<button class="btn" id="bRename_${init.id}" title="Rename">✏</button>`;
      h+=`<button class="btn danger" id="bDel_${init.id}">✕</button>`;
      h+=`</div></div>`;
    }
  }
  h+=`</div>`;
  empty.innerHTML=h;

  document.getElementById('bInitAdd').addEventListener('click',addInitiative);
  for(const init of inits){
    const enterBtn=document.getElementById('bEnter_'+init.id);
    const exitBtn=document.getElementById('bExit_'+init.id);
    const renameBtn=document.getElementById('bRename_'+init.id);
    const delBtn=document.getElementById('bDel_'+init.id);
    if(enterBtn) enterBtn.addEventListener('click',()=>enterInitiative(init.id));
    if(exitBtn) exitBtn.addEventListener('click',exitInitiative);
    renameBtn.addEventListener('click',()=>{
      const name=prompt('Rename:',init.name);
      if(name!=null&&name.trim()) renameInitiative(init.id,name.trim());
    });
    delBtn.addEventListener('click',()=>{
      if(confirm('Delete "'+init.name+'"?')) deleteInitiative(init.id);
    });
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function ea(s){ return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;') }
function setHint(t){ document.getElementById('hint').textContent=t }

// ── INIT ──────────────────────────────────────────────────────────────
applyT(); render(); initHistory();
