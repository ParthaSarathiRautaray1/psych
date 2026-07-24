// Psych! online client — talks to the server over Socket.IO.
const socket = io();
const $ = (id) => document.getElementById(id);

let selectedDeck = null;
let selectedAvatar = null; // data URL or null
let lastPhase = null;
let currentCode = "";
let lobbyPlayerCount = 0;
let inGame = false;      // true while seated in a room (lobby → reveal)
let guardActive = false; // true only during live rounds (bluff/guess/reveal)

const screens = {};
["home", "lobby", "bluff", "guess", "reveal", "end"].forEach((n) => (screens[n] = $("screen-" + n)));
function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

/* ---------------- session persistence (Task 2: resume after refresh) ---------------- */
const SESSION_KEY = "psych_session";
const PROFILE_KEY = "psych_profile";
function saveSession(code, pid) { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code, pid })); } catch (e) {} }
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; } }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }
function saveProfile() {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: $("myName").value.trim(), avatar: selectedAvatar })); } catch (e) {}
}
function restoreProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    if (!p) return;
    if (p.name) $("myName").value = p.name;
    if (p.avatar) { selectedAvatar = p.avatar; setAvatarPreview(p.avatar); }
  } catch (e) {}
}

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function hueFor(name) {
  let h = 0;
  const s = String(name || "?");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
// Renders an avatar (photo if present, else coloured initial). size: "", "sm", "lg", "xl".
function avatar(p, size) {
  const cls = "avatar" + (size ? " " + size : "");
  if (p && p.avatar) return `<span class="${cls}" style="background-image:url('${p.avatar}')"></span>`;
  const initial = esc((p && p.name ? p.name.trim()[0] : "?") || "?").toUpperCase();
  return `<span class="${cls}" style="background:hsl(${hueFor(p && p.name)},55%,45%)">${initial}</span>`;
}

/* ---------------- avatar upload (client-side resize) ---------------- */
function setAvatarPreview(dataUrl) {
  const prev = $("avatarPreview");
  prev.classList.remove("placeholder");
  prev.textContent = "";
  prev.style.backgroundImage = `url('${dataUrl}')`;
}
$("avatarInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const SIZE = 96;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(SIZE / img.width, SIZE / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
      selectedAvatar = canvas.toDataURL("image/jpeg", 0.7);
      setAvatarPreview(selectedAvatar);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

/* ---------------- connection status ---------------- */
socket.on("connect", () => {
  $("conn").style.display = "none";
  // If we dropped and reconnected while in a game, re-take our seat.
  const sess = loadSession();
  if (sess && sess.code && sess.pid) {
    socket.emit("resume", sess, (res) => {
      if (!res || !res.ok) { clearSession(); if (inGame) resetToHome(); }
    });
  }
});
socket.on("disconnect", () => { $("conn").textContent = "🔴 Disconnected — reconnecting…"; $("conn").style.display = "block"; });
socket.on("connect_error", () => { $("conn").textContent = "🔴 Can't reach server"; $("conn").style.display = "block"; });

/* ---------------- home: create / join ---------------- */
$("createBtn").onclick = () => {
  const name = $("myName").value.trim() || "Host";
  saveProfile();
  socket.emit("create", { name, avatar: selectedAvatar }, (res) => {
    if (res && res.ok) { saveSession(res.code, res.pid); enterGameHistory(); show("lobby"); }
  });
};
$("joinBtn").onclick = () => {
  const name = $("myName").value.trim() || "Player";
  const code = $("joinCode").value.trim().toUpperCase();
  if (!code) { $("joinError").textContent = "Enter a room code."; return; }
  saveProfile();
  socket.emit("join", { code, name, avatar: selectedAvatar }, (res) => {
    if (res && res.ok) { $("joinError").textContent = ""; saveSession(res.code, res.pid); enterGameHistory(); show("lobby"); }
    else $("joinError").textContent = (res && res.error) || "Could not join.";
  });
};
$("joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });

const urlRoom = new URLSearchParams(location.search).get("room");
if (urlRoom) $("joinCode").value = urlRoom.toUpperCase();

/* ---------------- lobby / game actions ---------------- */
$("startBtn").onclick = () => {
  if (!selectedDeck) return;
  socket.emit("start", { deckKey: selectedDeck, rounds: Number($("roundCount").value) || 5 });
};
$("submitBluffBtn").onclick = submitBluff;
$("bluffInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitBluff(); });
function submitBluff() {
  const text = $("bluffInput").value.trim();
  if (!text) return;
  socket.emit("bluff", { text });
  $("bluffInput").value = "";
}
$("nextRoundBtn").onclick = () => socket.emit("next");
$("restartBtn").onclick = () => socket.emit("restart");
$("homeBtn").onclick = () => leaveToHome();
$("copyLink").onclick = () => {
  const link = `${location.origin}/?room=${currentCode}`;
  navigator.clipboard?.writeText(link).then(
    () => { $("copyLink").textContent = "✅ Copied!"; setTimeout(() => ($("copyLink").textContent = "📋 Copy join link"), 1500); },
    () => {}
  );
};

/* ---------------- leaving / home (Task 3: back button) ---------------- */
function resetToHome() {
  inGame = false;
  guardActive = false;
  hideFocusGuard();
  selectedDeck = null;
  currentCode = "";
  lastPhase = null;
  show("home");
}
function leaveToHome() {
  socket.emit("leave");
  clearSession();
  resetToHome();
  // Normalise history so we sit on a single "home" entry.
  try { history.replaceState({ app: "home" }, "", location.pathname); } catch (e) {}
}
// Push a history entry when entering a room so the browser Back button lands
// on our home screen instead of leaving the site.
function enterGameHistory() {
  try {
    if (!history.state || history.state.app !== "game") history.pushState({ app: "game" }, "");
  } catch (e) {}
}
window.addEventListener("popstate", () => {
  // Any back navigation while seated → go to our home screen, don't leave.
  if (inGame || loadSession()) leaveToHome();
});
try { if (!history.state) history.replaceState({ app: "home" }, ""); } catch (e) {}

/* ---------------- decks ---------------- */
function renderDecks(decks) {
  const grid = $("deckGrid");
  if (grid.dataset.built === "1") { updateDeckSelection(); return; }
  grid.innerHTML = "";
  decks.forEach((d) => {
    const el = document.createElement("button");
    el.className = "deck";
    el.dataset.key = d.key;
    el.innerHTML = `<div class="emoji">${d.emoji}</div><h3>${esc(d.name)}</h3><p>${esc(d.blurb)}</p>`;
    el.onclick = () => { selectedDeck = d.key; updateDeckSelection(); refreshStartBtn(); };
    grid.appendChild(el);
  });
  grid.dataset.built = "1";
}
function updateDeckSelection() {
  document.querySelectorAll("#deckGrid .deck").forEach((el) =>
    el.classList.toggle("selected", el.dataset.key === selectedDeck)
  );
}
function refreshStartBtn() { $("startBtn").disabled = !(selectedDeck && lobbyPlayerCount >= 2); }

/* ---------------- main state renderer ---------------- */
socket.on("state", (s) => {
  currentCode = s.code;
  if (s.code && loadSession()) saveSession(s.code, loadSession().pid); // keep code fresh
  const screen = { lobby: "lobby", bluff: "bluff", guess: "guess", reveal: "reveal", end: "end" }[s.phase];
  if (screen) { enterGameHistory(); show(screen); }
  inGame = s.phase !== "end";
  guardActive = s.phase === "bluff" || s.phase === "guess" || s.phase === "reveal";
  if (!guardActive) hideFocusGuard();
  if (s.phase === "end") clearSession(); // game over — safe to close/leave

  if (s.phase === "lobby") renderLobby(s);
  if (s.phase === "bluff") renderBluff(s);
  if (s.phase === "guess") renderGuess(s);
  if (s.phase === "reveal") renderReveal(s);
  if (s.phase === "end") renderEnd(s);
  lastPhase = s.phase;
});

function renderLobby(s) {
  $("roomCode").textContent = s.code;
  lobbyPlayerCount = s.players.length;
  $("lobbyCount").textContent = s.players.length;

  const list = $("lobbyPlayers");
  list.innerHTML = "";
  s.players.forEach((p) => {
    const chip = document.createElement("div");
    chip.className = "player-chip";
    chip.innerHTML = `<span class="who-line">${avatar(p, "sm")}
      <span class="pname">${esc(p.name)}${p.isHost ? " 👑" : ""}</span></span>
      <span class="status ${p.connected ? "" : "away"}">${p.connected ? "ready" : "away"}</span>`;
    list.appendChild(chip);
  });

  if (s.isHost) {
    $("hostControls").style.display = "";
    $("guestWait").style.display = "none";
    renderDecks(s.decks);
    refreshStartBtn();
  } else {
    $("hostControls").style.display = "none";
    $("guestWait").style.display = "";
  }
}

function renderBluff(s) {
  $("bluffDeck").textContent = s.deckName;
  $("bluffRound").textContent = `Round ${s.round} / ${s.totalRounds}`;
  $("bluffPrompt").textContent = s.prompt;
  const waiting = s.mySubmitted;
  $("bluffForm").style.display = waiting ? "none" : "";
  $("bluffWait").style.display = waiting ? "" : "none";
  if (waiting) renderProgress($("bluffProgress"), s.players);
  if (!waiting && lastPhase !== "bluff") $("bluffInput").focus();
}

function renderGuess(s) {
  $("guessRound").textContent = `Round ${s.round} / ${s.totalRounds}`;
  $("guessPrompt").textContent = s.prompt;
  const waiting = s.myGuessed;
  $("guessForm").style.display = waiting ? "none" : "";
  $("guessWait").style.display = waiting ? "" : "none";
  if (!waiting) {
    const box = $("guessOptions");
    box.innerHTML = "";
    s.options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "option" + (opt.mine ? " disabled" : "");
      btn.innerHTML = esc(opt.text) + (opt.mine ? `<span class="tag">your bluff — can't pick this</span>` : "");
      if (opt.mine) btn.disabled = true;
      else btn.onclick = () => socket.emit("guess", { optionIndex: opt.i });
      box.appendChild(btn);
    });
  } else {
    renderProgress($("guessProgress"), s.players);
  }
}

function renderReveal(s) {
  // Personalised "who psych'd whom" banner (Task 5).
  const b = $("revealBanner");
  const r = s.myResult || {};
  let html = "";
  if (r.gotTruth) {
    html = `<div class="result-main good">✅ You found the REAL answer!</div>`;
  } else if (r.psychedBy) {
    html = `<div class="psych-hit">
        ${avatar(r.psychedBy, "xl")}
        <div class="psych-hit-text">
          <div class="result-main bad">😈 You got Psych'd!</div>
          <div class="result-sub">by <strong>${esc(r.psychedBy.name)}</strong></div>
        </div>
      </div>`;
  } else if (!r.answered) {
    html = `<div class="result-main">⏱️ No answer this round</div>`;
  } else {
    html = `<div class="result-main">🤷 Nobody's answer was the truth</div>`;
  }
  if (r.iPsyched && r.iPsyched.length) {
    html += `<div class="i-psyched"><span class="result-sub">🃏 You Psych'd:</span>
      <div class="mini-avatars">${r.iPsyched.map((p) => `<span class="mini">${avatar(p, "sm")}<em>${esc(p.name)}</em></span>`).join("")}</div></div>`;
  }
  b.innerHTML = html;

  $("revealPrompt").textContent = s.prompt;
  const box = $("revealOptions");
  box.innerHTML = "";
  s.reveal.forEach((opt) => {
    const el = document.createElement("div");
    el.className = "option " + (opt.isReal ? "correct" : "wrong");
    const tag = opt.isReal
      ? `<span class="author">✅ THE REAL ANSWER</span>`
      : `<span class="author">${avatar({ name: opt.author, avatar: opt.authorAvatar }, "sm")} bluff by ${esc(opt.author)}</span>`;
    const votedBy = opt.voters.length ? ` · picked by ${esc(opt.voters.join(", "))}` : " · nobody picked this";
    el.innerHTML = `${esc(opt.text)}<span class="tag">${tag}${votedBy}</span>`;
    box.appendChild(el);
  });

  const gains = $("revealGains");
  gains.innerHTML = "";
  s.gains.forEach((g) => {
    const row = document.createElement("div");
    row.className = "score-row";
    row.innerHTML = `<span class="who-line">${avatar(g, "sm")}<span class="name">${esc(g.name)}</span></span>
      <span class="pts">${g.score}${g.gain ? `<span class="gained"> +${g.gain}</span>` : ""}</span>`;
    gains.appendChild(row);
  });

  const last = s.round >= s.totalRounds;
  if (s.isHost) {
    $("nextRoundBtn").style.display = "";
    $("nextRoundBtn").textContent = last ? "See final results 🏆" : "Next round →";
    $("revealWait").style.display = "none";
  } else {
    $("nextRoundBtn").style.display = "none";
    $("revealWait").style.display = "";
  }
}

function renderEnd(s) {
  const winner = s.finalBoard[0];
  $("winnerName").textContent = winner ? winner.name : "—";
  $("winnerAvatar").innerHTML = winner ? avatar(winner, "xl") : "";
  const board = $("finalBoard");
  board.innerHTML = "";
  s.finalBoard.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "score-row" + (i === 0 ? " lead" : "");
    const medal = ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
    row.innerHTML = `<span class="rank">${medal}</span>
      <span class="who-line">${avatar(p, "sm")}<span class="name">${esc(p.name)}</span></span>
      <span class="pts">${p.score}</span>`;
    board.appendChild(row);
  });
  $("restartBtn").style.display = s.isHost ? "" : "none";
  $("endWait").style.display = s.isHost ? "none" : "";
}

function renderProgress(el, players) {
  el.innerHTML = "";
  players.forEach((p) => {
    const dot = document.createElement("span");
    const done = p.submitted || !p.connected;
    dot.className = "pdot" + (done ? " done" : "");
    dot.innerHTML = avatar(p, "sm") + (done ? `<span class="check">✓</span>` : "");
    el.appendChild(dot);
  });
}

/* ---------------- Task 4: block close / tab-switch / copy-paste ---------------- */
// Warn before the page is closed or refreshed mid-game (browser shows a
// generic "Leave site?" dialog — that's the strongest a web page is allowed).
window.addEventListener("beforeunload", (e) => {
  if (!inGame) return;
  e.preventDefault();
  e.returnValue = "";
  return "";
});

// Discourage tab/app switching during live rounds with a blocking overlay.
function showFocusGuard() { if (guardActive) $("focusGuard").hidden = false; }
function hideFocusGuard() { $("focusGuard").hidden = true; }
$("focusBackBtn").onclick = hideFocusGuard;
document.addEventListener("visibilitychange", () => { if (document.hidden) showFocusGuard(); else hideFocusGuard(); });
window.addEventListener("blur", () => { if (guardActive) showFocusGuard(); });
window.addEventListener("focus", hideFocusGuard);

// Block copying / cutting / pasting game content, and the right-click menu.
["copy", "cut", "paste", "contextmenu"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    if (e.target && e.target.id === "joinCode") return; // allow pasting a room code
    e.preventDefault();
  })
);

/* ---------------- boot ---------------- */
restoreProfile();
// Seat resume after a refresh is handled by the socket "connect" handler above,
// which fires once the connection is (re)established.
