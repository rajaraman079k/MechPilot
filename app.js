const $ = (s) => document.querySelector(s);
let currentReport = null;
const examples = {
  cnc: { asset:'CNC machining centre', criticality:'medium', objective:'Improve surface finish and reduce tool wear', symptoms:'After replacing the tool holder with a longer overhang, chatter marks appear on the finished surface above 1,800 rpm. Spindle load is about 12% higher than the previous tool setup, but no alarm is active. The insert is new and the workpiece material and programmed feed have not changed. How should we isolate the root cause before scrapping more parts?' },
  hydraulic: { asset:'Hydraulic power unit', criticality:'high', objective:'Minimise downtime and restore production safely', symptoms:'During a production cycle, hydraulic pressure dropped from its usual 120 bar to about 70 bar. Oil temperature is rising, and fluid is visible around a hose coupling. The operator heard a brief hiss. What immediate safety actions and evidence-led diagnostic checks are appropriate?' },
  pump: { asset:'Rotating equipment / pump', criticality:'medium', objective:'Find the root cause before replacing parts', symptoms:'A centrifugal pump has developed higher vibration and intermittent bearing noise over two days. Flow has decreased by roughly 10% at the same indicated speed. Suction pressure is not yet recorded and the last alignment check was six months ago. Rank possible causes and identify the best measurements to distinguish them.' }
};
const agentNames = ['Fault diagnosis','Maintenance planner','Efficiency optimizer','Safety & quality reviewer'];
const agentDetails = ['Hypotheses & evidence','Ordered maintenance actions','Metrics & trade-offs','Independent safety gate'];

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  $('#themeIcon').textContent = dark ? '☀' : '☾';
  $('#themeToggle').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  $('#themeToggle').title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#0c120e' : '#f4f5f0';
  try { localStorage.setItem('mechpilot-theme', theme); } catch {}
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem('mechpilot-theme') || 'light'; } catch {}
setTheme(savedTheme);
$('#themeToggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('#menuButton').addEventListener('click', () => {
  const nav = $('#mobileNav');
  nav.hidden = !nav.hidden;
  $('#menuButton').textContent = nav.hidden ? '☰' : '×';
});
document.querySelectorAll('#mobileNav a').forEach(a=>a.addEventListener('click',()=>{ $('#mobileNav').hidden=true; $('#menuButton').textContent='☰'; }));

async function checkBackend() {
  const badge = $('#backendStatus');
  try {
    const r = await fetch('/api/health', { cache:'no-store' });
    const d = await r.json();
    if (r.ok && d.configured && d.valid === true) {
      badge.className = 'backend-status ok';
      badge.innerHTML = '<i></i><span>AI SYSTEM VERIFIED</span>';
      badge.title = `OpenRouter key verified · ${d.model || 'OpenRouter'}` + (typeof d.limitRemaining === 'number' ? ` · remaining quota: ${d.limitRemaining}` : '');
    } else if (d.configured && d.valid === false) {
      badge.className = 'backend-status bad';
      badge.innerHTML = '<i></i><span>API KEY REJECTED</span>';
      badge.title = d.message || 'OpenRouter rejected the server key';
    } else if (d.configured && d.valid === null) {
      badge.className = 'backend-status';
      badge.innerHTML = '<i></i><span>VERIFY UNAVAILABLE</span>';
      badge.title = d.message || 'Could not verify with OpenRouter';
    } else {
      badge.className = 'backend-status bad';
      badge.innerHTML = '<i></i><span>BACKEND SETUP NEEDED</span>';
      badge.title = d.message || 'Backend not configured';
    }
  } catch {
    badge.className = 'backend-status bad';
    badge.innerHTML = '<i></i><span>SERVER UNREACHABLE</span>';
    badge.title = 'Could not reach the MechPilot backend';
  }
}
checkBackend();

$('#symptoms').addEventListener('input', e => $('#charCount').textContent = `${e.target.value.length.toLocaleString()} / 6000`);
document.querySelectorAll('[data-example]').forEach(btn => btn.addEventListener('click', () => {
  const e = examples[btn.dataset.example];
  $('#asset').value=e.asset; $('#criticality').value=e.criticality; $('#objective').value=e.objective;
  $('#symptoms').value=e.symptoms; $('#charCount').textContent=`${e.symptoms.length} / 6000`;
  $('#symptoms').focus();
}));
function setError(msg) {
  const e=$('#inlineError');e.hidden=!msg;e.textContent=msg||'';
}
function setProgress(index, status, detail) {
  const all=[...document.querySelectorAll('.loading-stage')];
  all.forEach((el,i)=>{
    el.classList.toggle('active',i===index&&status==='active');
    el.classList.toggle('done',i<index||(i===index&&status==='done'));
    el.querySelector('i').textContent=(i<index||(i===index&&status==='done'))?'✓':(i===index&&status==='active'?'◌':'○');
  });
  const stageDone=status==='done'?index+1:index;
  const percent=status==='done'?Math.round((index+1)/4*100):Math.round(index/4*100+4);
  $('#loadingProgress').style.width=percent+'%';$('#loadingPercent').textContent=percent+'%';
  $('#loadingStep').textContent=status==='done'?(index===3?'FINALISING REPORT':'STAGE '+(index+1)+' COMPLETE'):'STAGE '+(index+1)+' OF 4';
  $('#loadingMessage').textContent=detail||agentDetails[index]||'Working through the case…';
}
function openLoading() {
  $('#loadingOverlay').hidden=false;document.body.style.overflow='hidden';
  $('#loadingProgress').style.width='0%';$('#loadingPercent').textContent='0%';$('#loadingStep').textContent='INITIALISING';
  $('#loadingMessage').textContent='Preparing your case file…';
  document.querySelectorAll('.loading-stage').forEach(el=>{el.classList.remove('active','done');el.querySelector('i').textContent='○';});
}
function closeLoading() { $('#loadingOverlay').hidden=true;document.body.style.overflow=''; }
function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function arr(v) { return Array.isArray(v) ? v : (v ? [String(v)] : []); }
function renderList(items) { return `<ul class="item-list">${arr(items).map(x=>`<li>${esc(typeof x==='string'?x:JSON.stringify(x))}</li>`).join('')}</ul>`; }
function fieldHtml(obj, exclude=[]) {
  if (!obj || typeof obj!=='object') return '';
  return Object.entries(obj).filter(([k,v])=>!exclude.includes(k)&&v!==undefined&&v!==null&&v!=='').map(([k,v])=>{
    const label=k.replace(/_/g,' ');
    if(Array.isArray(v))return `<div class="finding"><strong>${esc(label)}</strong>${renderList(v)}</div>`;
    if(v && typeof v==='object')return `<div class="finding"><strong>${esc(label)}</strong>${fieldHtml(v)}</div>`;
    return `<div class="finding"><p><b>${esc(label)}:</b> ${esc(v)}</p></div>`;
  }).join('');
}
function stageCard(stage, i) {
  const body={...stage};delete body.id;delete body.name;
  return `<article class="stage-card"><div class="stage-header"><span class="stage-number">0${i+1}</span><span><h3>${esc(stage.name||agentNames[i])}</h3><small>${esc(agentDetails[i].toUpperCase())}</small></span></div>${stage.summary?`<p class="stage-summary">${esc(stage.summary)}</p>`:''}${fieldHtml(body,['summary'])}</article>`;
}
function renderReport(report) {
  currentReport=report;const final=report.final||{};const safety=report.stages?.find(s=>s.id==='safety')||report.stages?.[3]||{};
  $('#reportSection').hidden=false;
  $('#reportMeta').textContent=`${report.id||'MECHPILOT'} · ${new Date(report.createdAt||Date.now()).toLocaleString()} · ${report.model||'OpenRouter free router'}`;
  const risk=String(final.riskLevel||'Requires review');const cls=/critical|high/i.test(risk)?'critical':/moderate/i.test(risk)?'high':'';
  $('#verdict').innerHTML=`<span class="verdict-pill ${cls}">${esc(risk.toUpperCase())}</span><div class="verdict-copy"><h3>${esc(final.decision||'Review required')}</h3><p>${esc(final.summary||'See the stage findings below.')}</p></div>`;
  $('#reportStages').innerHTML=(report.stages||[]).map(stageCard).join('');
  $('#missingList').innerHTML=arr(final.missingInformation).length?arr(final.missingInformation).map(x=>`<li>${esc(x)}</li>`).join(''):'<li>No specific missing items were returned. Verify the input is complete.</li>';
  $('#questionsList').innerHTML=arr(final.followUpQuestions).length?arr(final.followUpQuestions).map(x=>`<li>${esc(x)}</li>`).join(''):'<li>Confirm details with an engineer and the equipment manual.</li>';
  $('#safetyFinal').textContent=(safety.decision? safety.decision+'. ':'')+(safety.reasoning||final.safeNextStep||'Advisory only. Follow site procedures and qualified engineering judgement.');
  $('#reportSection').scrollIntoView({behavior:'smooth',block:'start'});
}
async function parseSse(response, onEvent) {
  if (!response.ok) {
    let msg='Analysis request failed.';
    try {const d=await response.json();msg=d.error||msg;}catch{}
    throw new Error(msg);
  }
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let buffer='', completed=null, failure=null;
  while(true){
    const {value,done}=await reader.read();if(done)break;
    buffer+=decoder.decode(value,{stream:true});
    let idx;
    while((idx=buffer.indexOf('\n\n'))>=0){
      const block=buffer.slice(0,idx);buffer=buffer.slice(idx+2);
      let event='message', data='';
      for(const line of block.split('\n')){
        if(line.startsWith('event:'))event=line.slice(6).trim();
        else if(line.startsWith('data:'))data+=line.slice(5).trim();
      }
      if(!data)continue;
      let parsed;try{parsed=JSON.parse(data)}catch{continue;}
      if(event==='stage')onEvent(parsed);
      if(event==='complete')completed=parsed;
      if(event==='failure')failure=parsed.message||'The AI analysis failed.';
    }
  }
  if(failure)throw new Error(failure);
  if(!completed)throw new Error('The server closed the stream before the final report arrived. Please try again.');
  return completed;
}
$('#analysisForm').addEventListener('submit', async ev=>{
  ev.preventDefault();setError('');
  if(!$('#analysisForm').reportValidity())return;
  const payload={asset:$('#asset').value,criticality:$('#criticality').value,objective:$('#objective').value,symptoms:$('#symptoms').value.trim()};
  $('#runButton').disabled=true;openLoading();
  try{
    const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const report=await parseSse(response,stage=>{
      setProgress(stage.index,stage.status,stage.detail);
      const el=document.querySelector(`[data-loading-stage="${stage.index}"]`);
      if(el)el.querySelector('small').textContent=stage.detail||agentDetails[stage.index];
    });
    setProgress(3,'done','All agents completed. Consolidating the reviewed assessment.');
    await new Promise(r=>setTimeout(r,350));
    closeLoading();renderReport(report);
    try { localStorage.setItem('mechpilot-last-report',JSON.stringify(report)); } catch {}
    checkBackend();
  }catch(err){
    closeLoading();setError(err.message||'Something went wrong. Please retry.');
    checkBackend();
    document.querySelector('#workbench').scrollIntoView({behavior:'smooth',block:'start'});
  }finally{ $('#runButton').disabled=false; }
});
function download(filename,text,type){
 const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1200);
}
$('#exportJson').addEventListener('click',()=>{if(currentReport)download('mechpilot-assessment.json',JSON.stringify(currentReport,null,2),'application/json')});
$('#exportMarkdown').addEventListener('click',()=>{
 if(!currentReport)return;const r=currentReport,f=r.final||{};
 let md=`# MechPilot Engineering Assessment\n\n**Case ID:** ${r.id||'—'}  \n**Created:** ${r.createdAt||'—'}  \n**Model:** ${r.model||'OpenRouter free router'}\n\n## Final review\n**Risk:** ${f.riskLevel||'Requires review'}  \n**Decision:** ${f.decision||'Review required'}\n\n${f.summary||''}\n\n`;
 for(const st of (r.stages||[])){md+=`## ${st.name}\n\n${st.summary||''}\n\n`;md+=Object.entries(st).filter(([k])=>!['name','id','summary'].includes(k)).map(([k,v])=>`### ${k.replace(/_/g,' ')}\n${Array.isArray(v)?v.map(x=>'- '+(typeof x==='string'?x:JSON.stringify(x))).join('\n'):typeof v==='object'?JSON.stringify(v,null,2):String(v)}`).join('\n\n')+'\n\n';}
 md+='## Missing information\n'+arr(f.missingInformation).map(x=>'- '+x).join('\n')+'\n\n## Follow-up questions\n'+arr(f.followUpQuestions).map(x=>'- '+x).join('\n')+'\n\n## Limitations\n'+arr(f.limitations).map(x=>'- '+x).join('\n');
 download('mechpilot-assessment.md',md,'text/markdown');
});
try {
 const old=localStorage.getItem('mechpilot-last-report');
 // Do not auto-replay or trust stale AI reports; kept only as a browser convenience if user explicitly asks export after current run.
} catch {}
