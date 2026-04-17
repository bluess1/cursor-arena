import type * as Party from "partykit/server";

// ─────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────
type GameId = "laser" | "mansion";

type Player = {
  id: string;
  name: string;
  color: string;
  alive: boolean;       // laser: not hit / mansion: not caught
  role: "hunter" | "hider" | null;  // mansion only
  spectating: boolean;
  bestSurvival: number;
};

type Cursor = { x: number; y: number; name: string; color: string };

type Laser = {
  id: string;
  axis: "h" | "v";
  pos: number;
  moving: boolean;
  speed: number;
  dir: number;
};

// ─────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────
const GAMES: GameId[]      = ["laser", "mansion"];
const INTERMISSION_MS      = 7000;
const MIN_PLAYERS          = 1;

// Laser
const LASER_THICKNESS      = 28;   // px
const WARN_MS              = 1200;
const LASER_MS             = 700;

// Mansion
const CATCH_RADIUS         = 0.036; // normalized distance
const CELL_NORM            = 0.06;  // ~cell size in normalized coords (for maze seed)

// ─────────────────────────────────────────────────
//  SEEDED RNG  (mulberry32 — tiny, deterministic)
// ─────────────────────────────────────────────────
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────
//  MAZE GENERATION  (same as client, seeded)
// ─────────────────────────────────────────────────
function buildMaze(seed: number, cols: number, rows: number) {
  const rng = makeRng(seed);
  // wallH[r][c] = 1: wall on top of cell(r,c)
  // wallV[r][c] = 1: wall on left of cell(r,c)
  const wallH: number[][] = Array.from({ length: rows + 1 }, () => Array(cols).fill(1));
  const wallV: number[][] = Array.from({ length: rows },     () => Array(cols + 1).fill(1));
  const vis: number[][]   = Array.from({ length: rows },     () => Array(cols).fill(0));

  function carve(c: number, r: number) {
    vis[r][c] = 1;
    const dirs = [[0,-1],[1,0],[0,1],[-1,0]].sort(() => rng() - 0.5);
    for (const [dc, dr] of dirs) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows || vis[nr][nc]) continue;
      if      (dr === -1) wallH[r][c]     = 0;
      else if (dr ===  1) wallH[r + 1][c] = 0;
      else if (dc === -1) wallV[r][c]     = 0;
      else                wallV[r][c + 1] = 0;
      carve(nc, nr);
    }
  }
  carve(0, 0);
  return { wallH, wallV };
}

// ─────────────────────────────────────────────────
//  SERVER
// ─────────────────────────────────────────────────
export default class Arena implements Party.Server {
  players:     Record<string, Player> = {};
  cursors:     Record<string, Cursor> = {};
  leaderboard: { name: string; color: string; best: number }[] = [];

  phase:          "waiting" | "intermission" | "playing" = "waiting";
  currentGame:    GameId = "laser";
  nextGame:       GameId = "laser";
  roundStartTime  = 0;
  mazeSeed        = 0;
  diffTimer       = 0;
  laserCounter    = 0;
  hunterId:       string | null = null;

  laserLoop:    ReturnType<typeof setTimeout> | null = null;
  moveLoop:     ReturnType<typeof setTimeout> | null = null;
  catchLoop:    ReturnType<typeof setInterval> | null = null;

  activeLasers: Record<string, Laser> = {};

  constructor(readonly room: Party.Room) {}

  // ── Broadcast helpers ──────────────────────────
  broadcast(msg: object, exclude?: string[]) {
    this.room.broadcast(JSON.stringify(msg), exclude);
  }
  send(id: string, msg: object) {
    this.room.getConnection(id)?.send(JSON.stringify(msg));
  }

  // ── Connect ────────────────────────────────────
  onConnect(conn: Party.Connection) {
    const midGame = this.phase === "playing";
    this.players[conn.id] = {
      id: conn.id, name: "Player", color: "#888",
      alive: false, role: null, spectating: midGame, bestSurvival: 0,
    };

    conn.send(JSON.stringify({
      type:           "init",
      id:             conn.id,
      players:        this.players,
      cursors:        this.cursors,
      phase:          this.phase,
      currentGame:    this.currentGame,
      leaderboard:    this.leaderboard,
      spectating:     midGame,
      roundStartTime: this.roundStartTime,
      mazeSeed:       this.mazeSeed,
    }));

    this.broadcast(
      { type: "player_join", id: conn.id, player: this.players[conn.id] },
      [conn.id]
    );
    this.checkShouldStart();
  }

  // ── Message ────────────────────────────────────
  onMessage(message: string, sender: Party.Connection) {
    const data = JSON.parse(message);

    if (data.type === "hello") {
      const p = this.players[sender.id];
      if (p) { p.name = data.name; p.color = data.color; }
    }

    if (data.type === "cursor") {
      this.cursors[sender.id] = {
        x: data.x, y: data.y, name: data.name, color: data.color,
      };
      const p = this.players[sender.id];
      if (p) { p.name = data.name; p.color = data.color; }
      this.broadcast(
        { type: "cursor", id: sender.id, x: data.x, y: data.y, name: data.name, color: data.color },
        [sender.id]
      );
    }
  }

  // ── Disconnect ─────────────────────────────────
  onClose(conn: Party.Connection) {
    const wasHunter = this.players[conn.id]?.role === "hunter";
    delete this.players[conn.id];
    delete this.cursors[conn.id];
    this.broadcast({ type: "leave", id: conn.id });

    if (this.phase === "playing") {
      if (this.currentGame === "mansion" && wasHunter) {
        this.endRound(null, null);
      } else {
        this.checkRoundEnd();
      }
    }
    if (this.phase === "waiting") this.checkShouldStart();
  }

  // ─────────────────────────────────────────────────
  //  FLOW
  // ─────────────────────────────────────────────────
  checkShouldStart() {
    const count = Object.keys(this.players).length;
    if (count >= MIN_PLAYERS && this.phase === "waiting") this.startIntermission();
    if (count === 0) { this.phase = "waiting"; this.stopAllLoops(); }
  }

  startIntermission() {
    this.phase = "intermission";
    this.stopAllLoops();
    this.clearLasers();

    // Pick next game randomly
    this.nextGame = GAMES[Math.floor(Math.random() * GAMES.length)];

    this.broadcast({
      type:      "intermission",
      duration:  INTERMISSION_MS,
      nextGame:  this.nextGame,
    });

    setTimeout(() => {
      if (Object.keys(this.players).length >= MIN_PLAYERS) {
        this.startRound();
      } else {
        this.phase = "waiting";
      }
    }, INTERMISSION_MS);
  }

  startRound() {
    this.currentGame    = this.nextGame;
    this.phase          = "playing";
    this.roundStartTime = Date.now();
    this.diffTimer      = 0;
    this.mazeSeed       = Math.floor(Math.random() * 0xFFFFFF);

    for (const id in this.players) {
      const p = this.players[id];
      p.alive      = true;
      p.caught     = false as any;
      p.spectating = false;
      p.role       = null;
    }

    // Mansion: assign hunter randomly
    if (this.currentGame === "mansion") {
      const ids = Object.keys(this.players);
      this.hunterId = ids[Math.floor(Math.random() * ids.length)];
      this.players[this.hunterId].role  = "hunter";
      this.players[this.hunterId].alive = true;
      for (const id in this.players) {
        if (id !== this.hunterId) this.players[id].role = "hider";
      }
    }

    this.broadcast({
      type:      "round_start",
      game:      this.currentGame,
      players:   this.players,
      time:      this.roundStartTime,
      mazeSeed:  this.mazeSeed,
    });

    // Notify mansion players of their role privately
    if (this.currentGame === "mansion") {
      for (const id in this.players) {
        this.send(id, { type: "role_assigned", role: this.players[id].role });
      }
      this.startCatchLoop();
    }

    // Laser: start laser spawning
    if (this.currentGame === "laser") {
      setTimeout(() => this.laserTick(), 1500);
      this.startMoveLoop();
    }
  }

  // ─────────────────────────────────────────────────
  //  ROUND END
  // ─────────────────────────────────────────────────
  checkRoundEnd() {
    if (this.phase !== "playing") return;

    if (this.currentGame === "laser") {
      const alive = Object.values(this.players).filter(p => p.alive && !p.spectating);
      const total = Object.values(this.players).filter(p => !p.spectating);
      if (alive.length <= 1 && total.length >= 1) {
        this.endRound(alive[0] ?? null, "survivor");
      }
    }

    if (this.currentGame === "mansion") {
      const activeHiders = Object.values(this.players).filter(
        p => p.role === "hider" && p.alive && !p.spectating
      );
      if (activeHiders.length === 0) {
        const hunter = this.hunterId ? this.players[this.hunterId] : null;
        this.endRound(hunter, "hunter");
      }
    }
  }

  endRound(winner: Player | null, winnerRole: string | null) {
    if (this.phase !== "playing") return;
    this.phase = "waiting";
    this.stopAllLoops();
    this.clearLasers();

    if (winner) {
      const survived = Date.now() - this.roundStartTime;
      if (survived > winner.bestSurvival) winner.bestSurvival = survived;
      this.updateLeaderboard(winner);
    }

    this.broadcast({
      type:        "round_end",
      game:        this.currentGame,
      winner:      winner?.id ?? null,
      winnerName:  winner?.name ?? "Nobody",
      winnerRole,
      leaderboard: this.leaderboard,
    });

    setTimeout(() => this.startIntermission(), 4000);
  }

  // ─────────────────────────────────────────────────
  //  LASER GAME
  // ─────────────────────────────────────────────────
  getDifficulty() {
    const level = Math.floor(this.diffTimer / 10000);
    return {
      interval: Math.max(900, 3000 - level * 250),
      moving:   level >= 2,
      speed:    1 + level * 0.5,
      count:    1 + Math.floor(level / 3),
    };
  }

  laserTick() {
    if (this.phase !== "playing" || this.currentGame !== "laser") return;
    const diff = this.getDifficulty();
    this.diffTimer += diff.interval;
    for (let i = 0; i < diff.count; i++) {
      setTimeout(() => this.spawnLaser(diff), i * 500);
    }
    this.laserLoop = setTimeout(() => this.laserTick(), diff.interval);
  }

  spawnLaser(diff: ReturnType<typeof this.getDifficulty>) {
    if (this.phase !== "playing" || this.currentGame !== "laser") return;
    const id    = `l${++this.laserCounter}`;
    const isH   = Math.random() < 0.5;
    const laser: Laser = {
      id,
      axis:   isH ? "h" : "v",
      pos:    Math.random() * 0.97,
      moving: diff.moving && Math.random() < 0.6,
      speed:  diff.speed * 0.0003,
      dir:    Math.random() < 0.5 ? 1 : -1,
    };

    this.broadcast({ type: "laser_warn", laser });

    setTimeout(() => {
      if (this.phase !== "playing" || this.currentGame !== "laser") return;
      this.activeLasers[id] = laser;
      this.broadcast({ type: "laser_fire", laser });
      this.checkLaserCollisions();

      setTimeout(() => {
        delete this.activeLasers[id];
        this.broadcast({ type: "laser_remove", id });
      }, LASER_MS);
    }, WARN_MS);
  }

  checkLaserCollisions() {
    for (const pid in this.players) {
      const p = this.players[pid];
      if (!p.alive || p.spectating) continue;
      const cur = this.cursors[pid];
      if (!cur) continue;
      for (const lid in this.activeLasers) {
        const l = this.activeLasers[lid];
        const hit = l.axis === "h"
          ? cur.y >= l.pos && cur.y <= l.pos + LASER_THICKNESS / 1000
          : cur.x >= l.pos && cur.x <= l.pos + LASER_THICKNESS / 1000;
        if (hit) {
          p.alive = false;
          const survived = Date.now() - this.roundStartTime;
          if (survived > p.bestSurvival) p.bestSurvival = survived;
          this.updateLeaderboard(p);
          this.broadcast({ type: "player_dead", id: pid, survived, leaderboard: this.leaderboard });
          this.checkRoundEnd();
          break;
        }
      }
    }
  }

  startMoveLoop() {
    let last = Date.now();
    const tick = () => {
      if (this.phase !== "playing" || this.currentGame !== "laser") return;
      const now = Date.now(), dt = now - last; last = now;
      for (const id in this.activeLasers) {
        const l = this.activeLasers[id];
        if (!l.moving) continue;
        l.pos += l.speed * l.dir * dt;
        if (l.pos < 0) { l.pos = 0; l.dir = 1; }
        if (l.pos > 1) { l.pos = 1; l.dir = -1; }
      }
      const moving = Object.values(this.activeLasers).filter(l => l.moving);
      if (moving.length > 0) {
        this.broadcast({ type: "lasers_move", lasers: moving.map(l => ({ id: l.id, pos: l.pos })) });
      }
      this.checkLaserCollisions();
      this.moveLoop = setTimeout(tick, 50);
    };
    this.moveLoop = setTimeout(tick, 50);
  }

  // ─────────────────────────────────────────────────
  //  MANSION GAME
  // ─────────────────────────────────────────────────
  startCatchLoop() {
    this.catchLoop = setInterval(() => {
      if (this.phase !== "playing" || this.currentGame !== "mansion") return;
      this.checkCatches();
    }, 50);
  }

  checkCatches() {
    if (!this.hunterId) return;
    const hc = this.cursors[this.hunterId];
    if (!hc) return;

    for (const [id, p] of Object.entries(this.players)) {
      if (id === this.hunterId || !p.alive || p.spectating) continue;
      const cur = this.cursors[id];
      if (!cur) continue;
      const dist = Math.hypot(hc.x - cur.x, hc.y - cur.y);
      if (dist < CATCH_RADIUS) {
        p.alive = false;
        const survived = Date.now() - this.roundStartTime;
        if (survived > p.bestSurvival) p.bestSurvival = survived;
        this.updateLeaderboard(p);
        this.broadcast({ type: "player_caught", id, survived, leaderboard: this.leaderboard });
        this.checkRoundEnd();
      }
    }
  }

  // ─────────────────────────────────────────────────
  //  UTIL
  // ─────────────────────────────────────────────────
  clearLasers() {
    this.activeLasers = {};
    this.broadcast({ type: "clear_lasers" });
  }

  stopAllLoops() {
    if (this.laserLoop) { clearTimeout(this.laserLoop);    this.laserLoop = null; }
    if (this.moveLoop)  { clearTimeout(this.moveLoop);     this.moveLoop  = null; }
    if (this.catchLoop) { clearInterval(this.catchLoop);   this.catchLoop = null; }
  }

  updateLeaderboard(p: Player) {
    const existing = this.leaderboard.find(e => e.name === p.name);
    if (existing) {
      if (p.bestSurvival > existing.best) {
        existing.best  = p.bestSurvival;
        existing.color = p.color;
      }
    } else {
      this.leaderboard.push({ name: p.name, color: p.color, best: p.bestSurvival });
    }
    this.leaderboard.sort((a, b) => b.best - a.best);
    this.leaderboard = this.leaderboard.slice(0, 10);
  }
}
