// Client cho CocheGame với Conveyor animation, Online/Visit/Steal/Lock, GPS tick + Deliveries + Reclaim
const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

const tabs = $$('.tabs button');
const sections = $$('.tab');

tabs.forEach(btn => {
  btn.addEventListener('click', () => {
    tabs.forEach(b => b.classList.toggle('active', b===btn));
    sections.forEach(sec => sec.classList.toggle('hidden', sec.dataset.tab !== btn.dataset.tab));
    if (btn.dataset.tab === 'showroom') enterShowroom();
    if (btn.dataset.tab === 'garage') renderGarage();
    if (btn.dataset.tab === 'conveyor') { requestConveyor(); renderConveyor(); }
    if (btn.dataset.tab === 'online') requestPlayers();
  });
});

$('#addCashBtn')?.addEventListener('click', () => {
  socket.send(JSON.stringify({ type: 'debug:addCash', amount: 10000 }));
});

let socket;
let state = {
  sessionId: '',
  name: '',
  cash: 0,
  gpsTotal: 0,
  lockUntil: 0,
  cars: [],
  conveyor: [],
  owned: [],
  showroom: [],
  players: [],
  visiting: null,
  deliveries: [], // xe đang giao về showroom (mua hoặc cướp được)
  reclaims: []    // ticket lấy lại khi bị cướp
};

function showLogin(){ $('#loginModal')?.classList.add('shown'); }
function hideLogin(){ $('#loginModal')?.classList.remove('shown'); }

async function loadCars() {
  const res = await fetch('/data/cars.json');
  state.cars = await res.json();
}

function fmtCash(n) { return n.toLocaleString('vi-VN') + ' $'; }
function fmtGps(n)  { return (Math.round(n*100)/100).toLocaleString('vi-VN') + ' /s'; }
function now(){ return Date.now(); }

function tierColor(t) {
  switch (t) {
    case 'Transcendent': return '#f59e0b';
    case 'Celestial': return '#60a5fa';
    case 'Mythic': return '#a78bfa';
    case 'Exotic': return '#34d399';
    case 'Forged': return '#9ca3af';
    default: return '#9ca3af';
  }
}

// ===== Conveyor (smooth anim) =====
let animReq = null;
function requestConveyor(){ socket?.send(JSON.stringify({ type: 'getConveyor' })); }
function renderConveyor() {
  const lane = $('#conveyorLane');
  if (!lane) return;
  lane.innerHTML = '';
  const slotW = 260, gap = 12, duration = 20000;

  state.conveyor.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'slot ' + (item.tu_chat?.toLowerCase() || '');
    el.style.width = slotW+'px';
    el.dataset.id = item.id;
    el.innerHTML = `
      <div class="top">
        <span class="badge" style="border-color:${tierColor(item.tu_chat)}">${item.tu_chat}</span>
        <span>${item.emoji || ''}</span>
      </div>
      <img src="/assets/${item.img}" alt="${item.name}" onerror="this.src='/assets/placeholder.png'">
      <div class="name"><b>${item.name}</b>${item.mutation?.name && item.mutation.name!=='None' ? ' · ' + item.mutation.name : ''}</div>
      <div class="stats">GPS: <b>${fmtGps(item.gps)}</b> • Mutation: x${item.mutation?.incomeMult || 1}</div>
      <div class="price">Giá: <b>${fmtCash(item.price)}</b></div>
      <button class="buy">Mua</button>
      <div class="timebar"><div class="prog" style="width:0%"></div></div>
    `;
    el.querySelector('.buy').addEventListener('click', () => {
      socket.send(JSON.stringify({ type: 'buyFromConveyor', itemId: item.id }));
    });
    lane.appendChild(el);
  });

  const elements = $$('.slot', lane);
  function animate(){
    const L = lane.clientWidth;
    const nowTs = now();
    elements.forEach((el, i) => {
      const item = state.conveyor.find(x=>x.id===el.dataset.id);
      if(!item) return;
      const age = Math.max(0, nowTs - item.createdAt);
      const t = Math.min(1, age / duration);
      const x = L - t*(L + slotW) - i*(slotW+gap)*0.15;
      el.style.transform = `translateX(${x}px)`;
      const total = (item.expiresAt - item.createdAt);
      const left = Math.max(0, item.expiresAt - nowTs);
      const pct = Math.max(0, Math.min(100, (left/total)*100));
      const prog = $('.prog', el);
      if (prog) prog.style.width = pct + '%';
    });
    animReq = requestAnimationFrame(animate);
  }
  if (animReq) cancelAnimationFrame(animReq);
  animReq = requestAnimationFrame(animate);
}

// ===== Garage =====
function renderGarage() {
  const grid = $('#garageGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!state.owned.length) {
    grid.innerHTML = '<p class="muted">Chưa có xe nào.</p>';
    return;
  }
  state.owned.forEach(oc => {
    const el = document.createElement('div');
    el.className = 'card ' + (oc.tu_chat?.toLowerCase() || '');
    el.innerHTML = `
      <img src="/assets/${oc.img}" alt="${oc.name}" onerror="this.src='/assets/placeholder.png'">
      <div class="name">${oc.name} ${oc.mutation?.name && oc.mutation.name!=='None' ? '· '+oc.mutation.name : ''}</div>
      <div class="stats">GPS: ${fmtGps(oc.gps)} • Tư chất: ${oc.tu_chat}</div>
    `;
    grid.appendChild(el);
  });
}

// ===== Incoming (đang vận chuyển về showroom) =====
function renderIncoming() {
  const wrap = $('#incomingWrap');
  const list = $('#incomingList');
  if (!wrap || !list) return;

  const nowTs = Date.now();
  state.deliveries = state.deliveries.filter(d => d.readyAt > nowTs);

  if (!state.deliveries.length) {
    wrap.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  list.innerHTML = '';

  state.deliveries.forEach(d => {
    const total = d.readyAt - d.startAt; // 10s
    const left = Math.max(0, d.readyAt - nowTs);
    const pct = Math.max(0, Math.min(100, ((total - left)/total)*100));

    const el = document.createElement('div');
    el.className = 'incoming-item';
    el.innerHTML = `
      <img src="/assets/${d.img}" alt="${d.name}" onerror="this.src='/assets/placeholder.png'">
      <div class="meta">
        <div class="name">${d.name}</div>
        <div class="bar"><div class="prog" style="width:${pct}%"></div></div>
        <div class="eta">Còn ${Math.ceil(left/1000)}s để về showroom</div>
      </div>
    `;
    list.appendChild(el);
  });
}

// ===== Reclaim (lấy lại khi bị cướp) =====
function renderReclaim() {
  const wrap = $('#reclaimWrap');
  const list = $('#reclaimList');
  if (!wrap || !list) return;

  const nowTs = Date.now();
  state.reclaims = state.reclaims.filter(r => r.readyAt > nowTs);

  if (!state.reclaims.length) {
    wrap.classList.add('hidden'); list.innerHTML = ''; return;
  }
  wrap.classList.remove('hidden');
  list.innerHTML = '';

  state.reclaims.forEach(r => {
    const total = r.readyAt - r.startAt;
    const left = Math.max(0, r.readyAt - nowTs);
    const pct = Math.max(0, Math.min(100, ((total - left)/total)*100));

    const el = document.createElement('div');
    el.className = 'incoming-item';
    el.innerHTML = `
      <img src="/assets/${r.img||'placeholder.png'}" alt="${r.carName}">
      <div class="meta">
        <div class="name">${r.carName}</div>
        <div class="bar"><div class="prog" style="width:${pct}%"></div></div>
        <div class="eta">Còn ${Math.ceil(left/1000)}s • Ấn: <b>${r.presses}/${r.required}</b></div>
      </div>
      <div class="actions">
        <button class="button do-reclaim">Lấy lại</button>
      </div>
    `;
    el.querySelector('.do-reclaim').addEventListener('click', () => {
      socket.send(JSON.stringify({ type:'reclaim_press', id: r.id }));
    });
    list.appendChild(el);
  });
}

// ===== Showroom =====
function renderShowroom() {
  const grid = $('#showroomGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const lockEl = $('#lockStatus');
  const nowTs = now();
  if (state.lockUntil && state.lockUntil > nowTs) {
    const sec = Math.ceil((state.lockUntil - nowTs)/1000);
    lockEl.textContent = `🔒 Locked ${sec}s`;
  } else {
    lockEl.textContent = '';
  }
  if (!state.showroom.length) {
    grid.innerHTML = '<p class="muted">Chưa có xe sẵn sàng. Mua từ băng chuyền và đợi 10 giây.</p>';
    return;
  }
  state.showroom.slice(0, 15).forEach(oc => {
    const el = document.createElement('div');
    el.className = 'card ' + (oc.tu_chat?.toLowerCase() || '');
    el.innerHTML = `
      <img src="/assets/${oc.img}" alt="${oc.name}" onerror="this.src='/assets/placeholder.png'">
      <div class="name">${oc.name} ${oc.mutation?.name && oc.mutation.name!=='None' ? '· '+oc.mutation.name : ''}</div>
      <div class="stats">GPS: ${fmtGps(oc.gps)} • Tư chất: ${oc.tu_chat}</div>
    `;
    grid.appendChild(el);
  });
}
$('#lockBtn')?.addEventListener('click', () => {
  socket.send(JSON.stringify({ type: 'lockShowroom' }));
});
function enterShowroom() { socket.send(JSON.stringify({ type: 'enterShowroom' })); }

// ===== Online / Visit / Steal =====
function requestPlayers(){ socket.send(JSON.stringify({ type: 'getPlayers' })); }
function renderPlayers() {
  const list = $('#onlineList');
  if (!list) return;
  list.innerHTML = '';
  if (!state.players.length) {
    list.innerHTML = '<p class="muted">Chưa có ai online.</p>';
    return;
  }
  state.players.filter(p => p.id !== state.sessionId).forEach(p => {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="name">${p.name}</div>
      <button class="visit">Visit</button>
    `;
    el.querySelector('.visit').addEventListener('click', () => {
      socket.send(JSON.stringify({ type:'visit', targetId: p.id }));
    });
    list.appendChild(el);
  });
}

function renderVisit(target){
  const wrap = $('#visitArea');
  if (!wrap) return;
  if (!target) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  $('#visitTitle').textContent = `${target.name} • Showroom`;
  const grid = $('#visitGrid');
  grid.innerHTML = '';
  if (!target.cars?.length) {
    grid.innerHTML = '<p class="muted">Showroom trống.</p>';
    return;
  }
  target.cars.forEach(oc => {
    const el = document.createElement('div');
    el.className = 'card ' + (oc.tu_chat?.toLowerCase() || '');
    el.innerHTML = `
      <img src="/assets/${oc.img}" alt="${oc.name}" onerror="this.src='/assets/placeholder.png'">
      <div class="name">${oc.name}</div>
      <div class="stats">GPS: ${fmtGps(oc.gps)} • Tư chất: ${oc.tu_chat}</div>
      <button class="buy">Steal</button>
    `;
    el.querySelector('.buy').addEventListener('click', () => {
      socket.send(JSON.stringify({ type:'steal', targetId: target.id, ownedUid: oc.uid }));
    });
    grid.appendChild(el);
  });
}

// ===== WS =====
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  socket = new WebSocket(`${proto}${location.host}/ws`);

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello' }));
    showLogin();
  });

  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'hello':
        state.sessionId = msg.sessionId;
        state.name = msg.name || ('Player-' + state.sessionId.slice(0,4));
        $('#session').textContent = `Session: ${state.sessionId.slice(0, 8)} | ${state.name}`;
        break;

      // Kết quả đăng nhập OK
      case 'login_ok':
        state.name = msg.name;
        $('#session').textContent = `Session: ${state.sessionId.slice(0, 8)} | ${state.name}`;
        hideLogin();
        // Sau khi login: làm mới dữ liệu + danh sách
        requestConveyor();
        enterShowroom();
        requestPlayers();
        break;

      case 'state':
        state.cash = msg.cash; state.owned = msg.owned||[];
        state.gpsTotal = msg.gpsTotal||0; state.lockUntil = msg.lockUntil||0;
        $('#cash').textContent = fmtCash(state.cash)+(state.gpsTotal?` (+${fmtGps(state.gpsTotal)})`:'');
        renderGarage();
        break;

      case 'conveyor':
        state.conveyor = msg.items||[]; renderConveyor(); break;

      case 'purchase_ok':
        state.cash = msg.cash; state.owned = msg.owned||state.owned;
        $('#cash').textContent = fmtCash(state.cash);
        renderGarage();
        if (msg.deliver && msg.deliver.readyAt) {
          state.deliveries.push({
            ownedUid: msg.deliver.ownedUid,
            name: msg.deliver.name || 'Incoming car',
            img: msg.deliver.img || 'placeholder.png',
            startAt: Date.now(),
            readyAt: msg.deliver.readyAt
          });
          renderIncoming();
        }
        break;

      case 'reclaim_start':
        state.reclaims.push({
          id: msg.id,
          carName: msg.carName,
          img: msg.img,
          startAt: Date.now(),
          readyAt: msg.readyAt,
          presses: 0,
          required: msg.required
        });
        renderReclaim();
        break;

      case 'reclaim_progress': {
        const r = state.reclaims.find(x => x.id === msg.id);
        if (r) { r.presses = msg.presses; r.required = msg.required; renderReclaim(); }
        break;
      }

      case 'reclaim_ok':
        state.reclaims = state.reclaims.filter(x => x.id !== msg.id);
        renderReclaim();
        setTimeout(() => enterShowroom(), 1200);
        break;

      case 'reclaim_expired':
        state.reclaims = state.reclaims.filter(x => x.id !== msg.id);
        renderReclaim();
        break;

      case 'reclaim_lost':
        // Thief mất xe do victim reclaim thành công
        break;

      case 'showroom':
        state.showroom = msg.ready||[]; state.lockUntil = msg.lockUntil||state.lockUntil;
        renderShowroom(); break;

      case 'players':
        state.players = msg.players || [];
        renderPlayers();
        break;

      case 'visitShowroom':
        state.visiting = { id: msg.player.id, name: msg.player.name, cars: msg.cars||[] };
        renderVisit(state.visiting); break;

      case 'visited':
        alert(`${msg.fromName} đã ghé thăm showroom của bạn.`); break;

      case 'stolen':
        if (msg.role === 'victim') {
          // notify tùy ý
        }
        if (msg.role === 'thief') {
          if (msg.readyAt) {
            state.deliveries.push({
              ownedUid: msg.ownedUid || null,
              name: msg.carName || 'Stolen car',
              img: msg.img || 'placeholder.png',
              startAt: Date.now(),
              readyAt: msg.readyAt
            });
            renderIncoming();
          }
          enterShowroom();
          setTimeout(() => enterShowroom(), 11000);
        }
        break;

      case 'lock':
        state.lockUntil = msg.lockUntil||0; renderShowroom(); break;

      case 'error':
        alert(msg.message); break;
    }
  });

  socket.addEventListener('close', () => { setTimeout(connect,1500); });
}

// Tick UI cho tiến trình giao hàng + reclaim
setInterval(() => {
  renderIncoming();
  renderReclaim();
  if (state.deliveries.length) {
    const anyDone = state.deliveries.some(d => d.readyAt - Date.now() <= 200);
    if (anyDone) setTimeout(() => enterShowroom(), 250);
  }
}, 200);

// Gắn submit form login (modal)
document.addEventListener('DOMContentLoaded', ()=>{
  const form = $('#loginForm');
  if (form) {
    form.addEventListener('submit', (e)=>{
      e.preventDefault();
      const name = ($('#loginName').value || '').trim();
      const password = ($('#loginPass').value || '').trim();
      if (!name || !password) return;
      socket?.send(JSON.stringify({ type:'login', name, password }));
    });
  }
});

// init
(async function init(){ await loadCars(); connect(); })();
