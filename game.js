// Psych! — pass-and-play hotseat clone.
// Flow per round: show prompt -> each player secretly writes a bluff ->
// everyone secretly guesses the real answer among (bluffs + truth) ->
// score -> next round. Most points after N rounds wins.

const POINTS_CORRECT = 1000; // guessing the real answer
const POINTS_FOOL = 500;     // each player fooled by your bluff

const state = {
  players: [],       // [{ name, score }]
  deckKey: null,
  totalRounds: 5,
  round: 0,          // 1-based
  order: [],         // shuffled question indices for this game
  // per-round working data:
  current: null,     // { prompt, answer }
  bluffs: [],        // [{ text, byIndex }]  (byIndex = -1 for the real answer)
  options: [],       // shuffled [{ text, byIndex }]
  guesses: [],       // guesses[playerIndex] = chosen option index
  turnIndex: 0,      // whose turn during collect/guess phase
  roundGain: [],     // points gained this round per player
};

const $ = (id) => document.getElementById(id);
const screens = {};
function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------------- Setup ---------------- */
function renderPlayers() {
  const list = $("playerList");
  list.innerHTML = "";
  state.players.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "player-chip";
    const name = document.createElement("span");
    name.textContent = `${i + 1}.  ${p.name}`;
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.setAttribute("aria-label", `Remove ${p.name}`);
    rm.onclick = () => { state.players.splice(i, 1); renderPlayers(); };
    chip.append(name, rm);
    list.appendChild(chip);
  });
  $("startBtn").disabled = !(state.players.length >= 2 && state.deckKey);
  $("playerCount").textContent = state.players.length;
}

function addPlayer() {
  const input = $("playerName");
  const val = input.value.trim();
  if (!val) return;
  if (state.players.length >= 8) return;
  state.players.push({ name: val, score: 0 });
  input.value = "";
  input.focus();
  renderPlayers();
}

function renderDecks() {
  const grid = $("deckGrid");
  grid.innerHTML = "";
  Object.entries(DECKS).forEach(([key, deck]) => {
    const el = document.createElement("button");
    el.className = "deck" + (state.deckKey === key ? " selected" : "");
    el.innerHTML = `<div class="emoji">${deck.emoji}</div>
      <h3>${deck.name}</h3><p>${deck.blurb}</p>`;
    el.onclick = () => { state.deckKey = key; renderDecks(); renderPlayers(); };
    grid.appendChild(el);
  });
}

function startGame() {
  const deck = DECKS[state.deckKey];
  state.totalRounds = Math.min(Number($("roundCount").value) || 5, deck.questions.length);
  state.order = shuffle(deck.questions.map((_, i) => i)).slice(0, state.totalRounds);
  state.players.forEach((p) => (p.score = 0));
  state.round = 0;
  nextRound();
}

/* ---------------- Round: collect bluffs ---------------- */
function nextRound() {
  state.round++;
  if (state.round > state.totalRounds) return endGame();
  const deck = DECKS[state.deckKey];
  state.current = deck.questions[state.order[state.round - 1]];
  state.bluffs = [{ text: state.current.answer, byIndex: -1 }]; // real answer seeded
  state.guesses = new Array(state.players.length).fill(null);
  state.roundGain = new Array(state.players.length).fill(0);
  state.turnIndex = 0;
  passScreen("bluff");
}

// Privacy hand-off screen so the next player doesn't see the previous entry.
function passScreen(phase) {
  const p = state.players[state.turnIndex];
  $("passName").textContent = p.name;
  $("passPhase").textContent =
    phase === "bluff" ? "it's your turn to bluff" : "it's your turn to guess";
  $("passBtn").onclick = () => (phase === "bluff" ? showBluff() : showGuess());
  show("pass");
}

function showBluff() {
  $("bluffRound").textContent = `Round ${state.round} / ${state.totalRounds}`;
  $("bluffDeck").textContent = DECKS[state.deckKey].name;
  $("bluffPrompt").textContent = state.current.prompt;
  $("bluffWho").textContent = state.players[state.turnIndex].name;
  $("bluffInput").value = "";
  show("bluff");
  $("bluffInput").focus();
}

function submitBluff() {
  const input = $("bluffInput");
  const text = input.value.trim();
  if (!text) return;
  // Prevent accidentally typing the exact real answer — merge into truth.
  const dupTruth = text.toLowerCase() === state.current.answer.toLowerCase();
  if (!dupTruth) {
    state.bluffs.push({ text, byIndex: state.turnIndex });
  } else {
    state.bluffs.push({ text, byIndex: state.turnIndex, isTruthDup: true });
  }
  state.turnIndex++;
  if (state.turnIndex < state.players.length) {
    passScreen("bluff");
  } else {
    // Build shuffled options and start guessing phase.
    state.options = shuffle(state.bluffs);
    state.turnIndex = 0;
    passScreen("guess");
  }
}

/* ---------------- Round: guessing ---------------- */
function showGuess() {
  $("guessRound").textContent = `Round ${state.round} / ${state.totalRounds}`;
  $("guessPrompt").textContent = state.current.prompt;
  $("guessWho").textContent = state.players[state.turnIndex].name;
  const box = $("guessOptions");
  box.innerHTML = "";
  state.options.forEach((opt, oi) => {
    const btn = document.createElement("button");
    btn.className = "option";
    const own = opt.byIndex === state.turnIndex;
    btn.innerHTML = opt.text + (own ? `<span class="tag">your bluff — can't pick this</span>` : "");
    if (own) {
      btn.classList.add("disabled");
      btn.disabled = true;
    } else {
      btn.onclick = () => submitGuess(oi);
    }
    box.appendChild(btn);
  });
  show("guess");
}

function submitGuess(optionIndex) {
  state.guesses[state.turnIndex] = optionIndex;
  state.turnIndex++;
  if (state.turnIndex < state.players.length) {
    passScreen("guess");
  } else {
    scoreRound();
  }
}

function scoreRound() {
  // Award points.
  state.guesses.forEach((optIdx, playerIdx) => {
    if (optIdx == null) return;
    const chosen = state.options[optIdx];
    if (chosen.byIndex === -1 || chosen.isTruthDup) {
      // Guessed the real answer.
      state.players[playerIdx].score += POINTS_CORRECT;
      state.roundGain[playerIdx] += POINTS_CORRECT;
    } else {
      // Fooled by another player's bluff → that author scores.
      const author = chosen.byIndex;
      state.players[author].score += POINTS_FOOL;
      state.roundGain[author] += POINTS_FOOL;
    }
  });
  showReveal();
}

/* ---------------- Reveal ---------------- */
function showReveal() {
  $("revealPrompt").textContent = state.current.prompt;
  const box = $("revealOptions");
  box.innerHTML = "";
  state.options.forEach((opt) => {
    const el = document.createElement("div");
    el.className = "option " + (opt.byIndex === -1 || opt.isTruthDup ? "correct" : "wrong");
    const voters = state.guesses
      .map((g, pi) => (g != null && state.options[g] === opt ? state.players[pi].name : null))
      .filter(Boolean);
    let tag;
    if (opt.byIndex === -1 || opt.isTruthDup) {
      tag = "✅ THE REAL ANSWER";
    } else {
      tag = `🃏 bluff by ${state.players[opt.byIndex].name}`;
    }
    const votedBy = voters.length ? ` · picked by ${voters.join(", ")}` : " · nobody picked this";
    el.innerHTML = `${opt.text}<span class="tag">${tag}${votedBy}</span>`;
    box.appendChild(el);
  });

  // Per-player gains this round.
  const gains = $("revealGains");
  gains.innerHTML = "";
  state.players
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.score - a.p.score)
    .forEach(({ p, i }) => {
      const row = document.createElement("div");
      row.className = "score-row";
      row.innerHTML = `<span class="name">${p.name}</span>
        <span class="pts">${p.score}
        ${state.roundGain[i] ? `<span class="gained"> +${state.roundGain[i]}</span>` : ""}</span>`;
      gains.appendChild(row);
    });

  $("nextRoundBtn").textContent =
    state.round >= state.totalRounds ? "See final results 🏆" : "Next round →";
  $("nextRoundBtn").onclick = nextRound;
  show("reveal");
}

/* ---------------- End ---------------- */
function endGame() {
  const ranked = state.players
    .map((p) => ({ ...p }))
    .sort((a, b) => b.score - a.score);
  $("winnerName").textContent = ranked[0].name;
  const board = $("finalBoard");
  board.innerHTML = "";
  ranked.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "score-row" + (i === 0 ? " lead" : "");
    const medal = ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
    row.innerHTML = `<span class="rank">${medal}</span>
      <span class="name">${p.name}</span><span class="pts">${p.score}</span>`;
    board.appendChild(row);
  });
  show("end");
}

function playAgain(sameSettings) {
  if (sameSettings) {
    startGame();
  } else {
    show("setup");
  }
}

/* ---------------- Wire up ---------------- */
window.addEventListener("DOMContentLoaded", () => {
  ["setup", "pass", "bluff", "guess", "reveal", "end"].forEach(
    (n) => (screens[n] = $("screen-" + n))
  );
  renderDecks();
  renderPlayers();

  $("addPlayerBtn").onclick = addPlayer;
  $("playerName").addEventListener("keydown", (e) => { if (e.key === "Enter") addPlayer(); });
  $("startBtn").onclick = startGame;
  $("submitBluffBtn").onclick = submitBluff;
  $("bluffInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitBluff(); });
  $("playAgainSame").onclick = () => playAgain(true);
  $("playAgainNew").onclick = () => playAgain(false);
});
