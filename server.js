// server.js — Node + Express + ws (WebSocket) với Conveyor + Online/Visit/Steal/Lock + GPS tick + Console log
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cookie = require('cookie');
const WebSocket = require('ws');
// thêm ngay gần đầu file
const stealCooldowns = new Map(); // key = victimId + ':' + carId, value = expiresAt

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const sockets = new Map(); // sessionId -> ws

// Reclaim mini-game storage (GLOBAL, KHÔNG đặt trong wss.on('connection') nữa)
const reclaims = new Map(); // id -> { id, victimId, thiefId, thiefOwnedUid, carSnapshot, presses, required, expiresAt }

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'public', 'data');
const DB_DIR = path.join(__dirname, 'db');
const PLAYERS_FILE = path.join(DB_DIR, 'players.json');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// ========== Helper ==========
function log(...args) {
  console.log('[CocheGame]', ...args);
}

// --- Load cars ---
const cars = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cars.json'), 'utf-8'));

// --- DB ---
function loadPlayers() {
  try { return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf-8')); }
  catch { return {}; }
}
function savePlayers(players) {
  fs.writeFileSync(PLAYERS_FILE, JSON.stringify(players, null, 2));
}
const players = loadPlayers();

function migratePlayer(p) {
  if (!Array.isArray(p.owned)) p.owned = [];
  if (!Array.isArray(p.purchaseQueue)) p.purchaseQueue = [];
  if (!p.name) p.name = 'Player-' + Math.floor(Math.random() * 9999);
  if (!p.lockUntil) p.lockUntil = 0;
  return p;
}
function getOrCreatePlayer(sessionId) {
  if (!players[sessionId]) {
    players[sessionId] = {
      cash: 50000,
      owned: [],
      purchaseQueue: [],
      name: 'Player-' + sessionId.slice(0,4),
      lockUntil: 0
    };
  }
  players[sessionId] = migratePlayer(players[sessionId]);
  savePlayers(players);
  return players[sessionId];
}
function calcGpsTotal(p) {
  return (p.owned || []).reduce((s, oc) => s + (Number(oc.gps)||0), 0);
}

app.use(express.static(path.join(__dirname, 'public')));

// Session cookie
app.use((req,res,next)=>{
  const cookies = cookie.parse(req.headers.cookie || '');
  if (!cookies.sessionId) {
    const sid = uuidv4();
    res.setHeader('Set-Cookie', cookie.serialize('sessionId', sid, {
      httpOnly:false, path:'/', maxAge:60*60*24*365
    }));
    req.sessionId = sid;
  } else req.sessionId = cookies.sessionId;
  next();
});

app.get('/health', (_,res)=>res.json({ok:true}));

// ========== Conveyor config ==========
const TU_CHAT = ['Forged','Exotic','Mythic','Celestial','Transcendent'];
const EMOJIS = ['✨','🔥','⚡','🛡️','🌟','💎','🌀','🏁','🐯','🐲','🦊'];
const MUTATIONS = [
  { name:'Legendary', incomeMult:7, priceMult:500, chance:1 },
  { name:'One-Off', incomeMult:5, priceMult:100, chance:2 },
  { name:'Speciale', incomeMult:3, priceMult:10, chance:5 },
  { name:'Limited', incomeMult:2, priceMult:5, chance:8 },
  { name:'Series', incomeMult:1.5, priceMult:3, chance:10 }
];
const NONE_MUT = { name:'None', incomeMult:1, priceMult:1 };

function rollMutation() {
  let roll = Math.random()*100, acc=0;
  for (const m of MUTATIONS) { acc+=m.chance; if (roll<acc) return m; }
  return NONE_MUT;
}
const TU_CHAT_WEIGHTS=[50,25,15,8,2];
function rollTuChat(){
  let total = TU_CHAT_WEIGHTS.reduce((a,b)=>a+b,0), r=Math.random()*total;
  for(let i=0;i<TU_CHAT.length;i++){ if(r<TU_CHAT_WEIGHTS[i]) return TU_CHAT[i]; r-=TU_CHAT_WEIGHTS[i]; }
  return TU_CHAT[0];
}

let conveyor=[];
function spawnConveyorItem(){
  const base = cars[Math.floor(Math.random()*cars.length)];
  const tu = rollTuChat(), mut = rollMutation();
  const basePrice = base.price||1000;
  const price = Math.round(basePrice*(mut.priceMult||1));
  const gps = Math.round(basePrice*0.005*(mut.incomeMult||1)*100)/100;
  const now=Date.now();
  const item={
    id:uuidv4(), carId:base.id, name:base.name, img:base.img,
    basePrice, price, gps, tu_chat:tu, mutation:mut,
    emoji:EMOJIS[Math.floor(Math.random()*EMOJIS.length)],
    createdAt:now, expiresAt:now+20000
  };
  conveyor.push(item);
  log('Spawned', {id:item.id, name:item.name, price:item.price, tu_chat:item.tu_chat, mutation:item.mutation.name});
  broadcast({type:'conveyor',items:conveyor});
}
function pruneConveyor(){
  const now=Date.now(); const before=conveyor.length;
  conveyor=conveyor.filter(it=>it.expiresAt>now);
  if(conveyor.length!==before) log('Pruned', before-conveyor.length, 'expired; remaining', conveyor.length);
}
setInterval(spawnConveyorItem,3000);
setInterval(pruneConveyor,1000);

// ========== GPS tick ==========
setInterval(()=>{
  for (const [sid,p] of Object.entries(players)){
    const inc = calcGpsTotal(p);
    if(inc>0){
      p.cash+=inc;
      const ws=sockets.get(sid);
      if(ws&&ws.readyState===WebSocket.OPEN){
        ws.send(JSON.stringify({type:'state',cash:p.cash,owned:p.owned,gpsTotal:inc,lockUntil:p.lockUntil}));
      }
    }
  }
  savePlayers(players);
},1000);

// ========== WebSocket ==========
wss.on('connection',(ws,req)=>{
  const cookies = cookie.parse(req.headers.cookie||'');
  let sessionId = cookies.sessionId||uuidv4();
  const player=getOrCreatePlayer(sessionId);
  sockets.set(sessionId,ws);

  log('WS connected',{sessionId,cash:player.cash,owned:player.owned.length});

  ws.on('close',()=>{ sockets.delete(sessionId); broadcastPlayers(); });
  ws.send(JSON.stringify({type:'hello',sessionId,name:player.name}));
  ws.send(JSON.stringify({type:'state',cash:player.cash,owned:player.owned,gpsTotal:calcGpsTotal(player),lockUntil:player.lockUntil}));
  ws.send(JSON.stringify({type:'conveyor',items:conveyor}));
  broadcastPlayers();

  ws.on('message',(data)=>{
    let msg; try{msg=JSON.parse(data.toString())}catch{return}
        // ===== LOGIN (user + password) =====
    if (msg.type === 'login') {
      const uname = (msg.name || '').trim();
      const pwd = (msg.password || '').trim();

      if (!uname || !pwd) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Nhập tên và mật khẩu' }));
      }

      // Tìm player theo name
      let existingId = Object.keys(players).find(id => players[id]?.name === uname);

      if (existingId) {
        // Có user rồi -> kiểm tra password
        const acc = players[existingId];
        // Nếu account cũ chưa có password: dùng lần đầu đặt pass (để migrate dữ liệu cũ)
        if (!acc.password) {
          acc.password = pwd;
          savePlayers(players);
        }
        if (acc.password !== pwd) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Sai mật khẩu' }));
        }
        // Map sessionId hiện tại vào account đã có (share cùng dữ liệu)
        players[sessionId] = acc;
      } else {
        // Chưa có user -> tạo mới
        players[sessionId] = {
          name: uname,
          password: pwd,
          cash: 50000,
          owned: [],
          purchaseQueue: [],
          lockUntil: 0
        };
      }

      savePlayers(players);

      // Trả lời client đăng nhập OK + gửi state chuẩn
      const p = players[sessionId];
      ws.send(JSON.stringify({ type: 'login_ok', sessionId, name: p.name }));
      ws.send(JSON.stringify({ type: 'state', cash: p.cash, owned: p.owned, gpsTotal: calcGpsTotal(p), lockUntil: p.lockUntil }));
      ws.send(JSON.stringify({ type: 'conveyor', items: conveyor }));
      broadcastPlayers(); // cập nhật danh sách online cho tất cả
      return;
    }

    // Debug add cash
    if(msg.type==='debug:addCash'){ 
      player.cash+=msg.amount||0; savePlayers(players);
      log('AddCash',{sessionId,amount:msg.amount,newCash:player.cash});
      ws.send(JSON.stringify({type:'state',cash:player.cash,owned:player.owned,gpsTotal:calcGpsTotal(player),lockUntil:player.lockUntil}));
      return;
    }
    if (msg.type === 'setName') {
  if (typeof msg.name === 'string' && msg.name.trim().length > 0) {
    player.name = msg.name.trim().slice(0, 20); // giới hạn 20 ký tự
    savePlayers(players);
    log('SetName', { sessionId, name: player.name });
    ws.send(JSON.stringify({ type: 'hello', sessionId, name: player.name }));
    broadcastPlayers(); // update cho mọi người
  }
  return;
}

    if(msg.type==='getConveyor'){ ws.send(JSON.stringify({type:'conveyor',items:conveyor})); return;}
   if(msg.type==='getPlayers'){ broadcastPlayers(); return; }


    // Mua từ băng chuyền
    if(msg.type==='buyFromConveyor'){
      const item=conveyor.find(it=>it.id===msg.itemId),now=Date.now();
      if(!item||item.expiresAt<=now){
        log('BuyFailed',{sessionId,reason:'expired'});
        return ws.send(JSON.stringify({type:'error',message:'Xe đã rời băng chuyền'}));
      }
      if(player.cash<item.price){
        log('BuyFailed',{sessionId,reason:'not enough cash',need:item.price,have:player.cash});
        return ws.send(JSON.stringify({type:'error',message:'Không đủ tiền'}));
      }
      player.cash-=item.price;
      const owned={uid:uuidv4(),carId:item.carId,name:item.name,img:item.img,basePrice:item.basePrice,tu_chat:item.tu_chat,mutation:item.mutation,gps:item.gps,acquiredAt:now};
      player.owned.push(owned);
      player.purchaseQueue.push({ownedUid:owned.uid,readyAt:now+10000});

      conveyor=conveyor.filter(it=>it.id!==item.id);
      savePlayers(players);
      log('BuyOK',{sessionId,car:item.name,price:item.price});

      // Gửi kèm thông tin giao hàng để client hiển thị tiến trình (incoming)
      ws.send(JSON.stringify({
        type:'purchase_ok',
        cash:player.cash,
        owned:player.owned,
        deliver:{ ownedUid: owned.uid, readyAt: now+10000, name: item.name, img: item.img }
      }));

      broadcast({type:'conveyor',items:conveyor});
      return;
    }

    // Showroom của bản thân
    if(msg.type==='enterShowroom'){
      const now=Date.now(); const readyUids=player.purchaseQueue.filter(p=>p.readyAt<=now).map(p=>p.ownedUid);
      const ready=player.owned.filter(oc=>readyUids.includes(oc.uid));
      log('EnterShowroom',{sessionId,ready:ready.length});
      ws.send(JSON.stringify({type:'showroom',ready,lockUntil:player.lockUntil})); return;
    }

    // Lock showroom
    if(msg.type==='lockShowroom'){ 
      player.lockUntil=Date.now()+60000; savePlayers(players);
      log('Lock',{sessionId,until:player.lockUntil});
      ws.send(JSON.stringify({type:'lock',lockUntil:player.lockUntil})); return;
    }

    // Visit người khác
    if(msg.type==='visit'){
      const target=players[msg.targetId]; if(!target) return;
      const now=Date.now(); const readyUids=target.purchaseQueue.filter(p=>p.readyAt<=now).map(p=>p.ownedUid);
      const carsReady=target.owned.filter(oc=>readyUids.includes(oc.uid));
      const targetWs=sockets.get(msg.targetId);
      if(targetWs) targetWs.send(JSON.stringify({type:'visited',fromId:sessionId,fromName:player.name}));
      log('Visit',{from:sessionId,to:msg.targetId,cars:carsReady.length});
      ws.send(JSON.stringify({type:'visitShowroom',player:{id:msg.targetId,name:target.name},cars:carsReady})); return;
    }

    // Steal
    if (msg.type==='steal'){
      const target=players[msg.targetId]; if(!target) return;
      const now=Date.now();
      if(msg.targetId===sessionId) return; // không tự steal mình
    // Check cooldown
const key = msg.targetId + ':' + msg.ownedUid;
if (stealCooldowns.has(key) && stealCooldowns.get(key) > now) {
  return ws.send(JSON.stringify({type:'error', message:'Xe vừa được reclaim, chờ 60s mới steal lại'}));
}

      // Không cho steal khi target đang lock
      if(target.lockUntil && target.lockUntil>now){
        log('StealFail',{thief:sessionId,victim:msg.targetId,reason:'locked'});
        return ws.send(JSON.stringify({type:'error',message:'Showroom bị khóa'}));
      }

      // Chỉ cho steal xe đã READY trong showroom
      const readyUids = target.purchaseQueue.filter(p=>p.readyAt<=now).map(p=>p.ownedUid);
      const idx = target.owned.findIndex(oc => oc.uid===msg.ownedUid && readyUids.includes(oc.uid));
      if (idx===-1){
        log('StealFail',{thief:sessionId,victim:msg.targetId,reason:'not ready'});
        return ws.send(JSON.stringify({type:'error',message:'Không steal được'}));
      }

      // Lấy xe khỏi victim
      const stolen = target.owned.splice(idx,1)[0];
      savePlayers(players);

      // Clone sang thief và ĐƯA VÀO HÀNG CHỜ DELIVERING 10s
      const cloned = {...stolen, uid: uuidv4(), acquiredAt: now};
      player.owned.push(cloned);
      player.purchaseQueue.push({ ownedUid: cloned.uid, readyAt: now + 10000 });
      savePlayers(players);

      // Tạo ticket reclaim cho victim: 10..15 lần bấm trong 10s
      const reqTimes = 10 + Math.floor(Math.random() * 6);
      const reclaimId = uuidv4();
      reclaims.set(reclaimId, {
        id: reclaimId,
        victimId: msg.targetId,
        thiefId: sessionId,
        thiefOwnedUid: cloned.uid,
        carSnapshot: stolen,
        presses: 0,
        required: reqTimes,
        expiresAt: now + 10000
      });

      // Notify 2 bên
      log('StealOK',{thief:sessionId,victim:msg.targetId,car:stolen.name});
      ws.send(JSON.stringify({
        type:'stolen',
        role:'thief',
        carName: stolen.name,
        img: stolen.img,
        ownedUid: cloned.uid,
        readyAt: now + 10000
      }));
      const tws = sockets.get(msg.targetId);
      if (tws && tws.readyState===WebSocket.OPEN) {
        tws.send(JSON.stringify({type:'stolen',role:'victim',carName:stolen.name}));
        tws.send(JSON.stringify({
          type:'reclaim_start',
          id: reclaimId,
          carName: stolen.name,
          img: stolen.img,
          required: reqTimes,
          readyAt: now + 10000
        }));
      }

      // Cập nhật state 2 bên
      ws.send(JSON.stringify({
        type:'state',
        cash:player.cash,
        owned:player.owned,
        gpsTotal:calcGpsTotal(player),
        lockUntil:player.lockUntil
      }));
      if (tws && tws.readyState===WebSocket.OPEN) {
        tws.send(JSON.stringify({
          type:'state',
          cash:target.cash,
          owned:target.owned,
          gpsTotal:calcGpsTotal(target),
          lockUntil:target.lockUntil
        }));
      }
      return;
    }

    // Victim nhấn "Lấy lại" (reclaim_press)
    if (msg.type === 'reclaim_press') {
      const r = reclaims.get(msg.id);
      if (!r) { return ws.send(JSON.stringify({ type:'reclaim_expired', id: msg.id })); }
      if (r.victimId !== sessionId) return; // chỉ victim được ấn

      const now = Date.now();
      if (now >= r.expiresAt) {
        reclaims.delete(r.id);
        return ws.send(JSON.stringify({ type:'reclaim_expired', id: r.id }));
      }

      r.presses += 1;
      ws.send(JSON.stringify({ type:'reclaim_progress', id: r.id, presses: r.presses, required: r.required }));

      if (r.presses >= r.required) {
        // Hủy steal: gỡ xe khỏi thief (kể cả khỏi purchaseQueue), trả về victim
        const thief = players[r.thiefId];
        const victim = players[r.victimId];
        // Sau khi victim nhận lại xe
stealCooldowns.set(r.victimId + ':' + r.carSnapshot.uid, Date.now() + 60000);

        if (thief) {
          // remove from thief owned
          const idx = (thief.owned||[]).findIndex(oc => oc.uid === r.thiefOwnedUid);
          if (idx !== -1) thief.owned.splice(idx,1);
          // remove from thief purchaseQueue
          thief.purchaseQueue = (thief.purchaseQueue||[]).filter(p => p.ownedUid !== r.thiefOwnedUid);
          const tWs = sockets.get(r.thiefId);
          if (tWs && tWs.readyState === WebSocket.OPEN) {
            tWs.send(JSON.stringify({ type:'reclaim_lost', carName: r.carSnapshot.name }));
            tWs.send(JSON.stringify({ type:'state', cash:thief.cash, owned:thief.owned, gpsTotal:calcGpsTotal(thief), lockUntil:thief.lockUntil }));
          }
        }

        if (victim) {
          const back = { ...r.carSnapshot, uid: uuidv4(), acquiredAt: now };
          victim.owned.push(back);
          // Cho “về lại” gần như lập tức (1s để thấy hiệu ứng)
          victim.purchaseQueue.push({ ownedUid: back.uid, readyAt: now + 1000 });
          const vWs = sockets.get(r.victimId);
          if (vWs && vWs.readyState === WebSocket.OPEN) {
            vWs.send(JSON.stringify({ type:'reclaim_ok', id: r.id, carName: back.name, readyAt: now + 1000, img: back.img }));
            vWs.send(JSON.stringify({ type:'state', cash:victim.cash, owned:victim.owned, gpsTotal:calcGpsTotal(victim), lockUntil:victim.lockUntil }));
          }
        }

        reclaims.delete(r.id);
      }
      return;
    }

  });
});

// Broadcast helpers
function broadcast(msg){ const data=JSON.stringify(msg); wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)c.send(data)});}
function broadcastPlayers(wsSingle=null){
  const arr = Array.from(sockets.keys()).map(id => ({
    id,
    name: players[id]?.name || ('Player-'+id.slice(0,4))
  }));
  const payload = { type: 'players', players: arr };
  if (wsSingle) wsSingle.send(JSON.stringify(payload));
  else broadcast(payload);
}



// Auto-expire reclaims
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of reclaims) {
    if (now >= r.expiresAt) reclaims.delete(id);
  }
}, 1000);

server.listen(PORT,()=>log('Server listening on http://localhost:'+PORT));
