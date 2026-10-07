const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const TEAMS = ["MI","CSK","RCB","KKR","DC","PBKS","RR","SRH","GT","LSG"];

const PLAYER_SOURCE = "https://www.moneycontrol.com/sports/cricket/ipl/ipl-2025-mega-auction-check-complete-list-of-574-players-along-with-their-base-price-article-12868825.html";
let playerPool = [];
let playerPoolReady = null;

function decodeHtml(s){
  return s.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&#39;|&apos;/gi,"'").replace(/&quot;/gi,'"').replace(/&#x27;/gi,"'");
}

function parsePlayerPool(html){
  const clean=decodeHtml(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g,"\n"));
  const lines=clean.split(/\n+/).map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
  const out=[];
  const seen=new Set();
  const countries="India|Australia|England|South Africa|New Zealand|West Indies|Sri Lanka|Afghanistan|Bangladesh|Ireland|Zimbabwe|USA|Scotland|Nepal|Netherlands|UAE|Namibia|Canada|Oman";
  const re=new RegExp("^(\\d{1,3})\\.\\s+(.+?)\\s+-\\s+("+countries+")\\s+-\\s+INR\\s+([0-9.]+)\\s+(Crore|Lakhs?)$","i");
  for(const line of lines){
    const m=line.match(re); if(!m) continue;
    const name=m[2].trim();
    const country=m[3].trim();
    const amount=Number(m[4]);
    const unit=m[5].toLowerCase();
    const baseLakh=Math.round(amount*(unit.startsWith("crore")?100:1));
    if(!name || !baseLakh || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({name,country,role:"Player",baseLakh});
  }
  out.sort((a,b)=>0);
  return out;
}

async function loadPlayerPool(){
  if(playerPool.length>=500) return playerPool;
  if(playerPoolReady) return playerPoolReady;
  playerPoolReady=(async()=>{
    try{
      const r=await fetch(PLAYER_SOURCE,{headers:{"user-agent":"Mozilla/5.0 VRAMP IPL Auction"}});
      if(!r.ok) throw new Error(`source HTTP ${r.status}`);
      const html=await r.text();
      const parsed=parsePlayerPool(html);
      if(parsed.length<500) throw new Error(`only ${parsed.length} players parsed`);
      playerPool=parsed;
      console.log(`Loaded ${playerPool.length} IPL 2025 auction players.`);
    }catch(e){
      console.error("Player pool load failed:",e.message);
      playerPool=[];
    }
    return playerPool;
  })();
  return playerPoolReady;
}

function id(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }
function roomCode(){ let c; do c=id(); while(rooms.has(c)); return c; }
function send(ws, obj){ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj){ for(const p of room.players.values()) send(p.ws,obj); }

function increment(lakh){
  if(lakh < 100) return 5;
  if(lakh < 500) return 10;
  return 25;
}
function nextBid(current, base){
  const x = Math.max(current, base);
  return x + increment(x);
}
function publicRoom(room){
  return {code:room.code, mode:room.mode, status:room.started?"live":"waiting",
    players:[...room.players.values()].filter(p=>!p.spectator).map(p=>({name:p.name,team:p.team,online:p.online})),
    spectators:[...room.players.values()].filter(p=>p.spectator).length};
}
function snapshot(room){
  return {
    type:"state", room:publicRoom(room), settings:room.settings, started:room.started,
    auction:room.auction ? {
      index:room.index, player:room.auction.player, bid:room.auction.bid,
      bidder:room.auction.bidder, endsAt:room.auction.endsAt, paused:room.auction.paused
    }:null,
    teams:Object.fromEntries([...room.teams.entries()].map(([k,v])=>[k,{purse:v.purse,squad:v.squad,overseas:v.overseas}])),
    feed:room.feed.slice(-40), chat:room.chat.slice(-60), host:room.host
  };
}
function addFeed(room,text){ room.feed.push({t:Date.now(),text}); if(room.feed.length>100) room.feed.shift(); }

function makeRoom(host, mode, settings){
  const code=roomCode();
  const room={code,host,mode:mode||"mega",settings:{
    timer:Number(settings?.timer)||10, reset:Number(settings?.reset)||5,
    public:!!settings?.public, accelerated:settings?.accelerated!==false,
    retention:!!settings?.retention
  },players:new Map(),teams:new Map(),started:false,index:0,auction:null,feed:[],chat:[],timer:null,used:new Set()};
  for(const t of TEAMS) room.teams.set(t,{purse:12000,squad:[],overseas:0});
  rooms.set(code,room); return room;
}
function startAuction(room, players){
  room.started=true; room.index=0; room.playerPool=players;
  nextPlayer(room);
}
function nextPlayer(room){
  if(!room.playerPool || room.index>=room.playerPool.length){
    room.auction=null; broadcast(room,{type:"finished"}); return;
  }
  const p=room.playerPool[room.index++];
  room.auction={player:p,bid:p.baseLakh,bidder:null,endsAt:Date.now()+room.settings.timer*1000,paused:false};
  addFeed(room,`Now up: ${p.name} • Base ₹${(p.baseLakh/100).toFixed(2)} Cr`);
  broadcast(room,snapshot(room)); scheduleTimer(room);
}
function scheduleTimer(room){
  clearTimeout(room.timer);
  if(!room.auction) return;
  const delay=Math.max(100,room.auction.endsAt-Date.now());
  room.timer=setTimeout(()=>finishPlayer(room),delay);
}
function finishPlayer(room){
  if(!room.auction) return;
  const a=room.auction;
  if(a.bidder){
    const team=room.teams.get(a.bidder.team);
    if(team && team.purse>=a.bid){
      team.purse-=a.bid; team.squad.push(a.player); if(a.player.country!=="India") team.overseas++;
      addFeed(room,`SOLD • ${a.player.name} → ${a.bidder.team} for ₹${(a.bid/100).toFixed(2)} Cr`);
    }
  } else addFeed(room,`UNSOLD • ${a.player.name}`);
  broadcast(room,snapshot(room));
  setTimeout(()=>nextPlayer(room),900);
}
function canBid(room,p,amount){
  const team=room.teams.get(p.team); const a=room.auction;
  if(!a || !team || p.spectator || !p.online) return false;
  if(team.squad.length>=25) return false;
  if(a.player.country!=="India" && team.overseas>=8) return false;
  return team.purse>=amount;
}

const mime={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml"};
const server=http.createServer(async (req,res)=>{
  let u=(req.url||"/").split("?")[0];
  if(u==="/players.json") {
    const players=await loadPlayerPool();
    res.writeHead(players.length>=500?200:503,{"Content-Type":"application/json","Cache-Control":"no-store"});
    return res.end(JSON.stringify({count:players.length,players}));
  }
  if(u==="/")u="/index.html";
  const file=path.join(__dirname,"public",u);
  if(!file.startsWith(path.join(__dirname,"public"))) return res.writeHead(403).end();
  fs.readFile(file,(e,d)=>{ if(e)return res.writeHead(404).end("Not found"); res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"}); res.end(d);});
});
const wss=new WebSocket.Server({server});

wss.on("connection",ws=>{
  let room=null, player=null;
  send(ws,{type:"hello"});
  ws.on("message",async raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    if(m.type==="create"){
      room=makeRoom(null,m.mode,m.settings); player={id:id(),name:m.name||"Host",team:m.team,spectator:false,online:true,ws};
      room.host=player.id; room.players.set(player.id,player); ws.send(JSON.stringify({type:"joined",id:player.id,code:room.code,host:true})); broadcast(room,snapshot(room)); return;
    }
    if(m.type==="join"){
      room=rooms.get((m.code||"").toUpperCase()); if(!room)return send(ws,{type:"error",msg:"Room not found"});
      if(room.players.size>=10 && !m.spectator)return send(ws,{type:"error",msg:"Room is full"});
      if([...room.players.values()].some(p=>!p.spectator&&p.team===m.team))return send(ws,{type:"error",msg:"That team is already taken"});
      player={id:id(),name:m.name||"Player",team:m.team,spectator:!!m.spectator,online:true,ws};
      room.players.set(player.id,player); send(ws,{type:"joined",id:player.id,code:room.code,host:false}); addFeed(room,`${player.name} joined${player.spectator?" as spectator":""}`); broadcast(room,snapshot(room)); return;
    }
    if(!room||!player)return;
    if(m.type==="start"){
      if(player.id!==room.host)return;
      if(room.started)return;
      const players=await loadPlayerPool();
      if(players.length<500)return send(ws,{type:"error",msg:"Player database is unavailable. Please refresh and try again."});
      startAuction(room,players); return;
    }
    if(m.type==="bid"){
      const a=room.auction; if(!a)return;
      const team=room.teams.get(player.team); const amount=nextBid(a.bid,a.player.baseLakh);
      if(!canBid(room,player,amount))return send(ws,{type:"error",msg:"Bid not allowed"});
      a.bid=amount; a.bidder={id:player.id,name:player.name,team:player.team};
      a.endsAt=Date.now()+room.settings.reset*1000;
      addFeed(room,`${player.team} bids ₹${(amount/100).toFixed(2)} Cr for ${a.player.name}`);
      broadcast(room,snapshot(room)); scheduleTimer(room); return;
    }
    if(m.type==="unsold"){
      if(player.id!==room.host||!room.auction)return;
      clearTimeout(room.timer); addFeed(room,`UNSOLD • ${room.auction.player.name}`); broadcast(room,snapshot(room)); setTimeout(()=>nextPlayer(room),300); return;
    }
    if(m.type==="next"){
      if(player.id!==room.host)return;
      clearTimeout(room.timer); nextPlayer(room); return;
    }
    if(m.type==="chat"){
      const text=String(m.text||"").trim().slice(0,300);
      if(!text)return;
      room.chat.push({t:Date.now(),name:player.name,text});
      if(room.chat.length>200)room.chat.shift();
      broadcast(room,snapshot(room));
      return;
    }
    if(m.type==="settings"){
      if(player.id!==room.host)return;
      if(m.timer)room.settings.timer=Math.max(3,Math.min(60,Number(m.timer)));
      if(m.reset)room.settings.reset=Math.max(3,Math.min(30,Number(m.reset)));
      room.settings.accelerated=!!m.accelerated; broadcast(room,snapshot(room)); return;
    }
    if(m.type==="kick"){
      if(player.id!==room.host)return;
      const target=room.players.get(m.id); if(target){ send(target.ws,{type:"kicked"}); target.ws.close(); room.players.delete(m.id); addFeed(room,`${target.name} was removed by the host`); broadcast(room,snapshot(room)); } return;
    }
  });
  ws.on("close",()=>{
    if(room&&player){ player.online=false; addFeed(room,`${player.name} went offline`); broadcast(room,snapshot(room)); }
  });
});

server.listen(PORT,()=>console.log(`VRAMP Auction running on ${PORT}`));
