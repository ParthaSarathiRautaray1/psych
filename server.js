// Psych! online multiplayer server — Express + Socket.IO.
// Each player joins from their own phone using a 4-letter room code.
// Players are keyed by a STABLE pid (not the socket id) so a phone can
// refresh / drop off and resume the same seat with the same score.
const path = require("path");
const os = require("os");
const crypto = require("crypto");
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
const GRACE_MS = 45000;      // how long teammates wait for a dropped player before skipping them
const EMPTY_ROOM_MS = 120000; // keep an all-empty room alive this long so everyone can resume

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
function makePid() {
  return crypto.randomBytes(9).toString("base64url");
}
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// Players we still expect to act this phase: present and not abandoned (i.e.
// connected, or dropped but still inside the grace window).
function neededPlayers(room) {
  return room.order_players.filter((pid) => room.players[pid] && !room.abandoned.has(pid));
}
function connectedCount(room) {
  return Object.values(room.players).filter((p) => p.connected).length;
}
function deckList() {
  return Object.entries(DECKS).map(([key, d]) => ({
    key, name: d.name, emoji: d.emoji, blurb: d.blurb, size: d.questions.length,
  }));
}

/* ---------------- text normalisation (Task 1) ---------------- */
// Curated real answers are already sensibly cased, so they render as-is.
// Bluffs typed in ALL CAPS or all-lowercase get sentence-cased so casing can
// never be a tell; deliberately mixed-case bluffs are left alone.
function normalizeBluff(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const letters = t.replace(/[^A-Za-z]/g, "");
  const allCaps = letters.length > 0 && letters === letters.toUpperCase();
  const allLower = letters.length > 0 && letters === letters.toLowerCase();
  if (allCaps || allLower) {
    const body = allCaps ? t.toLowerCase() : t;
    return body.charAt(0).toUpperCase() + body.slice(1);
  }
  return t;
}

/* ---------------- per-player sanitized state ---------------- */
function viewFor(room, pid) {
  const me = room.players[pid];
  const base = {
    code: room.code,
    phase: room.phase,
    isHost: room.hostId === pid,
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
    base.mySubmitted = room.bluffs.some((b) => b.byId === pid);
  }

  if (room.phase === "guess") {
    base.prompt = room.current.prompt;
    base.myGuessed = room.guesses[pid] != null;
    base.options = room.options.map((opt, i) => ({
      i, text: opt.text, mine: opt.byId === pid,
    }));
  }

  if (room.phase === "reveal") {
    base.prompt = room.current.prompt;
    base.reveal = room.options.map((opt) => {
      const voters = Object.entries(room.guesses)
        .filter(([, gi]) => gi != null && room.options[gi] === opt)
        .map(([id]) => room.players[id] && room.players[id].name)
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
    const myGuessIdx = room.guesses[pid];
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
    for (const [id, gi] of Object.entries(room.guesses)) {
      if (id === pid || gi == null) continue;
      const opt = room.options[gi];
      if (opt && opt.byId === pid && !opt.isTruthDup) {
        const pl = room.players[id];
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
  for (const pid of Object.keys(room.players)) {
    const p = room.players[pid];
    if (p.connected && p.socketId) io.to(p.socketId).emit("state", viewFor(room, pid));
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
  const needed = neededPlayers(room);
  const done = needed.every((id) => room.bluffs.some((b) => b.byId === id));
  if (needed.length > 0 && done) {
    room.options = shuffle(room.bluffs);
    room.phase = "guess";
  }
  broadcast(room);
}

function maybeAdvanceFromGuess(room) {
  const needed = neededPlayers(room);
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

/* ---------------- membership helpers ---------------- */
function reassignHostIfNeeded(room, leavingPid) {
  if (room.hostId !== leavingPid) return;
  const next = room.order_players.find((id) => room.players[id] && room.players[id].connected);
  if (next) room.hostId = next;
}

// Fully remove a player from the room (explicit leave, or a lobby drop).
function removePlayer(room, pid) {
  clearGrace(room, pid);
  room.abandoned.delete(pid);
  delete room.players[pid];
  room.order_players = room.order_players.filter((id) => id !== pid);
  reassignHostIfNeeded(room, pid);
}

function clearGrace(room, pid) {
  if (room.dcTimers[pid]) { clearTimeout(room.dcTimers[pid]); delete room.dcTimers[pid]; }
}

function scheduleEmptyRoomCleanup(room) {
  if (room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    const r = rooms[room.code];
    if (r && connectedCount(r) === 0) delete rooms[room.code];
  }, EMPTY_ROOM_MS);
}
function cancelEmptyRoomCleanup(room) {
  if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
}

/* ---------------- socket handlers ---------------- */
io.on("connection", (socket) => {
  socket.data.roomCode = null;
  socket.data.pid = null;

  function attach(room, pid) {
    socket.data.roomCode = room.code;
    socket.data.pid = pid;
    socket.join(room.code);
  }

  socket.on("create", ({ name, avatar }, cb) => {
    const code = makeCode();
    const pid = makePid();
    const room = {
      code,
      hostId: pid,
      phase: "lobby",
      deckKey: null,
      totalRounds: 5,
      round: 0,
      order: [],
      order_players: [pid],
      players: {},
      current: null,
      bluffs: [],
      options: [],
      guesses: {},
      roundGain: {},
      abandoned: new Set(),
      dcTimers: {},
      emptyTimer: null,
    };
    room.players[pid] = { pid, name: cleanName(name), score: 0, connected: true, avatar: cleanAvatar(avatar), socketId: socket.id };
    rooms[code] = room;
    attach(room, pid);
    cb && cb({ ok: true, code, pid });
    broadcast(room);
  });

  socket.on("join", ({ code, name, avatar }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: "Room not found." });
    if (room.phase !== "lobby") return cb && cb({ ok: false, error: "Game already started." });
    if (Object.keys(room.players).length >= 8) return cb && cb({ ok: false, error: "Room is full (8 max)." });
    const pid = makePid();
    room.players[pid] = { pid, name: cleanName(name), score: 0, connected: true, avatar: cleanAvatar(avatar), socketId: socket.id };
    room.order_players.push(pid);
    cancelEmptyRoomCleanup(room);
    attach(room, pid);
    cb && cb({ ok: true, code, pid });
    broadcast(room);
  });

  // Resume the same seat after a refresh / brief disconnect (Task 2).
  socket.on("resume", ({ code, pid }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: "Room no longer exists." });
    const p = room.players[pid];
    if (!p) return cb && cb({ ok: false, error: "Your seat is gone." });
    p.connected = true;
    p.socketId = socket.id;
    room.abandoned.delete(pid);
    clearGrace(room, pid);
    cancelEmptyRoomCleanup(room);
    attach(room, pid);
    cb && cb({ ok: true, code, pid });
    // Resuming may satisfy a phase that had skipped them, or just refresh views.
    broadcast(room);
  });

  socket.on("start", ({ deckKey, rounds }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.data.pid || room.phase !== "lobby") return;
    if (!DECKS[deckKey]) return;
    if (Object.keys(room.players).length < 2) return;
    const deck = DECKS[deckKey];
    room.deckKey = deckKey;
    room.totalRounds = Math.max(1, Math.min(Number(rounds) || 5, deck.questions.length));
    room.order = shuffle(deck.questions.map((_, i) => i)).slice(0, room.totalRounds);
    Object.values(room.players).forEach((p) => (p.score = 0));
    room.abandoned.clear();
    room.round = 0;
    startRound(room);
  });

  socket.on("bluff", ({ text }) => {
    const room = rooms[socket.data.roomCode];
    const pid = socket.data.pid;
    if (!room || room.phase !== "bluff" || !room.players[pid]) return;
    if (room.bluffs.some((b) => b.byId === pid)) return; // already submitted
    text = normalizeBluff(String(text || "").slice(0, 80));
    if (!text) return;
    const isTruthDup = text.toLowerCase() === room.current.answer.toLowerCase();
    room.bluffs.push({ text, byId: pid, isTruthDup });
    maybeAdvanceFromBluff(room);
  });

  socket.on("guess", ({ optionIndex }) => {
    const room = rooms[socket.data.roomCode];
    const pid = socket.data.pid;
    if (!room || room.phase !== "guess" || !room.players[pid]) return;
    if (room.guesses[pid] != null) return;
    const opt = room.options[optionIndex];
    if (!opt) return;
    if (opt.byId === pid) return; // can't pick own bluff
    room.guesses[pid] = optionIndex;
    maybeAdvanceFromGuess(room);
  });

  socket.on("next", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.data.pid || room.phase !== "reveal") return;
    startRound(room);
  });

  socket.on("restart", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.data.pid) return;
    room.phase = "lobby";
    room.deckKey = null;
    room.round = 0;
    room.abandoned.clear();
    Object.values(room.players).forEach((p) => (p.score = 0));
    broadcast(room);
  });

  // Explicit leave (back-to-home button / browser back) — free the seat.
  socket.on("leave", () => {
    const room = rooms[socket.data.roomCode];
    const pid = socket.data.pid;
    socket.data.roomCode = null;
    socket.data.pid = null;
    if (!room || !room.players[pid]) return;
    socket.leave(room.code);
    removePlayer(room, pid);
    if (connectedCount(room) === 0) { scheduleEmptyRoomCleanup(room); return; }
    if (room.phase === "bluff") return maybeAdvanceFromBluff(room);
    if (room.phase === "guess") return maybeAdvanceFromGuess(room);
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = rooms[socket.data.roomCode];
    const pid = socket.data.pid;
    if (!room || !room.players[pid]) return;
    const p = room.players[pid];
    // Ignore a stale socket whose seat was already taken over by a resume.
    if (p.socketId && p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;

    // In the lobby there's no state to preserve — drop them.
    if (room.phase === "lobby") {
      removePlayer(room, pid);
      if (connectedCount(room) === 0) { scheduleEmptyRoomCleanup(room); return; }
      return broadcast(room);
    }

    reassignHostIfNeeded(room, pid);

    // Mid-game: teammates WAIT for them (they can resume by room code) until a
    // grace timer expires, then the round proceeds without them.
    clearGrace(room, pid);
    room.dcTimers[pid] = setTimeout(() => {
      const r = rooms[room.code];
      if (!r || !r.players[pid]) return;
      r.abandoned.add(pid);
      delete r.dcTimers[pid];
      if (r.phase === "bluff") maybeAdvanceFromBluff(r);
      else if (r.phase === "guess") maybeAdvanceFromGuess(r);
      else broadcast(r);
    }, GRACE_MS);

    if (connectedCount(room) === 0) scheduleEmptyRoomCleanup(room);
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
