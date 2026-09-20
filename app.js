const $=id=>document.getElementById(id);
const sb=supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let currentUser=null, currentProfile=null;
let scanStream=null;
let scanTargetMode='search'; // 'search' | 'newrc'
let currentRouteCard=null; // full joined record for the open detail view

const ROLE_STAGE_MAP={
  fitting:['fitting'], marking:['marking'], mpi_pmi:['mpi_pmi'], final_inspection:['final_inspection'],
  cmm:['cmm'], coating:['coating'], visual_inspection:['visual_inspection'], packing:['packing'],
  dispatch:['rfd','customer_pickup'], dock_audit:['dock_audit'], admin:null
};
const REWORK_ROLES=['admin','final_inspection','visual_inspection','packing','dock_audit'];
const REJECTION_ROLES=['admin','mpi_pmi','final_inspection','visual_inspection','dock_audit'];

let STAGES=[]; // cached process_stages rows

function toast(msg){const t=$('toast');t.textContent=msg;t.style.display='block';clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.style.display='none',3400)}
function val(id){return $(id).value.trim()}
function setv(id,v){$(id).value=v??''}
function fmtDt(iso){ if(!iso) return '—'; const d=new Date(iso); const p=n=>String(n).padStart(2,'0'); return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function show(el){el.classList.remove('hidden')} function hide(el){el.classList.add('hidden')}

/* ============================================================
   VIEW SWITCHING
   ============================================================ */
function showView(name){
  ['auth','profile-setup','pending','app'].forEach(v=>{
    const el=$('view-'+v);
    if(v===name) show(el); else hide(el);
  });
}
function showAppTab(name){
  document.querySelectorAll('.apptab').forEach(el=>el.classList.add('hidden'));
  document.querySelectorAll('[data-apptab]').forEach(b=>b.classList.remove('active'));
  $('apptab-'+name).classList.remove('hidden');
  const btn=document.querySelector(`[data-apptab="${name}"]`);
  if(btn) btn.classList.add('active');
}
document.querySelectorAll('[data-apptab]').forEach(b=>b.addEventListener('click',()=>showAppTab(b.getAttribute('data-apptab'))));
document.querySelectorAll('[data-authtab]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-authtab]').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  const t=b.getAttribute('data-authtab');
  $('authtab-signin').classList.toggle('hidden', t!=='signin');
  $('authtab-signup').classList.toggle('hidden', t!=='signup');
}));

/* ============================================================
   AUTH
   ============================================================ */
async function loadStages(){
  if(STAGES.length) return STAGES;
  const {data,error}=await sb.from('process_stages').select('*').order('sequence_order');
  if(!error) STAGES=data;
  return STAGES;
}
function stageName(id){ const s=STAGES.find(x=>x.id===id); return s?s.name:'—'; }
function stageCode(id){ const s=STAGES.find(x=>x.id===id); return s?s.code:null; }

async function refreshSessionState(){
  const {data:{session}}=await sb.auth.getSession();
  if(!session){ currentUser=null; currentProfile=null; showView('auth'); hide($('userBox')); return; }
  currentUser=session.user;
  await loadStages();
  const {data:profile}=await sb.from('profiles').select('*').eq('id',currentUser.id).maybeSingle();
  currentProfile=profile;
  if(!profile){ showView('profile-setup'); hide($('userBox')); return; }
  if(!profile.role){ showView('pending'); hide($('userBox')); return; }
  $('userName').textContent=profile.full_name;
  $('userRoleBadge').textContent=profile.role.toUpperCase();
  show($('userBox'));
  showView('app');
  showAppTab('dashboard');
  loadInbox();
}
sb.auth.onAuthStateChange((_evt,_session)=>{ refreshSessionState(); });

$('signInBtn').onclick=async()=>{
  const email=val('siEmail'), password=val('siPassword');
  if(!email||!password){toast('Enter email and password.');return}
  const {error}=await sb.auth.signInWithPassword({email,password});
  const box=$('authMsg'); box.classList.remove('hidden','ok','warn','err');
  if(error){ box.classList.add('err'); box.textContent=error.message; }
  else box.classList.add('hidden');
};
$('signUpBtn').onclick=async()=>{
  const email=val('suEmail'), password=val('suPassword');
  if(!email||password.length<6){toast('Enter a valid email and a password of at least 6 characters.');return}
  const {error}=await sb.auth.signUp({email,password});
  const box=$('authMsg'); box.classList.remove('hidden','ok','warn','err');
  if(error){ box.classList.add('err'); box.textContent=error.message; }
  else { box.classList.add('ok'); box.textContent='Account created. If email confirmation is enabled on this project, check your inbox, then sign in.'; }
};
$('signOutBtn').onclick=async()=>{ await sb.auth.signOut(); };

$('saveProfileBtn').onclick=async()=>{
  const full_name=val('psName'), employee_id=val('psEmpId');
  if(!full_name||!employee_id){toast('Enter both your name and Employee ID.');return}
  const {error}=await sb.from('profiles').insert({id:currentUser.id, full_name, employee_id, role:null});
  if(error){ toast('Could not save profile: '+error.message); return; }
  toast('Profile saved. Waiting for role assignment.');
  refreshSessionState();
};
$('refreshRoleBtn').onclick=refreshSessionState;

/* ============================================================
   QR SCANNER (reused approach from the ULTRA@503 Rework app)
   ============================================================ */
function isSecureCameraContext(){return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)}
async function startScanner(targetMode){
  scanTargetMode=targetMode;
  stopScanner();
  if(!isSecureCameraContext()){ toast('Live QR scanning requires the HTTPS website.'); return; }
  show($('scanner'));
  $('scanMsg').textContent='Starting rear camera…';
  try{
    scanStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
  }catch(e){
    try{ scanStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}); }
    catch(e2){ $('scanMsg').textContent='Camera unavailable: '+e2.message; return; }
  }
  const v=$('video'); v.srcObject=scanStream; await v.play();
  $('scanMsg').textContent='Hold the Route Card QR inside the box.';
  window.__scanBusy=false;
  requestAnimationFrame(scanLoop);
}
async function decodeScanFrame(v){
  if(!v.videoWidth) return null;
  if('BarcodeDetector' in window){
    try{
      if(!window.__qrDetector) window.__qrDetector=new BarcodeDetector({formats:['qr_code']});
      const found=await window.__qrDetector.detect(v);
      if(found&&found.length) return found[0].rawValue;
    }catch(e){}
  }
  if(!window.jsQR) return null;
  const c=$('scanCanvas'), ctx=c.getContext('2d',{willReadFrequently:true});
  c.width=v.videoWidth; c.height=v.videoHeight;
  ctx.drawImage(v,0,0,c.width,c.height);
  const img=ctx.getImageData(0,0,c.width,c.height);
  const code=jsQR(img.data,img.width,img.height,{inversionAttempts:'attemptBoth'});
  return code?code.data:null;
}
async function scanLoop(){
  if(!scanStream) return;
  if(!window.__scanBusy){
    window.__scanBusy=true;
    try{
      const raw=await decodeScanFrame($('video'));
      if(raw){ stopScanner(); onQrScanned(raw); return; }
    } finally{ window.__scanBusy=false; }
  }
  setTimeout(()=>requestAnimationFrame(scanLoop),120);
}
function stopScanner(){ if(scanStream){scanStream.getTracks().forEach(t=>t.stop());scanStream=null} $('video').srcObject=null; hide($('scanner')); }
$('scanBtn').onclick=()=>startScanner('search');
$('newrcScanBtn').onclick=()=>startScanner('newrc');
$('stopScan').onclick=stopScanner;

function parseRouteCardQR(raw){
  raw=(raw||'').replace(/^id\s*=\s*"[^"]*"\s*/i,'').trim();
  const p=raw.split('?').map(x=>x.replace(/^['"]|['"]$/g,'').trim());
  if(p.length<10||!p[3]) return null;
  const unit=(p[14]||'NOS').trim();
  return {
    partNumber:p[3], poNo:p[7], poLine:p[8], poQty:p[9],
    heatNo:p[10], ucBatch:p[12]||p[11]||'', batchQty:p[13], unit, raw
  };
}
function onQrScanned(raw){
  const parsed=parseRouteCardQR(raw);
  if(scanTargetMode==='newrc'){
    if(!parsed){ toast('QR detected, but its format was not recognized. Enter fields manually.'); return; }
    setv('nrcPartNo',parsed.partNumber);
    setv('nrcPoNo',parsed.poNo);
    setv('nrcUcBatch',parsed.ucBatch);
    setv('nrcHeatBatch',parsed.heatNo);
    setv('nrcQty', parsed.batchQty);
    if(!val('nrcPoQty')) setv('nrcPoQty', parsed.poQty);
    window.__lastScannedQr=raw;
    toast('QR data loaded — please verify the fields.');
  } else {
    toast('QR scanned — searching…');
    if(parsed){
      $('searchBox').value=parsed.partNumber;
      runSearch(parsed);
    } else {
      $('searchBox').value=raw;
      runSearch();
    }
  }
}

/* ============================================================
   SEARCH
   ============================================================ */
async function runSearch(parsedQr){
  const q=val('searchBox');
  const box=$('searchResults');
  box.innerHTML='<p class="empty-note">Searching…</p>';
  let query=sb.from('route_cards').select('*, pos(po_number, customer_name, part_id, parts(part_number, description))');

  if(parsedQr){
    query=query.or(`uc_batch.ilike.%${parsedQr.ucBatch}%,heat_batch.ilike.%${parsedQr.heatNo}%,route_card_no.ilike.%${q}%`);
  } else if(q){
    // try route card fields directly, plus a join filter for part number / po number
    const {data:partMatches}=await sb.from('parts').select('id').ilike('part_number',`%${q}%`);
    const {data:poMatches}=await sb.from('pos').select('id').ilike('po_number',`%${q}%`);
    const partIds=(partMatches||[]).map(p=>p.id);
    const poIds=(poMatches||[]).map(p=>p.id);
    let orParts=[`uc_batch.ilike.%${q}%`,`heat_batch.ilike.%${q}%`,`route_card_no.ilike.%${q}%`,`internal_tracking_id.ilike.%${q}%`];
    if(poIds.length) orParts.push(`po_id.in.(${poIds.join(',')})`);
    query=query.or(orParts.join(','));
    // Note: part-number matches are resolved via the PO's part_id below after fetch, since
    // route_cards has no direct part_id column (it goes through pos.part_id).
    window.__searchPartIds=partIds;
  } else {
    box.innerHTML='<p class="empty-note">Enter a search term or scan a QR code.</p>';
    return;
  }

  const {data,error}=await query.order('created_at',{ascending:false}).limit(30);
  let results=data||[];
  if(!parsedQr && q && window.__searchPartIds && window.__searchPartIds.length){
    const {data:extra}=await sb.from('route_cards').select('*, pos(po_number, customer_name, part_id, parts(part_number, description))').in('pos.part_id',window.__searchPartIds).limit(30);
    // supabase-js can't filter on a joined table directly this way in all versions; fall back to client-side merge
    (extra||[]).forEach(r=>{ if(!results.find(x=>x.id===r.id)) results.push(r); });
  }
  if(error){ box.innerHTML=`<p class="empty-note">Search failed: ${error.message}</p>`; return; }
  renderResultList(box, results, 'No matching Route Cards found.');
}
$('searchBtn').onclick=()=>runSearch();
$('searchBox').addEventListener('keydown',e=>{ if(e.key==='Enter') runSearch(); });

function renderResultList(container, rows, emptyMsg){
  if(!rows.length){ container.innerHTML=`<p class="empty-note">${emptyMsg}</p>`; return; }
  container.innerHTML='';
  rows.forEach(rc=>{
    const part=rc.pos?.parts;
    const div=document.createElement('div');
    div.className='result-item';
    div.innerHTML=`
      <div>
        <div class="rmain">${part?part.part_number:'—'} — ${rc.route_card_no}</div>
        <div class="rsub">PO ${rc.pos?.po_number||'—'} · UC ${rc.uc_batch||'—'} · Heat ${rc.heat_batch||'—'} · Qty ${rc.qty}</div>
      </div>
      <span class="rstage">${stageName(rc.current_stage_id)}</span>
    `;
    div.onclick=()=>openRouteCard(rc.id);
    container.appendChild(div);
  });
}

/* ============================================================
   INBOX — handovers awaiting receipt matching my role
   ============================================================ */
async function loadInbox(){
  const box=$('inboxList');
  box.innerHTML='<p class="empty-note">Loading…</p>';
  const {data,error}=await sb.from('handovers')
    .select('*, route_cards(route_card_no, uc_batch, heat_batch, qty, pos(po_number, parts(part_number)))')
    .eq('status','awaiting_receipt')
    .order('released_at',{ascending:false});
  if(error){ box.innerHTML=`<p class="empty-note">Could not load inbox: ${error.message}</p>`; return; }
  const mine = currentProfile.role==='admin' ? data : data.filter(h=>{
    const code=stageCode(h.to_stage_id);
    const allowed=ROLE_STAGE_MAP[currentProfile.role];
    return allowed===null || (allowed && allowed.includes(code));
  });
  $('inboxCount').textContent=mine.length;
  if(!mine.length){ box.innerHTML='<p class="empty-note">Nothing awaiting your receipt right now.</p>'; return; }
  box.innerHTML='';
  mine.forEach(h=>{
    const rc=h.route_cards, part=rc?.pos?.parts;
    const div=document.createElement('div');
    div.className='result-item';
    div.innerHTML=`
      <div>
        <div class="rmain">${part?part.part_number:'—'} — ${rc?.route_card_no||'—'}</div>
        <div class="rsub">Qty ${h.quantity} → ${stageName(h.to_stage_id)} · released ${fmtDt(h.released_at)}</div>
      </div>
      <span class="rstage">Receive</span>
    `;
    div.onclick=()=>openRouteCard(h.route_card_id);
    box.appendChild(div);
  });
}

/* ============================================================
   NEW ROUTE CARD — find-or-create Part / PO, then create Route Card
   ============================================================ */
$('createRcBtn').onclick=async()=>{
  const msg=$('newrcMsg'); msg.classList.remove('hidden','ok','warn','err');
  const partNo=val('nrcPartNo'), poNo=val('nrcPoNo'), rcNo=val('nrcRouteCardNo'), qty=parseFloat(val('nrcQty'));
  if(!partNo||!poNo||!rcNo||!qty){ msg.classList.add('err'); msg.textContent='Part Number, PO Number, Route Card No. and Quantity are required.'; return; }

  try{
    let {data:part}=await sb.from('parts').select('*').eq('part_number',partNo).maybeSingle();
    if(!part){
      const {data:np,error:pe}=await sb.from('parts').insert({part_number:partNo, description:val('nrcPartDesc')||null}).select().single();
      if(pe) throw pe; part=np;
    }
    let {data:po}=await sb.from('pos').select('*').eq('po_number',poNo).maybeSingle();
    if(!po){
      const poQty=parseFloat(val('nrcPoQty'))||qty;
      const {data:npo,error:poe}=await sb.from('pos').insert({po_number:poNo, part_id:part.id, customer_name:val('nrcCustomer')||null, po_qty:poQty, created_by:currentUser.id}).select().single();
      if(poe) throw poe; po=npo;
    }
    const {data:rc,error:rce}=await sb.from('route_cards').insert({
      route_card_no:rcNo, po_id:po.id, uc_batch:val('nrcUcBatch')||null, heat_batch:val('nrcHeatBatch')||null,
      qty, qr_payload:window.__lastScannedQr||null, created_by:currentUser.id
    }).select().single();
    if(rce) throw rce;

    msg.classList.add('ok'); msg.textContent=`Route Card ${rcNo} created.`;
    toast('Route Card created.');
    ['nrcPartNo','nrcPartDesc','nrcPoNo','nrcCustomer','nrcPoQty','nrcRouteCardNo','nrcUcBatch','nrcHeatBatch','nrcQty'].forEach(id=>setv(id,''));
    window.__lastScannedQr=null;
    openRouteCard(rc.id);
  }catch(e){
    msg.classList.add('err'); msg.textContent='Could not create Route Card: '+e.message;
  }
};

/* ============================================================
   PO DASHBOARD
   ============================================================ */
$('loadPoDashBtn').onclick=loadPoDashboard;
async function loadPoDashboard(){
  const box=$('poDashList');
  box.innerHTML='<p class="empty-note">Loading…</p>';
  const {data,error}=await sb.from('po_dashboard').select('*').order('po_number');
  if(error){ box.innerHTML=`<p class="empty-note">Could not load: ${error.message}</p>`; return; }
  if(!data.length){ box.innerHTML='<p class="empty-note">No POs yet.</p>'; return; }
  box.innerHTML='';
  data.forEach(po=>{
    const div=document.createElement('div');
    div.className='result-item';
    div.innerHTML=`
      <div>
        <div class="rmain">PO ${po.po_number}</div>
        <div class="rsub">PO Qty ${po.po_qty} · Active ${po.qty_active_route_cards} · Completed ${po.qty_completed_route_cards} · Scrapped ${po.qty_scrapped_route_cards} · ${po.route_card_count} Route Card(s)</div>
      </div>
      <span class="rstage">View</span>
    `;
    div.onclick=async()=>{
      showAppTab('dashboard');
      $('searchBox').value=po.po_number;
      await runSearch();
    };
    box.appendChild(div);
  });
}

/* ============================================================
   ROUTE CARD DETAIL
   ============================================================ */
$('backToDashboard').onclick=()=>showAppTab('dashboard');

async function openRouteCard(id){
  showAppTab('rcdetail');
  $('rcHeader').innerHTML='<p class="empty-note">Loading…</p>';
  $('rcActions').innerHTML=''; $('rcFormArea').innerHTML=''; $('rcTimeline').innerHTML=''; $('rcAwaiting').innerHTML='';

  const {data:rc,error}=await sb.from('route_cards').select('*, pos(po_number, customer_name, po_qty, part_id, parts(part_number, description))').eq('id',id).single();
  if(error){ $('rcHeader').innerHTML=`<p class="empty-note">Could not load Route Card: ${error.message}</p>`; return; }
  currentRouteCard=rc;
  renderRcHeader(rc);
  renderRcActions(rc);
  loadRcAwaiting(rc.id);
  loadRcTimeline(rc.id);
}

function renderRcHeader(rc){
  const part=rc.pos?.parts;
  $('rcHeader').innerHTML=`
    <div class="rc-title">${part?part.part_number:'—'} — ${rc.route_card_no}</div>
    <div class="rc-grid">
      <div><div class="k">PO No.:</div> <div class="v">${rc.pos?.po_number||'—'}</div></div>
      <div><div class="k">Customer:</div> <div class="v">${rc.pos?.customer_name||'—'}</div></div>
      <div><div class="k">UC Batch:</div> <div class="v">${rc.uc_batch||'—'}</div></div>
      <div><div class="k">Heat Batch:</div> <div class="v">${rc.heat_batch||'—'}</div></div>
      <div><div class="k">Quantity:</div> <div class="v">${rc.qty}</div></div>
      <div><div class="k">Internal ID:</div> <div class="v">${rc.internal_tracking_id||'—'}</div></div>
      <div><div class="k">Current Stage:</div> <div class="v">${stageName(rc.current_stage_id)}</div></div>
      <div><div class="k">Status:</div> <div class="v"><span class="status-pill ${rc.status}">${rc.status}</span></div></div>
    </div>
  `;
}

function renderRcActions(rc){
  const role=currentProfile.role;
  const buttons=[];
  const allowedStages=ROLE_STAGE_MAP[role];
  if(role==='admin' || (allowedStages && allowedStages.length)){
    buttons.push(['Complete Stage','primary',()=>renderStageForm(rc)]);
  }
  buttons.push(['Release / Handover','secondary',()=>renderHandoverForm(rc)]);
  if(REWORK_ROLES.includes(role)) buttons.push(['Raise Rework','secondary',()=>renderReworkForm(rc)]);
  if(REJECTION_ROLES.includes(role)) buttons.push(['Report Rejection','danger',()=>renderRejectionForm(rc)]);

  const grid=$('rcActions'); grid.innerHTML='';
  buttons.forEach(([label,cls,fn])=>{
    const b=document.createElement('button'); b.className=cls; b.textContent=label; b.onclick=fn; grid.appendChild(b);
  });
}

/* ---- photo upload helper, used by the forms below ---- */
function photoPickerHtml(inputId){
  return `<div class="photo-row"><label>Photos (optional)<input type="file" id="${inputId}" accept="image/*" multiple></label><div class="photo-thumbs" id="${inputId}-thumbs"></div></div>`;
}
function wirePhotoPreview(inputId){
  $(inputId).addEventListener('change',()=>{
    const thumbs=$(inputId+'-thumbs'); thumbs.innerHTML='';
    [...$(inputId).files].forEach(f=>{ const img=document.createElement('img'); img.src=URL.createObjectURL(f); thumbs.appendChild(img); });
  });
}
async function uploadAndLinkPhotos(inputId, parentTable, parentId){
  const files=[...($(inputId)?.files||[])];
  for(const file of files){
    const path=`${parentTable}/${parentId}/${Date.now()}_${file.name}`;
    const {error:upErr}=await sb.storage.from('attachments').upload(path,file);
    if(upErr){ toast('Photo upload failed: '+upErr.message); continue; }
    await sb.from('attachments').insert({parent_table:parentTable, parent_id:parentId, storage_path:path, uploaded_by:currentUser.id});
  }
}

/* ---- Complete Stage ---- */
function renderStageForm(rc){
  const role=currentProfile.role;
  const options = role==='admin' ? STAGES : STAGES.filter(s=>(ROLE_STAGE_MAP[role]||[]).includes(s.code));
  $('rcFormArea').innerHTML=`
    <div class="form-card">
      <h4>Complete Stage</h4>
      <div class="grid two">
        <label>Stage<select id="stgStage">${options.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></label>
        <label>Quantity<input id="stgQty" type="number" step="0.001" value="${rc.qty}"></label>
      </div>
      <label>Remarks<textarea id="stgRemarks" placeholder="Optional"></textarea></label>
      ${photoPickerHtml('stgPhotos')}
      <div class="actions"><button class="primary" id="stgSubmit">Submit</button><button class="secondary" id="stgCancel">Cancel</button></div>
      <div id="stgMsg" class="parse-msg hidden"></div>
    </div>`;
  wirePhotoPreview('stgPhotos');
  $('stgCancel').onclick=()=>{$('rcFormArea').innerHTML=''};
  $('stgSubmit').onclick=async()=>{
    const stage_id=parseInt(val('stgStage')), quantity=parseFloat(val('stgQty'));
    if(!quantity||quantity<=0){toast('Enter a valid quantity.');return}
    const {data,error}=await sb.from('stage_transactions').insert({
      route_card_id:rc.id, stage_id, quantity, responsible_user_id:currentUser.id, remarks:val('stgRemarks')||null
    }).select().single();
    const msg=$('stgMsg'); msg.classList.remove('hidden','ok','err');
    if(error){ msg.classList.add('err'); msg.textContent=error.message; return; }
    await uploadAndLinkPhotos('stgPhotos','stage_transactions',data.id);
    msg.classList.add('ok'); msg.textContent='Stage completed.';
    toast('Stage completed.');
    openRouteCard(rc.id);
  };
}

/* ---- Release / Handover ---- */
function renderHandoverForm(rc){
  $('rcFormArea').innerHTML=`
    <div class="form-card">
      <h4>Release / Handover</h4>
      <div class="grid two">
        <label>Quantity<input id="hoQty" type="number" step="0.001" value="${rc.qty}"></label>
        <label>To Stage<select id="hoToStage">${STAGES.map(s=>`<option value="${s.id}" ${s.id===rc.current_stage_id?'selected':''}>${s.name}</option>`).join('')}</select></label>
        <label>Helper / Carrier<input id="hoHelper" placeholder="Optional"></label>
      </div>
      <label>Remarks<textarea id="hoRemarks" placeholder="Optional"></textarea></label>
      ${photoPickerHtml('hoPhotos')}
      <div class="actions"><button class="primary" id="hoSubmit">Release</button><button class="secondary" id="hoCancel">Cancel</button></div>
      <div id="hoMsg" class="parse-msg hidden"></div>
    </div>`;
  wirePhotoPreview('hoPhotos');
  $('hoCancel').onclick=()=>{$('rcFormArea').innerHTML=''};
  $('hoSubmit').onclick=async()=>{
    const quantity=parseFloat(val('hoQty'));
    if(!quantity||quantity<=0){toast('Enter a valid quantity.');return}
    const {data,error}=await sb.from('handovers').insert({
      route_card_id:rc.id, quantity, from_stage_id:rc.current_stage_id, to_stage_id:parseInt(val('hoToStage')),
      released_by:currentUser.id, helper_carrier:val('hoHelper')||null, remarks:val('hoRemarks')||null
    }).select().single();
    const msg=$('hoMsg'); msg.classList.remove('hidden','ok','err');
    if(error){ msg.classList.add('err'); msg.textContent=error.message; return; }
    await uploadAndLinkPhotos('hoPhotos','handovers',data.id);
    msg.classList.add('ok'); msg.textContent='Released — awaiting receipt.';
    toast('Handover released.');
    openRouteCard(rc.id);
  };
}

/* ---- Receive ---- */
async function loadRcAwaiting(routeCardId){
  const box=$('rcAwaiting');
  const {data,error}=await sb.from('handovers').select('*').eq('route_card_id',routeCardId).eq('status','awaiting_receipt').order('released_at',{ascending:false});
  if(error){ box.innerHTML=`<p class="empty-note">${error.message}</p>`; return; }
  if(!data.length){ box.innerHTML='<p class="empty-note">Nothing awaiting receipt.</p>'; return; }
  box.innerHTML='';
  data.forEach(h=>{
    const div=document.createElement('div');
    div.className='result-item';
    div.innerHTML=`<div><div class="rmain">Qty ${h.quantity} → ${stageName(h.to_stage_id)}</div><div class="rsub">Released ${fmtDt(h.released_at)}${h.helper_carrier?' via '+h.helper_carrier:''}</div></div><span class="rstage">Receive</span>`;
    div.onclick=()=>renderReceiveForm(h);
    box.appendChild(div);
  });
}
function renderReceiveForm(handover){
  $('rcFormArea').innerHTML=`
    <div class="form-card">
      <h4>Confirm Receipt</h4>
      <label>Quantity Received<input id="rcvQty" type="number" step="0.001" value="${handover.quantity}"></label>
      <label>Remarks<textarea id="rcvRemarks" placeholder="Optional"></textarea></label>
      <div class="actions"><button class="primary" id="rcvSubmit">Confirm Receipt</button><button class="secondary" id="rcvCancel">Cancel</button></div>
      <div id="rcvMsg" class="parse-msg hidden"></div>
    </div>`;
  $('rcvCancel').onclick=()=>{$('rcFormArea').innerHTML=''};
  $('rcvSubmit').onclick=async()=>{
    const quantity_received=parseFloat(val('rcvQty'));
    const {error}=await sb.from('receipts').insert({
      handover_id:handover.id, received_by:currentUser.id, quantity_received, remarks:val('rcvRemarks')||null
    });
    const msg=$('rcvMsg'); msg.classList.remove('hidden','ok','err');
    if(error){ msg.classList.add('err'); msg.textContent=error.message; return; }
    msg.classList.add('ok'); msg.textContent='Receipt confirmed.';
    toast('Receipt confirmed.');
    openRouteCard(currentRouteCard.id);
    loadInbox();
  };
}

/* ---- Rework ---- */
function renderReworkForm(rc){
  $('rcFormArea').innerHTML=`
    <div class="form-card">
      <h4>Raise Rework</h4>
      <div class="grid two">
        <label>Quantity<input id="rwQty" type="number" step="0.001" value="${rc.qty}"></label>
        <label>Stage<select id="rwStage">${STAGES.map(s=>`<option value="${s.id}" ${s.id===rc.current_stage_id?'selected':''}>${s.name}</option>`).join('')}</select></label>
      </div>
      <label>Reason<textarea id="rwReason" placeholder="Required"></textarea></label>
      ${photoPickerHtml('rwPhotos')}
      <div class="actions"><button class="primary" id="rwSubmit">Raise Rework</button><button class="secondary" id="rwCancel">Cancel</button></div>
      <div id="rwMsg" class="parse-msg hidden"></div>
    </div>`;
  wirePhotoPreview('rwPhotos');
  $('rwCancel').onclick=()=>{$('rcFormArea').innerHTML=''};
  $('rwSubmit').onclick=async()=>{
    const quantity=parseFloat(val('rwQty')), reason=val('rwReason');
    if(!quantity||quantity<=0||!reason){toast('Quantity and Reason are required.');return}
    const {data,error}=await sb.from('rework_events').insert({
      route_card_id:rc.id, stage_id:parseInt(val('rwStage')), quantity, reason, raised_by:currentUser.id
    }).select().single();
    const msg=$('rwMsg'); msg.classList.remove('hidden','ok','err');
    if(error){ msg.classList.add('err'); msg.textContent=error.message; return; }
    await uploadAndLinkPhotos('rwPhotos','rework_events',data.id);
    msg.classList.add('ok'); msg.textContent='Rework raised.';
    toast('Rework raised.');
    openRouteCard(rc.id);
  };
}
async function progressRework(eventId, action){
  const patch = action==='complete'
    ? {status:'completed', completed_at:new Date().toISOString()}
    : {status:'verified', verified_by:currentUser.id, verified_at:new Date().toISOString()};
  const {error}=await sb.from('rework_events').update(patch).eq('id',eventId);
  if(error){ toast('Could not update rework: '+error.message); return; }
  toast(action==='complete'?'Rework marked completed.':'Rework verified.');
  openRouteCard(currentRouteCard.id);
}

/* ---- Rejection ---- */
function renderRejectionForm(rc){
  $('rcFormArea').innerHTML=`
    <div class="form-card">
      <h4>Report Rejection</h4>
      <div class="grid two">
        <label>Quantity<input id="rjQty" type="number" step="0.001" value="${rc.qty}"></label>
        <label>Stage<select id="rjStage">${STAGES.map(s=>`<option value="${s.id}" ${s.id===rc.current_stage_id?'selected':''}>${s.name}</option>`).join('')}</select></label>
        <label>Scrap Location<input id="rjScrap" placeholder="Optional"></label>
      </div>
      <label>Reason<textarea id="rjReason" placeholder="Required"></textarea></label>
      ${photoPickerHtml('rjPhotos')}
      <div class="actions"><button class="danger" id="rjSubmit">Report Rejection</button><button class="secondary" id="rjCancel">Cancel</button></div>
      <div id="rjMsg" class="parse-msg hidden"></div>
    </div>`;
  wirePhotoPreview('rjPhotos');
  $('rjCancel').onclick=()=>{$('rcFormArea').innerHTML=''};
  $('rjSubmit').onclick=async()=>{
    const quantity=parseFloat(val('rjQty')), reason=val('rjReason');
    if(!quantity||quantity<=0||!reason){toast('Quantity and Reason are required.');return}
    const {data,error}=await sb.from('rejection_events').insert({
      route_card_id:rc.id, stage_id:parseInt(val('rjStage')), quantity, reason,
      reported_by:currentUser.id, scrap_location:val('rjScrap')||null
    }).select().single();
    const msg=$('rjMsg'); msg.classList.remove('hidden','ok','err');
    if(error){ msg.classList.add('err'); msg.textContent=error.message; return; }
    await uploadAndLinkPhotos('rjPhotos','rejection_events',data.id);
    msg.classList.add('ok'); msg.textContent='Rejection reported.';
    toast('Rejection reported.');
    openRouteCard(rc.id);
  };
}

/* ============================================================
   TIMELINE — merges all event tables for one route card
   ============================================================ */
async function loadRcTimeline(routeCardId){
  const box=$('rcTimeline');
  box.innerHTML='<p class="empty-note">Loading…</p>';

  const profileName=async(id)=>{ if(!id) return '—'; const {data}=await sb.from('profiles').select('full_name').eq('id',id).maybeSingle(); return data?.full_name||'—'; };

  const [st,ho,rc2,rw,rj]=await Promise.all([
    sb.from('stage_transactions').select('*').eq('route_card_id',routeCardId),
    sb.from('handovers').select('*').eq('route_card_id',routeCardId),
    sb.from('receipts').select('*, handovers!inner(route_card_id)').eq('handovers.route_card_id',routeCardId),
    sb.from('rework_events').select('*').eq('route_card_id',routeCardId),
    sb.from('rejection_events').select('*').eq('route_card_id',routeCardId),
  ]);

  const items=[];
  for(const r of (st.data||[])) items.push({t:r.created_at,type:'stage',cls:'stage',title:`Stage Completed: ${stageName(r.stage_id)}`,detail:`Qty ${r.quantity}${r.remarks?' — '+r.remarks:''}`,who:await profileName(r.responsible_user_id),id:r.id,table:'stage_transactions'});
  for(const r of (ho.data||[])) items.push({t:r.released_at,type:'handover',cls:'stage',title:`Released → ${stageName(r.to_stage_id)} (${r.status})`,detail:`Qty ${r.quantity}${r.helper_carrier?' via '+r.helper_carrier:''}${r.remarks?' — '+r.remarks:''}`,who:await profileName(r.released_by),id:r.id,table:'handovers'});
  for(const r of (rc2.data||[])) items.push({t:r.received_at,type:'receipt',cls:'stage',title:'Receipt Confirmed',detail:`Qty ${r.quantity_received}${r.remarks?' — '+r.remarks:''}`,who:await profileName(r.received_by),id:r.id,table:'receipts'});
  for(const r of (rw.data||[])){
    items.push({t:r.raised_at,type:'rework',cls:'rework',title:`Rework Raised (${stageName(r.stage_id)})`,detail:`Qty ${r.quantity} — ${r.reason}`,who:await profileName(r.raised_by),id:r.id,table:'rework_events',reworkEvent:r});
    if(r.completed_at) items.push({t:r.completed_at,type:'rework',cls:'rework',title:'Rework Completed',detail:`Qty ${r.quantity}`,who:'—',id:r.id+'-c',table:'rework_events'});
    if(r.verified_at) items.push({t:r.verified_at,type:'rework',cls:'rework',title:'Rework Verified',detail:`Qty ${r.quantity}`,who:await profileName(r.verified_by),id:r.id+'-v',table:'rework_events'});
  }
  for(const r of (rj.data||[])) items.push({t:r.reported_at,type:'rejection',cls:'rejection',title:`Rejected → Scrap (${stageName(r.stage_id)})`,detail:`Qty ${r.quantity} — ${r.reason}${r.scrap_location?' · '+r.scrap_location:''}`,who:await profileName(r.reported_by),id:r.id,table:'rejection_events'});

  items.sort((a,b)=>new Date(b.t)-new Date(a.t));

  if(!items.length){ box.innerHTML='<p class="empty-note">No events recorded yet.</p>'; return; }
  box.innerHTML='';
  const openRework=(rw.data||[]).filter(r=>r.status!=='verified');
  items.forEach(it=>{
    const div=document.createElement('div');
    div.className='tl-item '+it.cls;
    div.innerHTML=`<div class="tl-type">${it.type}</div><div class="tl-detail">${it.title}</div><div class="tl-detail">${it.detail}</div><div class="tl-meta">${it.who} · ${fmtDt(it.t)}</div>`;
    box.appendChild(div);
  });

  // inline rework progression controls for anyone authorized
  if(REWORK_ROLES.includes(currentProfile.role) && openRework.length){
    const wrap=document.createElement('div');
    wrap.className='form-card';
    wrap.innerHTML='<h4>Progress Open Rework</h4>';
    openRework.forEach(r=>{
      const row=document.createElement('div');
      row.className='actions';
      const label=document.createElement('span');
      label.textContent=`Qty ${r.quantity} (${r.status}) — `;
      row.appendChild(label);
      if(r.status==='raised'){ const b=document.createElement('button'); b.className='secondary'; b.textContent='Mark Completed'; b.onclick=()=>progressRework(r.id,'complete'); row.appendChild(b); }
      if(r.status==='completed'){ const b=document.createElement('button'); b.className='primary'; b.textContent='Verify'; b.onclick=()=>progressRework(r.id,'verify'); row.appendChild(b); }
      wrap.appendChild(row);
    });
    box.parentElement.insertBefore(wrap, box);
  }
}

/* ============================================================
   INIT
   ============================================================ */
refreshSessionState();
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
