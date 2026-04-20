// ── STATE ──────────────────────────────────────────────────────────────
const S = {
  nodes: {},      // id → {id,name,x,y,baseValue,modifier}
  edges: {},      // id → {id,childId,parentId,variable}
  formulas: {},   // nodeId → expression string
  computed: {},   // nodeId → {baseValue,modifiedValue,error}
  sel: null,      // {type:'node'|'edge', id}
  connMode: false,
  connSrc: null,
  T: {x:0, y:0, s:1},
  nextId: 1,
  drag: null,
  pan: null,
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
  return parseFloat(v.toFixed(3)).toString();
}

function fmtPct(v){
  if(v===null||v===undefined||isNaN(v)) return '—';
  return parseFloat((v*100).toFixed(3)).toString()+'%';
}

// ── COMPUTE ───────────────────────────────────────────────────────────
function computeAll(){
  S.computed={};
  for(const id of topoSort()){
    const n=S.nodes[id]; if(!n) continue;
    if(isLeaf(id)){
      const b=parseFloat(n.baseValue)||0, m=parseFloat(n.modifier)||0;
      S.computed[id]={baseValue:b, modifiedValue:b*(1+m/100), error:null};
    } else {
      const ch=childEdges(id), expr=S.formulas[id]||'';
      if(!expr.trim()){ S.computed[id]={baseValue:null,modifiedValue:null,error:'No formula'}; continue; }
      try {
        const bv={}, mv={};
        for(const e of ch){
          const c=S.computed[e.childId];
          if(!c||c.error!==null) throw new Error('Child error');
          bv[e.variable]=c.baseValue; mv[e.variable]=c.modifiedValue;
        }
        const base=evalFormula(expr,bv);
        const ownMod=parseFloat(n.modifier)||0;
        const modified=evalFormula(expr,mv)*(1+ownMod/100);
        S.computed[id]={baseValue:base, modifiedValue:modified, error:null};
      } catch(err){ S.computed[id]={baseValue:null,modifiedValue:null,error:err.message}; }
    }
  }
}

// ── RENDER ────────────────────────────────────────────────────────────
function render(){ computeAll(); renderNodes(); renderEdges(); renderInspector(); }

function renderNodes(){
  const layer=document.getElementById('nodes-layer');
  const existing={};
  for(const el of layer.children) existing[el.dataset.id]=el;
  for(const id of Object.keys(existing)) if(!S.nodes[id]){ layer.removeChild(existing[id]); delete existing[id]; }

  for(const id of Object.keys(S.nodes)){
    const n=S.nodes[id], c=S.computed[id]||{}, leaf=isLeaf(id);
    let card=existing[id];
    if(!card){ card=document.createElement('div'); card.className='nc'; card.dataset.id=id; layer.appendChild(card); bindCard(card); }
    card.style.left=n.x+'px'; card.style.top=n.y+'px';
    const isSel=S.sel?.type==='node'&&S.sel.id===id;
    const isSrc=S.connSrc===id;
    card.className='nc'+(isSel?' sel':'')+(isSrc?' csrc':'')+(c.error?' err':'');
    const mod=parseFloat(n.modifier)||0;
    const hasM=mod!==0;
    const isPct=!!n.baseValueIsPercent;
    const delta=(c.baseValue!=null&&c.modifiedValue!=null&&!c.error)?(c.modifiedValue-c.baseValue):null;
    const hasDelta=delta!==null&&Math.abs(delta)>1e-9;
    const fv=(v)=>isPct?fmtPct(v):fmt(v);
    let h=`<div class="nh">${esc(n.name)}</div><div class="nb">`;
    h+=`<div class="nr"><span class="nl">Base</span><span class="nv">${fv(c.baseValue)}</span></div>`;
    h+=`<div class="nr"><span class="nl">Modified</span><span class="nv ${hasDelta?'amber':''}">${fv(c.modifiedValue)}</span></div>`;
    h+=`<div class="nr"><span class="nl">Modifier</span><span class="nm ${hasM?'nz':''}">${mod>0?'+':''}${fmt(mod)}%</span></div>`;
    if(hasDelta){ const sign=delta>0?'+':''; h+=`<div class="nr"><span class="nl">Δ</span><span class="nv ${delta>0?'pos':'neg'}">${sign}${fv(delta)}</span></div>`; }
    h+=`</div>`;
    if(c.error) h+=`<div class="nerr">${esc(c.error)}</div>`;
    card.innerHTML=h;
  }
}

function nodeH(id){
  const c=S.computed[id]||{}, n=S.nodes[id];
  if(!n) return 88;
  const delta=(c.baseValue!=null&&c.modifiedValue!=null&&!c.error)?(c.modifiedValue-c.baseValue):null;
  const hasDelta=delta!==null&&Math.abs(delta)>1e-9;
  let h=36+6+18+18+18; // header+padding+base+modified+modifier
  if(hasDelta) h+=18;
  if(c.error) h+=24;
  return h+14;
}

const NW=168;
function portB(id){ const n=S.nodes[id]; return {x:n.x+NW/2, y:n.y+nodeH(id)} }
function portT(id){ const n=S.nodes[id]; return {x:n.x+NW/2, y:n.y} }
function bez(t,p0,p1,p2,p3){ const m=1-t; return m*m*m*p0+3*m*m*t*p1+3*m*t*t*p2+t*t*t*p3 }

function renderEdges(){
  const g=document.getElementById('edges-g');
  g.innerHTML='';
  for(const e of Object.values(S.edges)){
    const ch=S.nodes[e.childId], pa=S.nodes[e.parentId];
    if(!ch||!pa) continue;
    const isSel=S.sel?.type==='edge'&&S.sel.id===e.id;
    const b=portB(e.childId), t=portT(e.parentId);
    const dy=Math.abs(t.y-b.y), off=Math.max(40,dy*.45);
    const d=`M${b.x} ${b.y} C${b.x} ${b.y+off},${t.x} ${t.y-off},${t.x} ${t.y}`;
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

    const mx=bez(.5,b.x,b.x,t.x,t.x), my=bez(.5,b.y,b.y+off,t.y-off,t.y);
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
  if(!S.sel){ empty.style.display=''; cont.style.display='none'; return; }
  empty.style.display='none'; cont.style.display='';
  S.sel.type==='node'?inspNode(S.sel.id):inspEdge(S.sel.id);
}

function inspNode(id){
  const n=S.nodes[id]; if(!n) return;
  const cont=document.getElementById('iContent');
  const c=S.computed[id]||{}, leaf=isLeaf(id);
  const mod=parseFloat(n.modifier)||0;
  let h=`<div class="ititle">${leaf?'Leaf Node':'Parent Node'}</div>`;
  h+=fg('Name',`<input class="fi" id="iName" type="text" value="${ea(n.name)}">`);
  if(leaf){
    const baseDisp=n.baseValueIsPercent?parseFloat((n.baseValue*100).toFixed(8)):n.baseValue;
    h+=fg('Base Value',`<div class="fi-row"><input class="fi" id="iBase" type="number" step="any" value="${baseDisp}"><button class="pct-toggle${n.baseValueIsPercent?' active':''}" id="iPctToggle">%</button></div>`);
    h+=fg('Modifier',`<div class="fi-row"><input class="fi" id="iMod" type="number" value="${mod}" step="any"><span class="fsufx">%</span></div>`);
    const modVal=n.baseValueIsPercent?fmtPct(c.modifiedValue):fmt(c.modifiedValue);
    h+=fg('Modified Value (computed)',`<input class="fi" id="iModVal" type="text" value="${modVal}" readonly>`);
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
    h+=fg('Modifier',`<div class="fi-row"><input class="fi" id="iMod" type="number" value="${mod}" step="any"><span class="fsufx">%</span></div>`);
    const fv2=(v)=>n.baseValueIsPercent?fmtPct(v):fmt(v);
    h+=fg('Base (computed)',`<div class="fi-row"><input class="fi" id="iBaseVal" type="text" value="${fv2(c.baseValue)}" readonly><button class="pct-toggle${n.baseValueIsPercent?' active':''}" id="iPctToggle">%</button></div>`);
    h+=fg('Modified (computed)',`<input class="fi" id="iModifiedVal" type="text" value="${fv2(c.modifiedValue)}" readonly>`);
  }
  h+=`<hr class="divider"><button class="btn danger" id="iDel" style="width:100%">Delete Node</button>`;
  cont.innerHTML=h;

  document.getElementById('iName').addEventListener('input',e=>{ n.name=e.target.value; renderNodes(); renderEdges(); });
  if(leaf){
    const refreshLeaf=()=>{
      computeAll(); renderNodes(); renderEdges();
      const mv=document.getElementById('iModVal');
      if(mv){ const c2=S.computed[id]||{}; mv.value=n.baseValueIsPercent?fmtPct(c2.modifiedValue):fmt(c2.modifiedValue); }
    };
    document.getElementById('iBase').addEventListener('input',e=>{
      const val=parseFloat(e.target.value)||0;
      n.baseValue=n.baseValueIsPercent?val/100:val;
      refreshLeaf();
    });
    document.getElementById('iPctToggle').addEventListener('click',()=>{
      n.baseValueIsPercent=!n.baseValueIsPercent;
      const inp=document.getElementById('iBase');
      inp.value=n.baseValueIsPercent?parseFloat((n.baseValue*100).toFixed(8)):n.baseValue;
      document.getElementById('iPctToggle').classList.toggle('active',n.baseValueIsPercent);
      refreshLeaf();
    });
    document.getElementById('iMod').addEventListener('input',e=>{ n.modifier=parseFloat(e.target.value)||0; refreshLeaf(); });
  } else {
    const refreshParent=()=>{
      computeAll(); renderNodes(); renderEdges();
      const c2=S.computed[id]||{};
      const fvp=(v)=>n.baseValueIsPercent?fmtPct(v):fmt(v);
      const bvEl=document.getElementById('iBaseVal'), mvEl=document.getElementById('iModifiedVal');
      if(bvEl) bvEl.value=fvp(c2.baseValue);
      if(mvEl) mvEl.value=fvp(c2.modifiedValue);
      updatePrev(id);
    };
    document.getElementById('iFormula').addEventListener('input',e=>{ S.formulas[id]=e.target.value; refreshParent(); });
    document.getElementById('iMod').addEventListener('input',e=>{ n.modifier=parseFloat(e.target.value)||0; refreshParent(); });
    document.getElementById('iPctToggle').addEventListener('click',()=>{
      n.baseValueIsPercent=!n.baseValueIsPercent;
      document.getElementById('iPctToggle').classList.toggle('active',n.baseValueIsPercent);
      const c2=S.computed[id]||{};
      const fvp=(v)=>n.baseValueIsPercent?fmtPct(v):fmt(v);
      const bvEl=document.getElementById('iBaseVal'), mvEl=document.getElementById('iModifiedVal');
      if(bvEl) bvEl.value=fvp(c2.baseValue);
      if(mvEl) mvEl.value=fvp(c2.modifiedValue);
      renderNodes();
    });
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
  S.nodes[id]={id,name:'New Metric',x:cx-84,y:cy-44,baseValue:0,modifier:0,baseValueIsPercent:false};
  selNode(id); render();
}

function delNode(id){
  for(const eid of Object.keys(S.edges)){ const e=S.edges[eid]; if(e.childId===id||e.parentId===id) delete S.edges[eid]; }
  delete S.nodes[id]; delete S.formulas[id];
  if(S.sel?.id===id) S.sel=null;
  if(S.connSrc===id) S.connSrc=null;
  render();
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
  selNode(parentId); render();
}

function removeEdge(eid){
  const e=S.edges[eid]; if(!e) return;
  const pid=e.parentId; delete S.edges[eid];
  const rem=Object.values(S.edges).filter(e=>e.parentId===pid).sort((a,b)=>a.variable<b.variable?-1:1);
  rem.forEach((e,i)=>e.variable=String.fromCharCode(65+i));
  if(S.sel?.id===eid) S.sel=null;
  render();
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

cc.addEventListener('mousedown',ev=>{
  if(ev.target!==cc&&ev.target!==document.getElementById('canvas')&&!ev.target.closest('#svg-layer')) return;
  if(ev.button!==0) return;
  if(!ev.shiftKey){ S.sel=null; if(S.connMode) S.connSrc=null; renderInspector(); renderNodes(); }
  S.pan={sx:ev.clientX,sy:ev.clientY,ox:S.T.x,oy:S.T.y};
  cc.classList.add('panning');
});

document.addEventListener('mousemove',ev=>{
  if(S.drag){
    const dx=(ev.clientX-S.drag.sx)/S.T.s, dy=(ev.clientY-S.drag.sy)/S.T.s;
    const n=S.nodes[S.drag.id]; n.x=S.drag.ox+dx; n.y=S.drag.oy+dy;
    const card=document.querySelector(`.nc[data-id="${S.drag.id}"]`);
    if(card){card.style.left=n.x+'px';card.style.top=n.y+'px';}
    renderEdges();
    return;
  }
  if(S.pan){
    S.T.x=S.pan.ox+(ev.clientX-S.pan.sx); S.T.y=S.pan.oy+(ev.clientY-S.pan.sy);
    applyT();
  }
});

document.addEventListener('mouseup',()=>{
  S.drag=null; S.pan=null; cc.classList.remove('panning');
});

document.addEventListener('keydown',ev=>{
  if(ev.target.tagName==='INPUT'||ev.target.contentEditable==='true') return;
  if((ev.key==='Delete'||ev.key==='Backspace')&&S.sel){
    if(S.sel.type==='node') delNode(S.sel.id);
    else removeEdge(S.sel.id);
  }
  if(ev.key==='Escape'){
    clearSel();
    if(S.connMode){ S.connMode=false; S.connSrc=null; document.getElementById('bConn').classList.remove('active'); cc.classList.remove('connect-mode'); setHint(''); render(); }
  }
});

// ── TOOLBAR ───────────────────────────────────────────────────────────
document.getElementById('bAdd').addEventListener('click',addNode);

document.getElementById('bConn').addEventListener('click',()=>{
  S.connMode=!S.connMode; S.connSrc=null;
  document.getElementById('bConn').classList.toggle('active',S.connMode);
  cc.classList.toggle('connect-mode',S.connMode);
  setHint(S.connMode?'Connect mode: click a child node, then click the parent node.':'');
  render();
});

document.getElementById('bSave').addEventListener('click',()=>{
  const data={
    nodes:Object.values(S.nodes).map(n=>({id:n.id,name:n.name,x:n.x,y:n.y,baseValue:n.baseValue,modifier:n.modifier||0})),
    edges:Object.values(S.edges).map(e=>({id:e.id,childId:e.childId,parentId:e.parentId,variable:e.variable})),
    formulas:Object.entries(S.formulas).map(([nodeId,expression])=>({nodeId,expression})),
    _meta:{nextId:S.nextId},
  };
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.download='metric-tree.json'; a.click();
});

document.getElementById('bLoad').addEventListener('click',()=>document.getElementById('fileIn').click());
document.getElementById('fileIn').addEventListener('change',ev=>{
  const f=ev.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=e=>{
    try {
      const d=JSON.parse(e.target.result);
      S.nodes={}; S.edges={}; S.formulas={}; S.computed={}; S.sel=null;
      for(const n of d.nodes||[]) S.nodes[n.id]=n;
      for(const e of d.edges||[]) S.edges[e.id]=e;
      for(const f of d.formulas||[]) S.formulas[f.nodeId]=f.expression;
      if(d._meta?.nextId) S.nextId=d._meta.nextId;
      render();
    } catch(err){ alert('Failed to load: '+err.message); }
  };
  r.readAsText(f); ev.target.value='';
});

document.getElementById('bReset').addEventListener('click',()=>{
  if(confirm('Reset? All nodes and edges will be cleared.')){ S.nodes={}; S.edges={}; S.formulas={}; S.computed={}; S.sel=null; S.nextId=1; render(); }
});

// ── UTILS ─────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function ea(s){ return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;') }
function setHint(t){ document.getElementById('hint').textContent=t }

// ── INIT ──────────────────────────────────────────────────────────────
applyT(); render();
