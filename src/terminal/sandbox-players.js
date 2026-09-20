const viewportMeta =
  '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>';

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Game QA canvas — D-pad only for game-server listings. */
function sandboxGameHtml(title) {
  const t = escapeHtml(title || 'Game stream');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
${viewportMeta}
<meta name="mobile-web-app-capable" content="yes"/>
<title>${t}</title>
<style>
  html,body{margin:0;height:100%;background:#05070d;color:#d7ffe3;font-family:ui-sans-serif,system-ui;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;}
  canvas{display:block;width:100%;height:100%;touch-action:none;}
  .hud{position:absolute;left:12px;top:max(8px,env(safe-area-inset-top));font:600 12px/1.35 ui-monospace,monospace;
    background:rgba(0,0,0,.45);padding:6px 8px;border-radius:8px;border:1px solid #1f3d32;max-width:70vw;pointer-events:none}
  .pad{position:absolute;left:max(12px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));
    display:grid;grid-template-columns:52px 52px 52px;grid-template-rows:52px 52px 52px;gap:6px;z-index:3}
  .pad b{grid-column:2;width:52px;height:52px;border-radius:14px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff}
  .pad .l{grid-column:1;grid-row:2}.pad .r{grid-column:3;grid-row:2}.pad .u{grid-column:2;grid-row:1}.pad .d{grid-column:2;grid-row:3}
  .pad b:active{background:rgba(61,255,176,.35)}
</style></head>
<body>
<div class="hud">AI Markets · Game stream<br/>Vuốt / D-pad</div>
<canvas id="c"></canvas>
<div class="pad" id="pad">
  <b class="u" data-k="ArrowUp">▲</b>
  <b class="l" data-k="ArrowLeft">◀</b>
  <b class="r" data-k="ArrowRight">▶</b>
  <b class="d" data-k="ArrowDown">▼</b>
</div>
<script>
const c=document.getElementById('c'),x=c.getContext('2d');
let w,h,t=0,px=120,py=120,vx=0,vy=0;
const keys={};
function resize(){const d=Math.min(window.devicePixelRatio||1,2);w=innerWidth;h=innerHeight;c.width=w*d;c.height=h*d;c.style.width=w+'px';c.style.height=h+'px';x.setTransform(d,0,0,d,0,0);}
addEventListener('resize',resize);resize();
addEventListener('keydown',e=>keys[e.key]=true);
addEventListener('keyup',e=>keys[e.key]=false);
function bind(el,code){
  const on=e=>{e.preventDefault();keys[code]=true}; const off=e=>{e.preventDefault();keys[code]=false};
  el.addEventListener('pointerdown',on,{passive:false});
  el.addEventListener('pointerup',off); el.addEventListener('pointercancel',off); el.addEventListener('pointerleave',off);
}
document.querySelectorAll('#pad [data-k]').forEach(el=>bind(el,el.getAttribute('data-k')));
c.addEventListener('pointerdown',e=>{
  const cx=w/2,cy=h/2;
  keys.ArrowRight=e.clientX>cx+24; keys.ArrowLeft=e.clientX<cx-24;
  keys.ArrowDown=e.clientY>cy+24; keys.ArrowUp=e.clientY<cy-24;
},{passive:true});
c.addEventListener('pointerup',()=>{keys.ArrowRight=keys.ArrowLeft=keys.ArrowDown=keys.ArrowUp=false});
function loop(){
  t+=1;
  vx+=(keys.ArrowRight||keys.d||keys.D)?0.6:0; vx+=(keys.ArrowLeft||keys.a||keys.A)?-0.6:0;
  vy+=(keys.ArrowDown||keys.s||keys.S)?0.6:0; vy+=(keys.ArrowUp||keys.w||keys.W)?-0.6:0;
  vx*=0.9; vy*=0.9; px=Math.max(20,Math.min(w-20,px+vx)); py=Math.max(20,Math.min(h-20,py+vy));
  x.fillStyle='#071018'; x.fillRect(0,0,w,h);
  for(let i=0;i<40;i++){
    const gx=(i*97+t*1.5)%w, gy=(i*53+t)%h;
    x.fillStyle='rgba(80,255,180,'+(0.08+((i%5)*0.04))+')';
    x.fillRect(gx,gy,2,2);
  }
  x.fillStyle='#3dffb0'; x.beginPath(); x.arc(px,py,14,0,Math.PI*2); x.fill();
  x.strokeStyle='#9fffd4'; x.stroke();
  requestAnimationFrame(loop);
}
loop();
</script>
</body></html>`;
}

/** GPU train / inference lab — shell only, no D-pad. */
function sandboxTerminalHtml({ title, gpu, hostname } = {}) {
  const t = escapeHtml(title || 'GPU terminal');
  const gpuJ = JSON.stringify(String(gpu || 'NVIDIA GPU'));
  const hostJ = JSON.stringify(String(hostname || 'gpu-lab'));
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
${viewportMeta}
<meta name="mobile-web-app-capable" content="yes"/>
<title>${t}</title>
<style>
  html,body{margin:0;height:100%;background:#070b12;color:#c8f5d8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;}
  #term{position:absolute;inset:0 0 56px 0;padding:12px 14px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.45;}
  #bar{position:absolute;left:0;right:0;bottom:0;display:flex;gap:8px;align-items:center;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:#0c121c;border-top:1px solid #1c2a3a;}
  #bar form{display:flex;flex:1;min-width:0;gap:8px;align-items:center;margin:0}
  #bar span{color:#3dffb0;font-size:12px;flex:none}
  #cmd{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#e8fff2;font:inherit;font-size:16px;}
  #go{flex:none;background:#3dffb0;color:#071018;border:0;border-radius:8px;padding:8px 12px;font-weight:800;font-size:12px;}
  .dim{color:#6f8b7c}
</style></head>
<body>
<div id="term"></div>
<div id="bar">
  <span>$</span>
  <form id="cmdForm" action="#" autocomplete="off">
    <input id="cmd" type="text" inputmode="text" enterkeyhint="send" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="nvidia-smi · python train.py · help"/>
    <button id="go" type="submit">Send</button>
  </form>
</div>
<script>
const gpu=${gpuJ};
const host=${hostJ};
const term=document.getElementById('term');
const input=document.getElementById('cmd');
const form=document.getElementById('cmdForm');
const hist=[]; let hi=-1;
function print(s){term.textContent+=s;term.scrollTop=term.scrollHeight;}
print('AI Markets GPU lab  ·  '+host+'\\n'+gpu+'\\nSandbox shell — no D-pad. Type help.\\n\\n');
function run(raw){
  const cmd=String(raw||'').trim();
  print('$ '+cmd+'\\n');
  if(!cmd) return;
  hist.push(cmd); hi=hist.length;
  if(cmd==='help'){
    print('Commands: help, hostname, whoami, pwd, ls, date, nvidia-smi, python --version, python train.py, clear\\n');
    return;
  }
  if(cmd==='clear'||cmd==='cls'){term.textContent='';return;}
  if(cmd==='hostname'){print(host+'\\n');return;}
  if(cmd==='whoami'){print('buyer\\n');return;}
  if(cmd==='pwd'){print('/workspace\\n');return;}
  if(cmd==='date'){print(new Date().toISOString()+'\\n');return;}
  if(cmd==='ls'||cmd==='ls -la'||cmd==='ls /workspace'){
    print('checkpoints/  datasets/  models/  train.py  README.md\\n');return;
  }
  if(cmd==='nvidia-smi'||cmd==='nvidia-smi -L'){
    print(gpu+'\\n+-----------------------------------------------------------------------------------------+\\n| NVIDIA-SMI 550.90    Driver Version: 550.90    CUDA Version: 12.4                       |\\n|-----------------------------------------+------------------------+----------------------+\\n| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |\\n| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |\\n|                                         |                        |               MIG M. |\\n|=========================================+========================+======================|\\n|   0  '+gpu.slice(0,22).padEnd(22)+'  On  | 00000000:01:00.0 Off |                    0 |\\n| 30%   41C    P2              48W / 450W |    1024MiB / 24564MiB |     12%      Default |\\n+-----------------------------------------------------------------------------------------+\\n');
    return;
  }
  if(cmd==='python --version'||cmd==='python3 --version'){print('Python 3.11.9\\n');return;}
  if(cmd==='python train.py'||cmd==='python3 train.py'||cmd==='train'){
    print('Epoch 1/3  loss=2.41  gpu=0  mem=8.2GiB\\nEpoch 2/3  loss=1.88  gpu=0  mem=8.4GiB\\nEpoch 3/3  loss=1.52  gpu=0  mem=8.4GiB\\nSaved ./checkpoints/last.ckpt\\n');
    return;
  }
  if(cmd.startsWith('echo ')){print(cmd.slice(5)+'\\n');return;}
  print('sandbox: command not found: '+cmd+'\\n');
}
window.__gpuRun=function(raw){ run(raw); };
function submitCmd(){
  const v=input.value;
  input.value='';
  run(v);
}
form.addEventListener('submit',function(e){ e.preventDefault(); submitCmd(); });
input.addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.keyCode===13){e.preventDefault();submitCmd();return;}
  if(e.key==='ArrowUp'){e.preventDefault();if(!hist.length)return;hi=Math.max(0,hi-1);input.value=hist[hi]||'';return;}
  if(e.key==='ArrowDown'){e.preventDefault();hi=Math.min(hist.length,hi+1);input.value=hist[hi]||'';}
});
input.addEventListener('keyup',e=>{
  if(e.key==='Enter'||e.keyCode===13){e.preventDefault();}
});
term.addEventListener('click',()=>input.focus());
document.addEventListener('keydown',e=>{ if(e.target!==input && e.key.length===1) input.focus(); });
input.focus();
</script>
</body></html>`;
}

function isSandboxLike(doc) {
  const kind = String(doc.streamKind || '');
  if (kind === 'iframe' && doc.streamPath) return false;
  if ((kind === 'hls' || kind === 'novnc' || kind === 'iframe') && doc.streamHost && doc.streamPort) return false;
  return kind === 'sandbox' || kind === 'terminal' || !doc.streamHost || !doc.streamPort;
}

module.exports = {
  viewportMeta,
  sandboxGameHtml,
  sandboxTerminalHtml,
  isSandboxLike,
};
