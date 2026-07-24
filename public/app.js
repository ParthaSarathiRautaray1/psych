// Psych! online client — talks to the server over Socket.IO.
const socket = io();
const $ = (id) => document.getElementById(id);

let selectedDeck = null;
let lastPhase = null;

const screens = {};
["home", "lobby", "bluff", "guess", "reveal", "end"].forEach((n) => (screens[n] = $("screen-" + n)));
function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

/* ---------------- connection status ---------------- */
socket.on("connect", () => { $("conn").textContent = "🟢 Connected"; $("conn").style.display = "none"; });
socket.on("disconnect", () => { $("conn").textContent = "🔴 Disconnected — reconnecting…"; $("conn").style.display = "inline-block"; });
socket.on("connect_error", () => { $("conn").textContent = "🔴 Can't reach server"; $("conn").style.display = "inline-block"; });

/* ---------------- home: create / join ---------------- */
$("createBtn").onclick = () => {
  const name = $("hostName").value.trim() || "Host";
  socket.emit("create", { name }, (res) => { if (res && res.ok) show("lobby"); });
};
$("joinBtn").onclick = () => {
  const name = $("joinName").value.trim() || "Player";
  const code = $("joinCode").value.trim().toUpperCase();
  if (!code) { $("joinError").textContent = "Enter a room code."; return; }
  socket.emit("join", { code, name }, (res) => {
    if (res && res.ok) { $("joinError").textContent = ""; show("lobby"); }
    else $("joinError").textContent = (res && res.error) || "Could not join.";
  });
};
$("joinName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinCode").focus(); });
$("joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });

// Prefill code from URL (?room=XXXX) for shared links.
const urlRoom = new URLSearchParams(location.search).get("room");
if (urlRoom) $("joinCode").value = urlRoom.toUpperCase();

/* ---------------- lobby actions ---------------- */
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
$("copyLink").onclick = () => {
  const link = `${location.origin}/?room=${currentCode}`;
  navigator.clipboard?.writeText(link).then(
    () => { $("copyLink").textContent = "✅ Copied!"; setTimeout(() => ($("copyLink").textContent = "📋 Copy join link"), 1500); },
    () => {}
  );
};

/* ---------------- render decks (lobby, host) ---------------- */
let currentCode = "";
function renderDecks(decks) {
  const grid = $("deckGrid");
  if (grid.dataset.built === "1") { updateDeckSelection(); return; }
  grid.innerHTML = "";
  decks.forEach((d) => {
    const el = document.createElement("button");
    el.className = "deck";
    el.dataset.key = d.key;
    el.innerHTML = `<div class="emoji">${d.emoji}</div><h3>${d.name}</h3><p>${d.blurb}</p>`;
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
let lobbyPlayerCount = 0;
function refreshStartBtn() {
  $("startBtn").disabled = !(selectedDeck && lobbyPlayerCount >= 2);
}

/* ---------------- main state renderer ---------------- */
socket.on("state", (s) => {
  currentCode = s.code;
  const phaseScreen = { lobby: "lobby", bluff: "bluff", guess: "guess", reveal: "reveal", end: "end" }[s.phase];
  if (phaseScreen) show(phaseScreen);

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
    chip.innerHTML = `<span>${p.name}${p.isHost ? " 👑" : ""}</span>
      <span class="status">${p.connected ? "ready" : "away"}</span>`;
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
  if (waiting) renderProgress($("bluffProgress"), s.players.map((p) => p.submitted || !p.connected));
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
      btn.innerHTML = opt.text + (opt.mine ? `<span class="tag">your bluff — can't pick this</span>` : "");
      if (opt.mine) btn.disabled = true;
      else btn.onclick = () => socket.emit("guess", { optionIndex: opt.i });
      box.appendChild(btn);
    });
  } else {
    renderProgress($("guessProgress"), s.players.map((p) => p.submitted || !p.connected));
  }
}

function renderReveal(s) {
  $("revealPrompt").textContent = s.prompt;
  const box = $("revealOptions");
  box.innerHTML = "";
  s.reveal.forEach((opt) => {
    const el = document.createElement("div");
    el.className = "option " + (opt.isReal ? "correct" : "wrong");
    const tag = opt.isReal ? "✅ THE REAL ANSWER" : `🃏 bluff by ${opt.author}`;
    const votedBy = opt.voters.length ? ` · picked by ${opt.voters.join(", ")}` : " · nobody picked this";
    el.innerHTML = `${opt.text}<span class="tag">${tag}${votedBy}</span>`;
    box.appendChild(el);
  });

  const gains = $("revealGains");
  gains.innerHTML = "";
  s.gains.forEach((g) => {
    const row = document.createElement("div");
    row.className = "score-row";
    row.innerHTML = `<span class="name">${g.name}</span>
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
  $("winnerName").textContent = s.finalBoard[0] ? s.finalBoard[0].name : "—";
  const board = $("finalBoard");
  board.innerHTML = "";
  s.finalBoard.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "score-row" + (i === 0 ? " lead" : "");
    const medal = ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
    row.innerHTML = `<span class="rank">${medal}</span><span class="name">${p.name}</span><span class="pts">${p.score}</span>`;
    board.appendChild(row);
  });
  $("restartBtn").style.display = s.isHost ? "" : "none";
  $("endWait").style.display = s.isHost ? "none" : "";
}

function renderProgress(el, doneFlags) {
  el.innerHTML = "";
  doneFlags.forEach((done) => {
    const dot = document.createElement("div");
    dot.className = "dot" + (done ? " done" : "");
    el.appendChild(dot);
  });
}
