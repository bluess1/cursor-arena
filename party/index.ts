import type * as Party from "partykit/server";

type GameId = "laser" | "mansion";

type Player = {
  id: string; name: string; color: string;
  alive: boolean; role: "hunter" | "hider" | null;
  spectating: boolean; bestSurvival: number; vote: GameId | null;
};
type Cursor = { x: number; y: number; name: string; color: string };
type Laser  = { id: string; axis: "h"|"v"; pos: number; moving: boolean; speed: number; dir: number; };

const VOTE_MS          = 10000;
const ROUND_START_MS   = 3000;
const MIN_PLAYERS      = 1;
const LASER_THICK_NORM = 0.040;
const WARN_MS          = 1200;
const LASER_MS         = 700;
const CATCH_RADIUS     = 0.036;

export default class GameServer implements Party.Server {
  players:     Record<string, Player> = {};
  cursors:     Record<string, Cursor> = {};
  prevCursors: Record<string, Cursor> = {};
  leaderboard: { name: string; color: string; best: number }[] = [];

  phase: "waiting" | "voting" | "playing" = "waiting";
  currentGame: GameId = "laser";
  roundStartTime = 0;
  mazeSeed = 0;
  laserCounter = 0;
  diffTimer = 0;
  hunterId: string | null = null;
  activeLasers: Record<string, Laser> = {};

  laserLoop: ReturnType<typeof setTimeout>  | null = null;
  moveLoop:  ReturnType<typeof setTimeout>  | null = null;
  catchLoop: ReturnType<typeof setInterval> | null = null;
  voteTimer: ReturnType<typeof setTimeout>  | null = null;
  voteEnd = 0; // absolute timestamp when voting ends

  constructor(readonly room: Party.Room) {}

  broadcast(msg: object, exclude?: string[]) { this.room.broadcast(JSON.stringify(msg), exclude); }
  send(id: string, msg: object) { this.room.getConnection(id)?.send(JSON.stringify(msg)); }

  onConnect(conn: Party.Connection) {
    const midGame = this.phase === "playing";
    this.players[conn.id] = {
      id: conn.id, name: "Player", color: "#888",
      alive: false, role: null, spectating: midGame, bestSurvival: 0, vote: null,
    };
    conn.send(JSON.stringify({
      type: "init", id: conn.id, players: this.players, cursors: this.cursors,
      phase: this.phase, currentGame: this.currentGame, leaderboard: this.leaderboard,
      spectating: midGame, roundStartTime: this.roundStartTime, mazeSeed: this.mazeSeed,
      voteEnd: this.voteEnd,
    }));
    this.broadcast({ type: "player_join", id: conn.id, player: this.players[conn.id] }, [conn.id]);
    this.checkShouldStart();
  }

  onMessage(message: string, sender: Party.Connection) {
    const data = JSON.parse(message);
    const p = this.players[sender.id];
    if (!p) return;

    if (data.type === "hello") { p.name = data.name; p.color = data.color; }

    if (data.type === "cursor") {
      if (this.cursors[sender.id]) this.prevCursors[sender.id] = { ...this.cursors[sender.id] };
      this.cursors[sender.id] = { x: data.x, y: data.y, name: data.name, color: data.color };
      p.name = data.name; p.color = data.color;
      this.broadcast({ type: "cursor", id: sender.id, x: data.x, y: data.y, name: data.name, color: data.color }, [sender.id]);
      if (this.phase === "playing" && this.currentGame === "laser") this.checkSweepCollision(sender.id);
    }

    if (data.type === "vote" && this.phase === "voting") {
      p.vote = data.game as GameId;
      this.broadcastVoteCounts();
    }
  }

  onClose(conn: Party.Connection) {
    const wasHunter = this.players[conn.id]?.role === "hunter";
    delete this.players[conn.id]; delete this.cursors[conn.id]; delete this.prevCursors[conn.id];
    this.broadcast({ type: "leave", id: conn.id });

    const remaining = Object.keys(this.players).length;

    // Nobody left — full reset
    if (remaining === 0) {
      this.stopAllLoops();
      this.clearLasers();
      this.phase = "waiting";
      this.hunterId = null;
      return;
    }

    if (this.phase === "playing") {
      if (this.currentGame === "mansion" && wasHunter) {
        // Hunter left — hiders win, pick a random hider as winner
        const hiders = Object.values(this.players).filter(p => p.role === "hider" && p.alive);
        this.endRound(hiders[0] ?? null, "hider");
      } else {
        this.checkRoundEnd();
      }
    }

    if (this.phase === "voting") this.broadcastVoteCounts();
    if (this.phase === "waiting") this.checkShouldStart();
  }

  // ── Flow ────────────────────────────────────────
  checkShouldStart() {
    const count = Object.keys(this.players).length;
    if (count >= MIN_PLAYERS && this.phase === "waiting") this.startVoting();
    if (count === 0) { this.phase = "waiting"; this.stopAllLoops(); }
  }

  startVoting() {
    this.phase = "voting";
    this.stopAllLoops();
    for (const id in this.players) this.players[id].vote = null;
    this.voteEnd = Date.now() + VOTE_MS;
    this.broadcast({ type: "voting_start", duration: VOTE_MS, voteEnd: this.voteEnd });
    this.broadcastVoteCounts();
    this.voteTimer = setTimeout(() => this.resolveVote(), VOTE_MS);
  }

  broadcastVoteCounts() {
    const counts: Record<GameId, number> = { laser: 0, mansion: 0 };
    for (const id in this.players) { const v = this.players[id].vote; if (v) counts[v]++; }
    this.broadcast({ type: "vote_update", counts, total: Object.keys(this.players).length });
  }

  resolveVote() {
    const counts: Record<GameId, number> = { laser: 0, mansion: 0 };
    for (const id in this.players) { const v = this.players[id].vote; if (v) counts[v]++; }
    let winner: GameId =
      counts.laser > counts.mansion ? "laser" :
      counts.mansion > counts.laser ? "mansion" :
      Math.random() < 0.5 ? "laser" : "mansion";
    this.currentGame = winner;
    this.broadcast({ type: "vote_result", winner, counts });
    setTimeout(() => this.startRound(), ROUND_START_MS);
  }

  startRound() {
    this.phase = "playing"; this.roundStartTime = Date.now();
    this.diffTimer = 0; this.mazeSeed = Math.floor(Math.random() * 0xFFFFFF);
    for (const id in this.players) {
      const p = this.players[id];
      p.alive = true; p.spectating = false; p.role = null; p.vote = null;
    }
    if (this.currentGame === "mansion") {
      const ids = Object.keys(this.players);
      this.hunterId = ids[Math.floor(Math.random() * ids.length)];
      for (const id in this.players)
        this.players[id].role = id === this.hunterId ? "hunter" : "hider";
    }
    this.broadcast({ type: "round_start", game: this.currentGame, players: this.players, time: this.roundStartTime, mazeSeed: this.mazeSeed });
    if (this.currentGame === "mansion") {
      for (const id in this.players) this.send(id, { type: "role_assigned", role: this.players[id].role });
      this.startCatchLoop();
    }
    if (this.currentGame === "laser") {
      setTimeout(() => this.laserTick(), 1500);
      this.startMoveLoop();
    }
  }

  checkRoundEnd() {
    if (this.phase !== "playing") return;

    const activePlayers = Object.values(this.players).filter(p => !p.spectating);
    if (activePlayers.length === 0) {
      this.endRound(null, null);
      return;
    }

    if (this.currentGame === "laser") {
      const alive = activePlayers.filter(p => p.alive);
      // End if 0 or 1 alive (or only 1 player total)
      if (alive.length <= 1) this.endRound(alive[0] ?? null, "survivor");
    }

    if (this.currentGame === "mansion") {
      const aliveHiders = activePlayers.filter(p => p.role === "hider" && p.alive);
      if (aliveHiders.length === 0) {
        const hunter = this.hunterId ? this.players[this.hunterId] : null;
        this.endRound(hunter ?? null, "hunter");
      }
    }
  }

  endRound(winner: Player | null, winnerRole: string | null) {
    if (this.phase !== "playing") return;
    this.phase = "waiting"; this.stopAllLoops(); this.clearLasers();
    if (winner) {
      const survived = Date.now() - this.roundStartTime;
      if (survived > winner.bestSurvival) winner.bestSurvival = survived;
      this.updateLeaderboard(winner);
    }
    this.broadcast({ type: "round_end", game: this.currentGame, winner: winner?.id ?? null, winnerName: winner?.name ?? "Nobody", winnerRole, leaderboard: this.leaderboard });
    setTimeout(() => this.startVoting(), 4000);
  }

  // ── Laser ────────────────────────────────────────
  getDiff() {
    const lv = Math.floor(this.diffTimer / 10000);
    return { interval: Math.max(900, 3000 - lv*250), moving: lv>=2, speed: 1+lv*0.5, count: 1+Math.floor(lv/3) };
  }
  laserTick() {
    if (this.phase !== "playing" || this.currentGame !== "laser") return;
    const diff = this.getDiff(); this.diffTimer += diff.interval;
    for (let i=0; i<diff.count; i++) setTimeout(() => this.spawnLaser(diff), i*500);
    this.laserLoop = setTimeout(() => this.laserTick(), diff.interval);
  }
  spawnLaser(diff: ReturnType<typeof this.getDiff>) {
    if (this.phase !== "playing" || this.currentGame !== "laser") return;
    const id = `l${++this.laserCounter}`, isH = Math.random()<0.5;
    const laser: Laser = {
      id, axis: isH?"h":"v",
      pos: Math.random()*(1-LASER_THICK_NORM*2)+LASER_THICK_NORM,
      moving: diff.moving&&Math.random()<0.6,
      speed: diff.speed*0.0003, dir: Math.random()<0.5?1:-1,
    };
    this.broadcast({ type: "laser_warn", laser });
    setTimeout(() => {
      if (this.phase !== "playing" || this.currentGame !== "laser") return;
      this.activeLasers[id] = laser;
      this.broadcast({ type: "laser_fire", laser });
      this.checkAllLaserCollisions();
      setTimeout(() => { delete this.activeLasers[id]; this.broadcast({ type: "laser_remove", id }); }, LASER_MS);
    }, WARN_MS);
  }
  pointInLaser(x: number, y: number, l: Laser) {
    return l.axis==="h" ? y>=l.pos&&y<=l.pos+LASER_THICK_NORM : x>=l.pos&&x<=l.pos+LASER_THICK_NORM;
  }
  segmentCrossesLaser(x0:number,y0:number,x1:number,y1:number,l:Laser) {
    if (this.pointInLaser(x0,y0,l)||this.pointInLaser(x1,y1,l)) return true;
    if (l.axis==="h") {
      const yMin=Math.min(y0,y1),yMax=Math.max(y0,y1);
      return !(yMax<l.pos||yMin>l.pos+LASER_THICK_NORM);
    } else {
      const xMin=Math.min(x0,x1),xMax=Math.max(x0,x1);
      return !(xMax<l.pos||xMin>l.pos+LASER_THICK_NORM);
    }
  }
  checkSweepCollision(pid: string) {
    const p=this.players[pid]; if(!p||!p.alive||p.spectating) return;
    const cur=this.cursors[pid],prev=this.prevCursors[pid]; if(!cur) return;
    for (const lid in this.activeLasers) {
      const hit=prev ? this.segmentCrossesLaser(prev.x,prev.y,cur.x,cur.y,this.activeLasers[lid]) : this.pointInLaser(cur.x,cur.y,this.activeLasers[lid]);
      if (hit) { this.killPlayer(pid); break; }
    }
  }
  checkAllLaserCollisions() {
    for (const pid in this.players) {
      const p=this.players[pid]; if(!p.alive||p.spectating) continue;
      const cur=this.cursors[pid]; if(!cur) continue;
      for (const lid in this.activeLasers) if (this.pointInLaser(cur.x,cur.y,this.activeLasers[lid])) { this.killPlayer(pid); break; }
    }
  }
  killPlayer(pid: string) {
    const p=this.players[pid]; if(!p||!p.alive) return;
    p.alive=false;
    const survived=Date.now()-this.roundStartTime;
    if(survived>p.bestSurvival) p.bestSurvival=survived;
    this.updateLeaderboard(p);
    this.broadcast({ type:"player_dead", id:pid, survived, leaderboard:this.leaderboard });
    this.checkRoundEnd();
  }
  startMoveLoop() {
    let last=Date.now();
    const tick=()=>{
      if(this.phase!=="playing"||this.currentGame!=="laser") return;
      const now=Date.now(),dt=now-last;last=now;
      for(const id in this.activeLasers){
        const l=this.activeLasers[id]; if(!l.moving) continue;
        l.pos+=l.speed*l.dir*dt;
        if(l.pos<0.01){l.pos=0.01;l.dir=1;}
        if(l.pos>1-LASER_THICK_NORM-0.01){l.pos=1-LASER_THICK_NORM-0.01;l.dir=-1;}
      }
      const moving=Object.values(this.activeLasers).filter(l=>l.moving);
      if(moving.length>0) this.broadcast({type:"lasers_move",lasers:moving.map(l=>({id:l.id,pos:l.pos}))});
      this.checkAllLaserCollisions();
      this.moveLoop=setTimeout(tick,50);
    };
    this.moveLoop=setTimeout(tick,50);
  }

  // ── Mansion ──────────────────────────────────────
  startCatchLoop() {
    this.catchLoop=setInterval(()=>{
      if(this.phase!=="playing"||this.currentGame!=="mansion") return;
      if(!this.hunterId) return;
      const hc=this.cursors[this.hunterId]; if(!hc) return;
      for(const[id,p]of Object.entries(this.players)){
        if(id===this.hunterId||!p.alive||p.spectating) continue;
        const cur=this.cursors[id]; if(!cur) continue;
        if(Math.hypot(hc.x-cur.x,hc.y-cur.y)<CATCH_RADIUS){
          p.alive=false;
          const survived=Date.now()-this.roundStartTime;
          if(survived>p.bestSurvival) p.bestSurvival=survived;
          this.updateLeaderboard(p);
          this.broadcast({type:"player_caught",id,survived,leaderboard:this.leaderboard});
          this.checkRoundEnd();
        }
      }
    },50);
  }

  // ── Util ─────────────────────────────────────────
  clearLasers() { this.activeLasers={}; this.broadcast({type:"clear_lasers"}); }
  stopAllLoops() {
    if(this.laserLoop){clearTimeout(this.laserLoop);this.laserLoop=null;}
    if(this.moveLoop){clearTimeout(this.moveLoop);this.moveLoop=null;}
    if(this.catchLoop){clearInterval(this.catchLoop);this.catchLoop=null;}
    if(this.voteTimer){clearTimeout(this.voteTimer);this.voteTimer=null;}
  }
  updateLeaderboard(p: Player) {
    const ex=this.leaderboard.find(e=>e.name===p.name);
    if(ex){if(p.bestSurvival>ex.best){ex.best=p.bestSurvival;ex.color=p.color;}}
    else this.leaderboard.push({name:p.name,color:p.color,best:p.bestSurvival});
    this.leaderboard.sort((a,b)=>b.best-a.best);
    this.leaderboard=this.leaderboard.slice(0,10);
  }
}
