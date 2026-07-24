// Psych! online multiplayer server — Express + Socket.IO.
// Each player joins from their own phone using a 4-letter room code.
const path = require("path");
const os = require("os");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { DECKS } = require("./server-questions");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4000;
const POINTS_CORRECT = 1000;
const POINTS_FOOL = 500;

/** rooms[code] = room */
const rooms = {};

/* ---------------- helpers ---------------- */
function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms[code]);
  return code;
}
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function activePlayers(room) {
  return room.order_players.filter((p) => room.players[p] && room.players[p].connected);
}
function deckList() {
  return Object.entries(DECKS).map(([key, d]) => ({
    key, name: d.name, emoji: d.emoji, blurb: d.blurb, size: d.questions.length,
  }));
}

/* ---------------- per-player sanitized state ---------------- */
function viewFor(room, sid) {
  const me = room.players[sid];
  const base = {
    code: room.code,
    phase: room.phase,
    isHost: room.hostId === sid,
    round: room.round,
    totalRounds: room.totalRounds,
    deckName: room.deckKey ? DECKS[room.deckKey].name : null,
    decks: deckList(),
    me: me ? { name: me.name, score: me.score, avatar: me.avatar || null } : null,
    players: room.order_players
      .filter((id) => room.players[id])
      .map((id) => {
        const p = room.players[id];
        let submitted = false;
        if (room.phase === "bluff") submitted = room.bluffs.some((b) => b.byId === id);
        if (room.phase === "guess") submitted = room.guesses[id] != null;
        return { name: p.name, score: p.score, connected: p.connected, submitted, isHost: room.hostId === id, avatar: p.avatar || null };
      }),
  };

  if (room.phase === "bluff") {
    base.prompt = room.current.prompt;
    base.mySubmitted = room.bluffs.some((b) => b.byId === sid);
  }

  if (room.phase === "guess") {
    base.prompt = room.current.prompt;
    base.myGuessed = room.guesses[sid] != null;
    base.options = room.options.map((opt, i) => ({
      i, text: opt.text, mine: opt.byId === sid,
    }));
  }

  if (room.phase === "reveal") {
    base.prompt = room.current.prompt;
    base.reveal = room.options.map((opt) => {
      const voters = Object.entries(room.guesses)
        .filter(([, gi]) => gi != null && room.options[gi] === opt)
        .map(([pid]) => room.players[pid] && room.players[pid].name)
        .filter(Boolean);
      const author = opt.byId === "REAL" ? null : room.players[opt.byId];
      return {
        text: opt.text,
        isReal: opt.byId === "REAL" || opt.isTruthDup === true,
        author: opt.byId === "REAL" ? null : (author ? author.name : "(left)"),
        authorAvatar: author ? author.avatar || null : null,
        voters,
      };
    });
    base.gains = room.order_players
      .filter((id) => room.players[id])
      .map((id) => ({ name: room.players[id].name, score: room.players[id].score, gain: room.roundGain[id] || 0, avatar: room.players[id].avatar || null }))
      .sort((a, b) => b.score - a.score);

    // Personalised "who psych'd whom" result for this player.
    const myGuessIdx = room.guesses[sid];
    const myResult = { answered: myGuessIdx != null, gotTruth: false, psychedBy: null, iPsyched: [] };
    if (myGuessIdx != null) {
      const opt = room.options[myGuessIdx];
      if (opt && (opt.byId === "REAL" || opt.isTruthDup)) {
        myResult.gotTruth = true;
      } else if (opt) {
        const a = room.players[opt.byId];
        myResult.psychedBy = { name: a ? a.name : "(left)", avatar: a ? a.avatar || null : null };
      }
    }
    // Players I fooled this round (they picked my bluff).
    for (const [pid, gi] of Object.entries(room.guesses)) {
      if (pid === sid || gi == null) continue;
      const opt = room.options[gi];
      if (opt && opt.byId === sid && !opt.isTruthDup) {
        const pl = room.players[pid];
        myResult.iPsyched.push({ name: pl ? pl.name : "(left)", avatar: pl ? pl.avatar || null : null });
      }
    }
    base.myResult = myResult;
  }

  if (room.phase === "end") {
    base.finalBoard = room.order_players
      .filter((id) => room.players[id])
      .map((id) => ({ name: room.players[id].name, score: room.players[id].score, avatar: room.players[id].avatar || null }))
      .sort((a, b) => b.score - a.score);
  }

  return base;
}

function broadcast(room) {
  if (!room) return;
  for (const sid of Object.keys(room.players)) {
    io.to(sid).emit("state", viewFor(room, sid));
  }
}

/* ---------------- game flow ---------------- */
function startRound(room) {
  room.round++;
  if (room.round > room.totalRounds) {
    room.phase = "end";
    broadcast(room);
    return;
  }
  const deck = DECKS[room.deckKey];
  room.current = deck.questions[room.order[room.round - 1]];
  room.bluffs = [{ text: room.current.answer, byId: "REAL" }];
  room.guesses = {};
  room.roundGain = {};
  room.options = [];
  room.phase = "bluff";
  broadcast(room);
}

function maybeAdvanceFromBluff(room) {
  const needed = activePlayers(room);
  const done = needed.every((id) => room.bluffs.some((b) => b.byId === id));
  if (needed.length > 0 && done) {
    room.options = shuffle(room.bluffs);
    room.phase = "guess";
  }
  broadcast(room);
}

function maybeAdvanceFromGuess(room) {
  const needed = activePlayers(room);
  const done = needed.every((id) => room.guesses[id] != null);
  if (needed.length > 0 && done) {
    scoreRound(room);
    room.phase = "reveal";
  }
  broadcast(room);
}

function scoreRound(room) {
  room.roundGain = {};
  for (const [pid, optIdx] of Object.entries(room.guesses)) {
    if (optIdx == null) continue;
    const chosen = room.options[optIdx];
    if (!chosen) continue;
    if (chosen.byId === "REAL" || chosen.isTruthDup) {
      room.players[pid] && (room.players[pid].score += POINTS_CORRECT);
      room.roundGain[pid] = (room.roundGain[pid] || 0) + POINTS_CORRECT;
    } else {
      const author = chosen.byId;
      if (room.players[author]) {
        room.players[author].score += POINTS_FOOL;
        room.roundGain[author] = (room.roundGain[author] || 0) + POINTS_FOOL;
      }
    }
  }
}

/* ---------------- socket handlers ---------------- */
io.on("connection", (socket) => {
  socket.data.roomCode = null;

  socket.on("create", ({ name, avatar }, cb) => {
    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      phase: "lobby",
      deckKey: null,
      totalRounds: 5,
      round: 0,
      order: [],
      order_players: [socket.id],
      players: {},
      current: null,
      bluffs: [],
      options: [],
      guesses: {},
      roundGain: {},
    };
    room.players[socket.id] = { name: cleanName(name), score: 0, connected: true, avatar: cleanAvatar(avatar) };
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    cb && cb({ ok: true, code });
    broadcast(room);
  });

  socket.on("join", ({ code, name, avatar }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: "Room not found." });
    if (room.phase !== "lobby") return cb && cb({ ok: false, error: "Game already started." });
    if (Object.keys(room.players).length >= 8) return cb && cb({ ok: false, error: "Room is full (8 max)." });
    room.players[socket.id] = { name: cleanName(name), score: 0, connected: true, avatar: cleanAvatar(avatar) };
    room.order_players.push(socket.id);
    socket.join(code);
    socket.data.roomCode = code;
    cb && cb({ ok: true, code });
    broadcast(room);
  });

  socket.on("start", ({ deckKey, rounds }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.id || room.phase !== "lobby") return;
    if (!DECKS[deckKey]) return;
    if (Object.keys(room.players).length < 2) return;
    const deck = DECKS[deckKey];
    room.deckKey = deckKey;
    room.totalRounds = Math.max(1, Math.min(Number(rounds) || 5, deck.questions.length));
    room.order = shuffle(deck.questions.map((_, i) => i)).slice(0, room.totalRounds);
    Object.values(room.players).forEach((p) => (p.score = 0));
    room.round = 0;
    startRound(room);
  });

  socket.on("bluff", ({ text }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "bluff") return;
    if (!room.players[socket.id]) return;
    if (room.bluffs.some((b) => b.byId === socket.id)) return; // already submitted
    text = String(text || "").trim().slice(0, 80);
    if (!text) return;
    const isTruthDup = text.toLowerCase() === room.current.answer.toLowerCase();
    room.bluffs.push({ text, byId: socket.id, isTruthDup });
    maybeAdvanceFromBluff(room);
  });

  socket.on("guess", ({ optionIndex }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "guess") return;
    if (!room.players[socket.id]) return;
    if (room.guesses[socket.id] != null) return;
    const opt = room.options[optionIndex];
    if (!opt) return;
    if (opt.byId === socket.id) return; // can't pick own bluff
    room.guesses[socket.id] = optionIndex;
    maybeAdvanceFromGuess(room);
  });

  socket.on("next", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.id || room.phase !== "reveal") return;
    startRound(room);
  });

  socket.on("restart", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.phase = "lobby";
    room.deckKey = null;
    room.round = 0;
    Object.values(room.players).forEach((p) => (p.score = 0));
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].connected = false;

    // In lobby, fully remove the player.
    if (room.phase === "lobby") {
      delete room.players[socket.id];
      room.order_players = room.order_players.filter((id) => id !== socket.id);
    }

    // Reassign host if needed.
    if (room.hostId === socket.id) {
      const next = room.order_players.find((id) => room.players[id] && room.players[id].connected);
      if (next) room.hostId = next;
    }

    // Delete empty rooms.
    const anyConnected = Object.values(room.players).some((p) => p.connected);
    if (!anyConnected) {
      delete rooms[room.code];
      return;
    }

    // A disconnect may unblock a waiting phase.
    if (room.phase === "bluff") return maybeAdvanceFromBluff(room);
    if (room.phase === "guess") return maybeAdvanceFromGuess(room);
    broadcast(room);
  });
});

function cleanName(name) {
  return String(name || "Player").trim().slice(0, 16) || "Player";
}

// Accept only small JPEG/PNG/WebP data URLs (client resizes to ~96px thumbnails).
function cleanAvatar(a) {
  if (typeof a !== "string") return null;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(a)) return null;
  if (a.length > 80000) return null; // ~60 KB cap
  return a;
}

/* ---------------- boot ---------------- */
server.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    }
  }
  console.log("\n🧠  PSYCH! server running\n");
  console.log(`   On this PC:      http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`   On the network:  http://${ip}:${PORT}`));
  console.log("\n   Players: connect phones to the SAME Wi-Fi and open a network URL above.\n");
});
