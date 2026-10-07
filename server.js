const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const rooms = new Map();

const TEAMS = [
  "MI", "CSK", "RCB", "KKR", "DC",
  "PBKS", "RR", "SRH", "GT", "LSG"
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function makeId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function makeRoomCode() {
  let code;
  do {
    code = makeId();
  } while (rooms.has(code));
  return code;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  for (const player of room.players.values()) {
    send(player.ws, data);
  }
}

function bidIncrement(lakh) {
  if (lakh < 100) return 5;
  if (lakh < 500) return 10;
  return 25;
}

function nextBid(current, base) {
  return Math.max(current, base) + bidIncrement(Math.max(current, base));
}

function createTeams() {
  const teams = new Map();

  for (const team of TEAMS) {
    teams.set(team, {
      purse: 12000,
      squad: [],
      overseas: 0
    });
  }

  return teams;
}

function createRoom(mode, settings) {
  const code = makeRoomCode();

  const room = {
    code,
    mode: mode || "mega",

    settings: {
      timer: Number(settings?.timer) || 10,
      reset: Number(settings?.reset) || 5,
      accelerated: settings?.accelerated !== false
    },

    players: new Map(),
    teams: createTeams(),

    started: false,
    playerPool: [],
    index: 0,
    auction: null,

    feed: [],
    timer: null
  };

  rooms.set(code, room);

  return room;
}

function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    status: room.started ? "live" : "waiting",

    players: [...room.players.values()]
      .filter(p => !p.spectator)
      .map(p => ({
        id: p.id,
        name: p.name,
        team: p.team,
        online: p.online
      })),

    spectators: [...room.players.values()]
      .filter(p => p.spectator).length
  };
}

function snapshot(room) {
  return {
    type: "state",

    room: publicRoom(room),

    settings: room.settings,

    started: room.started,

    auction: room.auction
      ? {
          index: room.index,
          total: room.playerPool.length,
          player: room.auction.player,
          bid: room.auction.bid,
          bidder: room.auction.bidder,
          endsAt: room.auction.endsAt,
          paused: room.auction.paused
        }
      : null,

    teams: Object.fromEntries(
      [...room.teams.entries()].map(([team, data]) => [
        team,
        {
          purse: data.purse,
          squad: data.squad,
          overseas: data.overseas
        }
      ])
    ),

    feed: room.feed.slice(-50)
  };
}

function addFeed(room, text) {
  room.feed.push({
    time: Date.now(),
    text
  });

  if (room.feed.length > 100) {
    room.feed.shift();
  }
}

function startNextPlayer(room) {
  clearTimeout(room.timer);

  if (
    !room.playerPool ||
    room.index >= room.playerPool.length
  ) {
    room.auction = null;
    room.started = false;

    addFeed(room, "🏆 AUCTION FINISHED");

    broadcast(room, snapshot(room));
    broadcast(room, {
      type: "finished"
    });

    return;
  }

  const player = room.playerPool[room.index];

  room.index++;

  room.auction = {
    player,

    bid: Number(player.baseLakh) || 20,

    bidder: null,

    endsAt:
      Date.now() +
      room.settings.timer * 1000,

    paused: false
  };

  addFeed(
    room,
    `🔨 NOW UP: ${player.name} • Base ₹${(
      room.auction.bid / 100
    ).toFixed(2)} Cr`
  );

  broadcast(room, snapshot(room));

  startTimer(room);
}

function startTimer(room) {
  clearTimeout(room.timer);

  if (!room.auction) return;

  const delay = Math.max(
    100,
    room.auction.endsAt - Date.now()
  );

  room.timer = setTimeout(() => {
    finishPlayer(room);
  }, delay);
}

function finishPlayer(room) {
  if (!room.auction) return;

  clearTimeout(room.timer);

  const auction = room.auction;

  if (auction.bidder) {
    const team = room.teams.get(
      auction.bidder.team
    );

    if (
      team &&
      team.purse >= auction.bid &&
      team.squad.length < 25
    ) {
      team.purse -= auction.bid;

      team.squad.push({
        ...auction.player,
        boughtFor: auction.bid
      });

      if (
        auction.player.country &&
        auction.player.country !== "India"
      ) {
        team.overseas++;
      }

      addFeed(
        room,
        `🔨 SOLD • ${auction.player.name} → ${auction.bidder.team} for ₹${(
          auction.bid / 100
        ).toFixed(2)} Cr`
      );
    } else {
      addFeed(
        room,
        `❌ UNSOLD • ${auction.player.name}`
      );
    }
  } else {
    addFeed(
      room,
      `❌ UNSOLD • ${auction.player.name}`
    );
  }

  broadcast(room, snapshot(room));

  room.auction = null;

  setTimeout(() => {
    startNextPlayer(room);
  }, 1000);
}

function canBid(room, player, amount) {
  const auction = room.auction;

  if (!auction) return false;

  if (!player) return false;

  if (player.spectator) return false;

  if (!player.online) return false;

  const team = room.teams.get(player.team);

  if (!team) return false;

  if (team.squad.length >= 25) return false;

  const overseas =
    auction.player.country &&
    auction.player.country !== "India";

  if (overseas && team.overseas >= 8) {
    return false;
  }

  if (team.purse < amount) {
    return false;
  }

  return true;
}

function sendError(ws, message) {
  send(ws, {
    type: "error",
    msg: message
  });
}

/* ---------------- HTTP SERVER ---------------- */

const server = http.createServer((req, res) => {
  let url = (req.url || "/").split("?")[0];

  if (url === "/") {
    url = "/index.html";
  }

  const publicDir = path.join(
    __dirname,
    "public"
  );

  const filePath = path.join(
    publicDir,
    url
  );

  if (
    !filePath.startsWith(publicDir)
  ) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }

    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(filePath)] ||
        "application/octet-stream",

      "Cache-Control":
        "no-store"
    });

    res.end(data);
  });
});

/* ---------------- WEBSOCKET ---------------- */

const wss = new WebSocket.Server({
  server
});

wss.on("connection", ws => {
  let room = null;
  let player = null;

  send(ws, {
    type: "hello"
  });

  ws.on("message", raw => {
    let message;

    try {
      message = JSON.parse(
        raw.toString()
      );
    } catch {
      return;
    }

    /* CREATE ROOM */

    if (message.type === "create") {
      room = createRoom(
        message.mode,
        message.settings
      );

      player = {
        id: makeId(),

        name:
          message.name ||
          "Host",

        team:
          message.team ||
          "MI",

        spectator: false,

        online: true,

        ws
      };

      room.host = player.id;

      room.players.set(
        player.id,
        player
      );

      send(ws, {
        type: "joined",

        id: player.id,

        code: room.code,

        host: true
      });

      addFeed(
        room,
        `👑 ${player.name} created the room`
      );

      broadcast(
        room,
        snapshot(room)
      );

      return;
    }

    /* JOIN ROOM */

    if (message.type === "join") {
      const code =
        (message.code || "")
          .trim()
          .toUpperCase();

      room = rooms.get(code);

      if (!room) {
        return sendError(
          ws,
          "Room not found"
        );
      }

      if (
        !message.spectator &&
        room.players.size >= 10
      ) {
        return sendError(
          ws,
          "Room is full"
        );
      }

      if (
        !message.spectator &&
        [...room.players.values()].some(
          p =>
            !p.spectator &&
            p.team === message.team
        )
      ) {
        return sendError(
          ws,
          "That team is already taken"
        );
      }

      player = {
        id: makeId(),

        name:
          message.name ||
          "Player",

        team:
          message.team ||
          "MI",

        spectator:
          Boolean(message.spectator),

        online: true,

        ws
      };

      room.players.set(
        player.id,
        player
      );

      send(ws, {
        type: "joined",

        id: player.id,

        code: room.code,

        host: false
      });

      addFeed(
        room,
        `👤 ${player.name} joined${
          player.spectator
            ? " as spectator"
            : ""
        }`
      );

      broadcast(
        room,
        snapshot(room)
      );

      return;
    }

    if (!room || !player) {
      return;
    }

    /* START AUCTION */

    if (message.type === "start") {
      if (player.id !== room.host) {
        return sendError(
          ws,
          "Only the host can start"
        );
      }

      if (room.started) {
        return;
      }

      const players =
        Array.isArray(message.players)
          ? message.players
          : [];

      if (!players.length) {
        return sendError(
          ws,
          "Player pool is empty"
        );
      }

      room.playerPool = players;
      room.index = 0;
      room.started = true;

      addFeed(
        room,
        `🏏 Auction started with ${players.length} players`
      );

      startNextPlayer(room);

      return;
    }

    /* BID */

    if (message.type === "bid") {
      if (!room.started) return;

      if (!room.auction) return;

      const amount = nextBid(
        room.auction.bid,
        room.auction.player.baseLakh
      );

      if (
        !canBid(
          room,
          player,
          amount
        )
      ) {
        return sendError(
          ws,
          "Bid not allowed"
        );
      }

      room.auction.bid =
        amount;

      room.auction.bidder = {
        id: player.id,

        name: player.name,

        team: player.team
      };

      room.auction.endsAt =
        Date.now() +
        room.settings.reset * 1000;

      addFeed(
        room,
        `💰 ${player.team} bids ₹${(
          amount / 100
        ).toFixed(2)} Cr for ${
          room.auction.player.name
        }`
      );

      broadcast(
        room,
        snapshot(room)
      );

      startTimer(room);

      return;
    }

    /* CHAT */

    if (message.type === "chat") {
      const text =
        String(message.text || "")
          .trim()
          .slice(0, 300);

      if (!text) return;

      broadcast(room, {
        type: "chat",

        message: {
          id: makeId(),

          name: player.name,

          team: player.team,

          text,

          time: Date.now()
        }
      });

      addFeed(
        room,
        `💬 ${player.name}: ${text}`
      );

      return;
    }

    /* UNSOLD */

    if (message.type === "unsold") {
      if (player.id !== room.host) {
        return;
      }

      if (!room.auction) return;

      clearTimeout(room.timer);

      addFeed(
        room,
        `❌ UNSOLD • ${room.auction.player.name}`
      );

      room.auction = null;

      broadcast(
        room,
        snapshot(room)
      );

      setTimeout(() => {
        startNextPlayer(room);
      }, 500);

      return
