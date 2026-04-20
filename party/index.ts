<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Cursor Games</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
      width:100vw;min-height:100vh;
      background:#0a0a0f;font-family:'Courier New',monospace;
      color:white;display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      user-select:none;overflow:hidden;
    }

    /* ── Join ── */
    #join{
      position:fixed;inset:0;background:#0a0a0f;z-index:99;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    }
    #join h1{font-size:26px;letter-spacing:3px;color:#999;}
    #join p{font-size:12px;color:#444;letter-spacing:1px;}
    #join input{
      background:#111118;border:1px solid #222230;color:white;
      padding:9px 16px;border-radius:6px;font-size:15px;
      outline:none;width:210px;text-align:center;font-family:inherit;
    }
    #join input:focus{border-color:#333348;}
    #join button{
      background:#18182a;color:#777;border:1px solid #252538;
      padding:9px 28px;border-radius:6px;font-size:13px;
      cursor:pointer;font-family:inherit;letter-spacing:1.5px;
    }
    #join button:hover{background:#202035;color:#aaa;}

    /* ── Main ── */
    #main{
      display:none;flex-direction:column;align-items:center;
      gap:24px;width:100%;max-width:480px;padding:24px;
    }
    #main.show{display:flex;}

    .section-label{font-size:10px;color:#333;letter-spacing:2.5px;text-transform:uppercase;text-align:center;}

    /* Timer */
    #timer-wrap{width:100%;}
    #timer-bar-bg{width:100%;height:3px;background:#151520;border-radius:2px;}
    #timer-bar{height:3px;background:#404060;border-radius:2px;width:100%;transition:width 0.2s linear;}
    #timer-txt{font-size:11px;color:#444;text-align:center;margin-top:6px;letter-spacing:1px;}

    /* Vote cards */
    #vote-cards{display:flex;gap:12px;width:100%;}
    .vote-card{
      flex:1;padding:18px 14px 14px;border-radius:10px;
      background:#0e0e1a;border:2px solid #1a1a2a;
      cursor:pointer;text-align:center;position:relative;
      transition:border-color 0.15s,background 0.15s,transform 0.1s;
    }
    .vote-card:hover{background:#131320;transform:translateY(-2px);}
    .vote-card.selected{border-color:var(--c);}
    .vote-card.selected .card-name{color:var(--c);}
    .vote-card.winning .vote-pct{color:var(--c);}
    .vote-card .card-icon{font-size:26px;margin-bottom:8px;}
    .vote-card .card-name{font-size:13px;letter-spacing:1.5px;color:#777;font-weight:700;margin-bottom:6px;}
    .vote-card .card-desc{font-size:11px;color:#3a3a50;line-height:1.5;margin-bottom:10px;}
    .vote-card .vote-bar-wrap{height:2px;background:#151520;border-radius:2px;margin-top:8px;}
    .vote-card .vote-bar-fill{height:2px;border-radius:2px;background:var(--c);width:0%;transition:width 0.3s;}
    .vote-card .vote-pct{font-size:10px;color:#444;margin-top:4px;letter-spacing:0.5px;}

    /* Result */
    #result{display:none;flex-direction:column;align-items:center;gap:8px;text-align:center;}
    #result.show{display:flex;}
    #result .res-label{font-size:10px;color:#444;letter-spacing:2.5px;text-transform:uppercase;}
    #result .res-name{font-size:30px;font-weight:700;letter-spacing:2px;margin-top:4px;}
    #result .res-countdown{font-size:11px;color:#333;margin-top:10px;letter-spacing:1.5px;}

    /* Status */
    #status{font-size:11px;color:#333;letter-spacing:1px;text-align:center;min-height:16px;}

    /* Players */
    #player-list{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;}
    .player-chip{
      display:flex;align-items:center;gap:5px;
      padding:3px 9px;border-radius:10px;
      background:#0e0e1a;border:1px solid #1a1a28;font-size:11px;color:#555;
    }
    .player-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}

    /* Connecting indicator */
    #conn-state{
      position:fixed;bottom:12px;left:50%;transform:translateX(-50%);
      font-size:10px;color:#2a2a3a;letter-spacing:1px;
    }
  </style>
</head>
<body>

<div id="join">
  <h1>CURSOR GAMES</h1>
  <p>minigames · multiplayer · mayhem</p>
  <input id="name-input" maxlength="16" placeholder="your name"/>
  <button id="join-btn" onclick="joinLobby()">Enter →</button>
</div>

<div id="main">
  <div class="section-label" id="phase-label">vote for next game</div>

  <div id="status"></div>

  <div id="timer-wrap">
    <div id="timer-bar-bg"><div id="timer-bar"></div></div>
    <div id="timer-txt">—</div>
  </div>

  <div id="vote-cards">
    <div class="vote-card" id="card-laser" style="--c:#e74c3c" onclick="castVote('laser')">
      <div class="card-icon">⚡</div>
      <div class="card-name">LASER DODGE</div>
      <div class="card-desc">Dodge the lasers.<br>Last cursor standing wins.</div>
      <div class="vote-bar-wrap"><div class="vote-bar-fill" id="bar-laser"></div></div>
      <div class="vote-pct" id="pct-laser">0 votes</div>
    </div>
    <div class="vote-card" id="card-mansion" style="--c:#c8a040" onclick="castVote('mansion')">
      <div class="card-icon">👻</div>
      <div class="card-name">MANSION MAZE</div>
      <div class="card-desc">One hunter. Everyone<br>else hides in the dark.</div>
      <div class="vote-bar-wrap"><div class="vote-bar-fill" id="bar-mansion"></div></div>
      <div class="vote-pct" id="pct-mansion">0 votes</div>
    </div>
  </div>

  <div id="result">
    <div class="res-label">game selected</div>
    <div class="res-name" id="res-name"></div>
    <div class="res-countdown" id="res-countdown"></div>
  </div>

  <div>
    <div class="section-label" style="margin-bottom:10px;">players</div>
    <div id="player-list"></div>
  </div>
</div>

<div id="conn-state">connecting…</div>

<script>
const PARTYKIT_HOST = "mousegame-party.bluess1.partykit.dev";
const COLORS = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#e91e63","#00bcd4","#ff5722"];
const GAME_META = {
  laser:   { name:"⚡ LASER DODGE",  url:"laser.html",   color:"#e74c3c" },
  mansion: { name:"👻 MANSION MAZE", url:"mansion.html", color:"#c8a040" },
};

let socket, myId, myName="", myColor="";
let myVote = null;
let voteEnd = 0;         // absolute ms timestamp
let timerRAF = null;
let countdownInterval = null;
const players = {};

// ── Restore session ────────────────────────────────────
const stored = JSON.parse(sessionStorage.getItem('cgPlayer') || '{}');
if (stored.name) document.getElementById('name-input').value = stored.name;
if (stored.autoJoin && stored.name) {
  // returning from a game — skip join screen
  sessionStorage.setItem('cgPlayer', JSON.stringify({...stored, autoJoin:false}));
  window.addEventListener('load', () => {
    myName  = stored.name;
    myColor = stored.color || COLORS[0];
    document.getElementById('join').style.display = 'none';
    document.getElementById('main').classList.add('show');
    connect();
  });
}

// ── Join ───────────────────────────────────────────────
function joinLobby() {
  const nameEl = document.getElementById('name-input');
  myName  = nameEl.value.trim() || 'Player';
  myColor = stored.color || COLORS[Math.floor(Math.random() * COLORS.length)];
  sessionStorage.setItem('cgPlayer', JSON.stringify({name:myName, color:myColor}));
  document.getElementById('join').style.display = 'none';
  document.getElementById('main').classList.add('show');
  connect();
}
document.getElementById('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinLobby();
});

// ── WebSocket ──────────────────────────────────────────
function connect() {
  const proto = PARTYKIT_HOST.startsWith('localhost') ? 'ws' : 'wss';
  socket = new WebSocket(`${proto}://${PARTYKIT_HOST}/parties/main/arena`);

  socket.onopen = () => {
    document.getElementById('conn-state').textContent = '';
    // Send hello immediately on open
    socket.send(JSON.stringify({ type: 'hello', name: myName, color: myColor }));
  };

  socket.onmessage = e => handle(JSON.parse(e.data));

  socket.onclose = () => {
    document.getElementById('conn-state').textContent = 'reconnecting…';
    setTimeout(connect, 2000);
  };

  socket.onerror = () => {
    document.getElementById('conn-state').textContent = 'connection error';
  };
}

// ── Vote ───────────────────────────────────────────────
function castVote(game) {
  if (myVote) return; // already voted
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  myVote = game;
  document.getElementById(`card-${game}`).classList.add('selected');
  socket.send(JSON.stringify({ type: 'vote', game }));
}

// ── Message handler ────────────────────────────────────
function handle(msg) {

  if (msg.type === 'init') {
    myId = msg.id;
    for (const [id, p] of Object.entries(msg.players)) players[id] = p;
    renderPlayers();

    if (msg.phase === 'playing') {
      // Game running — go there now
      redirectTo(msg.currentGame);
      return;
    }

    if (msg.phase === 'voting') {
      // Mid-vote join — use server's voteEnd timestamp
      voteEnd = msg.voteEnd || (Date.now() + 10000);
      startTimerBar();
      setStatus('');
    }

    if (msg.phase === 'waiting') {
      setStatus('waiting for players…');
      setTimerBar(0, '—');
    }
  }

  if (msg.type === 'player_join') {
    players[msg.id] = msg.player;
    renderPlayers();
  }

  if (msg.type === 'leave') {
    delete players[msg.id];
    renderPlayers();
  }

  if (msg.type === 'voting_start') {
    // New vote round
    myVote = null;
    voteEnd = msg.voteEnd;
    document.getElementById('card-laser').classList.remove('selected', 'winning');
    document.getElementById('card-mansion').classList.remove('selected', 'winning');
    document.getElementById('result').classList.remove('show');
    document.getElementById('vote-cards').style.display = 'flex';
    document.getElementById('phase-label').textContent = 'vote for next game';
    setStatus('');
    updateVoteBars({ laser: 0, mansion: 0 }, 0);
    startTimerBar();
  }

  if (msg.type === 'vote_update') {
    updateVoteBars(msg.counts, msg.total);
  }

  if (msg.type === 'round_end') {
    const meta = GAME_META[msg.game] || {};
    let txt = '';
    if (msg.winnerRole === 'hunter')   txt = `${msg.winnerName} caught everyone`;
    else if (msg.winnerRole === 'survivor') txt = `${msg.winnerName} survived`;
    else txt = `${msg.winnerName} wins`;
    setStatus(txt);
  }

  if (msg.type === 'vote_result') {
    showResult(msg.winner, msg.counts);
  }

  if (msg.type === 'round_start') {
    redirectTo(msg.game);
  }
}

// ── Timer bar (driven by voteEnd absolute timestamp) ───
function startTimerBar() {
  cancelAnimationFrame(timerRAF);
  function tick() {
    const rem = Math.max(0, voteEnd - Date.now());
    const total = 10000;
    const pct = (rem / total) * 100;
    setTimerBar(pct, Math.ceil(rem / 1000) + 's');
    if (rem > 0) timerRAF = requestAnimationFrame(tick);
    else setTimerBar(0, '0s');
  }
  timerRAF = requestAnimationFrame(tick);
}

function setTimerBar(pct, label) {
  document.getElementById('timer-bar').style.width = pct + '%';
  document.getElementById('timer-txt').textContent = label;
}

// ── Vote bars ──────────────────────────────────────────
function updateVoteBars(counts, total) {
  const laser   = counts.laser   || 0;
  const mansion = counts.mansion || 0;
  const sum = laser + mansion || 1;

  document.getElementById('bar-laser').style.width   = ((laser / sum) * 100) + '%';
  document.getElementById('bar-mansion').style.width = ((mansion / sum) * 100) + '%';
  document.getElementById('pct-laser').textContent   = laser   + (laser   === 1 ? ' vote' : ' votes');
  document.getElementById('pct-mansion').textContent = mansion + (mansion === 1 ? ' vote' : ' votes');

  document.getElementById('card-laser').classList.toggle('winning',   laser > mansion);
  document.getElementById('card-mansion').classList.toggle('winning', mansion > laser);
}

// ── Result ────────────────────────────────────────────
function showResult(winner, counts) {
  cancelAnimationFrame(timerRAF);
  setTimerBar(0, '');

  const meta = GAME_META[winner];
  document.getElementById('vote-cards').style.display = 'none';
  document.getElementById('phase-label').textContent = 'game selected';

  const resName = document.getElementById('res-name');
  resName.textContent = meta.name;
  resName.style.color = meta.color;
  document.getElementById('result').classList.add('show');

  let t = 3;
  const cd = document.getElementById('res-countdown');
  cd.textContent = `launching in ${t}s`;
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    t--;
    cd.textContent = t > 0 ? `launching in ${t}s` : 'launching…';
    if (t <= 0) clearInterval(countdownInterval);
  }, 1000);
}

// ── Redirect ──────────────────────────────────────────
function redirectTo(game) {
  const meta = GAME_META[game];
  if (!meta) return;
  sessionStorage.setItem('cgPlayer', JSON.stringify({ name:myName, color:myColor, autoJoin:true }));
  window.location.href = meta.url;
}

// ── Helpers ───────────────────────────────────────────
function setStatus(txt) {
  document.getElementById('status').textContent = txt;
}

function renderPlayers() {
  document.getElementById('player-list').innerHTML =
    Object.values(players).map(p => `
      <div class="player-chip">
        <div class="player-dot" style="background:${p.color||'#888'}"></div>
        <span>${p.name||'?'}</span>
      </div>`).join('');
}
</script>
</body>
</html>
