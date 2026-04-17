import type * as Party from "partykit/server";

type Cursor = { x: number; y: number; name: string; color: string; };
type Player = { id: string; name: string; color: string; alive: boolean; spectating: boolean; joinedMidGame: boolean; bestSurvival: number; };
type Laser  = { id: string; axis: "h"|"v"; pos: number; moving: boolean; speed: number; dir: number; };

const LASER_THICKNESS = 28;
const WARN_MS         = 1200;
const LASER_MS        = 700;
const INTERMISSION_MS = 6000;
const MIN_PLAYERS     = 1;

export default class Arena implements Party.Server {
  players:  Record<string, Player> = {};
  cursors:  Record<string, Cursor> = {};
  lasers:   Record<string, Laser>  = {};
  leaderboard: { name: string; color: string; best: number }[] = [];

  phase: "waiting"|"intermission"|"playing" = "waiting";
  roundStartTime = 0;
  difficultyTimer = 0;
  laserCounter = 0;
  laserLoop: ReturnType<typeof setTimeout> | null = null;
  moveLoop:  ReturnType<typeof setTimeout> | null = null;

  constructor(readonly room: Party.Room) {}

  broadcast(msg: object, exclude?: string[]) {
    this.room.broadcast(JSON.stringify(msg), exclude);
  }

  onConnect(conn: Party.Connection) {
    const midGame = this.phase === "playing";
    this.players[conn.id] = {
      id: conn.id, name: "Player", color: "#888",
      alive: false, spectating: midGame, joinedMidGame: midGame,
      bestSurvival: 0
    };
    conn.send(JSON.stringify({
      type: "init",
      id: conn.id,
      players: this.players,
      cursors: this.cursors,
      phase: this.phase,
      leaderboard: this.leaderboard,
      spectating: midGame,
      roundStartTime: this.roundStartTime,
    }));
    this.broadcast({ type: "player_join", id: conn.id, player: this.players[conn.id] }, [conn.id]);
    this.checkShouldStart();
  }

  onMessage(message: string, sender: Party.Connection) {
    const data = JSON.parse(message);

    if (data.type === "cursor") {
      this.cursors[sender.id] = { x: data.x, y: data.y, name: data.name, color: data.color };
      const p = this.players[sender.id];
      if (p) { p.name = data.name; p.color = data.color; }
      this.broadcast({ type: "cursor", id: sender.id, x: data.x, y: data.y, name: data.name, color: data.color }, [sender.id]);
    }
  }

  onClose(conn: Party.Connection) {
    delete this.players[conn.id];
    delete this.cursors[conn.id];
    this.broadcast({ type: "leave", id: conn.id });
    if (this.phase === "playing") this.checkRoundEnd();
    if (this.phase === "waiting") this.checkShouldStart();
  }

  checkShouldStart() {
    const count = Object.keys(this.players).length;
    if (count >= MIN_PLAYERS && this.phase === "waiting") {
      this.startIntermission();
    }
    if (count === 0) {
      this.phase = "waiting";
      this.stopLoops();
    }
  }

  startIntermission() {
    this.phase = "intermission";
    this.stopLoops();
    this.clearAllLasers();
    this.broadcast({ type: "intermission", duration: INTERMISSION_MS });
    setTimeout(() => {
      if (Object.keys(this.players).length >= MIN_PLAYERS) {
        this.startRound();
      } else {
        this.phase = "waiting";
      }
    }, INTERMISSION_MS);
  }

  startRound() {
    this.phase = "playing";
    this.roundStartTime = Date.now();
    this.difficultyTimer = 0;

    // Everyone who was mid-game spectating now joins
    for (const id in this.players) {
      const p = this.players[id];
      p.alive = true;
      p.spectating = false;
      p.joinedMidGame = false;
    }

    this.broadcast({ type: "round_start", players: this.players, time: this.roundStartTime });
    setTimeout(() => this.startLaserLoop(), 1500);
    this.startMoveLoop();
  }

  // ── Laser loop ────────────────────────────────────────
  getDifficulty() {
    const level = Math.floor(this.difficultyTimer / 10000);
    return {
      interval: Math.max(900, 3000 - level * 250),
      moving:   level >= 2,
      speed:    1 + level * 0.5,
      count:    1 + Math.floor(level / 3),
    };
  }

  startLaserLoop() {
    if (this.phase !== "playing") return;
    const diff = this.getDifficulty();
    this.difficultyTimer += diff.interval;

    for (let i = 0; i < diff.count; i++) {
      setTimeout(() => this.spawnLaser(diff), i * 500);
    }

    this.laserLoop = setTimeout(() => this.startLaserLoop(), diff.interval);
  }

  spawnLaser(diff: ReturnType<typeof this.getDifficulty>) {
    if (this.phase !== "playing") return;
    const id     = `l${++this.laserCounter}`;
    const isH    = Math.random() < 0.5;
    const pos    = isH
      ? Math.random() * (1 - LASER_THICKNESS / 1000)
      : Math.random() * (1 - LASER_THICKNESS / 1000);

    const laser: Laser = {
      id, axis: isH ? "h" : "v",
      pos,   // normalized 0-1
      moving: diff.moving && Math.random() < 0.6,
      speed:  diff.speed * 0.0003,  // normalized units/ms
      dir:    Math.random() < 0.5 ? 1 : -1,
    };

    // Warn phase
    this.broadcast({ type: "laser_warn", laser });

    setTimeout(() => {
      if (this.phase !== "playing") return;
      this.lasers[id] = laser;
      this.broadcast({ type: "laser_fire", laser });
      this.checkAllCollisions();

      // Remove after duration
      setTimeout(() => {
        delete this.lasers[id];
        this.broadcast({ type: "laser_remove", id });
      }, LASER_MS);
    }, WARN_MS);
  }

  // Move loop — server moves lasers and checks collisions at 20fps
  startMoveLoop() {
    let last = Date.now();
    const tick = () => {
      if (this.phase !== "playing") return;
      const now = Date.now();
      const dt  = now - last;
      last = now;

      for (const id in this.lasers) {
        const l = this.lasers[id];
        if (!l.moving) continue;
        l.pos += l.speed * l.dir * dt;
        if (l.pos < 0) { l.pos = 0; l.dir = 1; }
        if (l.pos > 1) { l.pos = 1; l.dir = -1; }
      }

      // Broadcast all moving laser positions
      const moving = Object.values(this.lasers).filter(l => l.moving);
      if (moving.length > 0) {
        this.broadcast({ type: "lasers_move", lasers: moving.map(l => ({ id: l.id, pos: l.pos, dir: l.dir })) });
      }

      this.checkAllCollisions();
      this.moveLoop = setTimeout(tick, 50); // 20fps
    };
    this.moveLoop = setTimeout(tick, 50);
  }

  // ── Collision (server-side, authoritative) ─────────────
  checkAllCollisions() {
    for (const pid in this.players) {
      const p = this.players[pid];
      if (!p.alive || p.spectating) continue;
      const cursor = this.cursors[pid];
      if (!cursor) continue;

      for (const lid in this.lasers) {
        const l = this.lasers[lid];
        const hit = l.axis === "h"
          ? cursor.y >= l.pos && cursor.y <= l.pos + LASER_THICKNESS / 1000
          : cursor.x >= l.pos && cursor.x <= l.pos + LASER_THICKNESS / 1000;

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

  checkRoundEnd() {
    if (this.phase !== "playing") return;
    const alive = Object.values(this.players).filter(p => p.alive && !p.spectating);
    const total = Object.values(this.players).filter(p => !p.spectating);

    if (alive.length <= 1 && total.length >= 1) {
      const winner = alive[0] ?? null;
      if (winner) {
        const survived = Date.now() - this.roundStartTime;
        if (survived > winner.bestSurvival) winner.bestSurvival = survived;
        this.updateLeaderboard(winner);
      }
      this.phase = "waiting"; // use waiting so intermission re-checks
      this.stopLoops();
      this.clearAllLasers();
      this.broadcast({
        type: "round_end",
        winner: winner?.id ?? null,
        winnerName: winner?.name ?? "Nobody",
        leaderboard: this.leaderboard,
      });
      setTimeout(() => this.startIntermission(), 4000);
    }
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

  stopLoops() {
    if (this.laserLoop) { clearTimeout(this.laserLoop); this.laserLoop = null; }
    if (this.moveLoop)  { clearTimeout(this.moveLoop);  this.moveLoop  = null; }
  }

  clearAllLasers() {
    this.lasers = {};
    this.broadcast({ type: "clear_lasers" });
  }
}