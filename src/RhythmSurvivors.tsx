import React, { useEffect, useRef, useState } from "react";

// Rhythm Survivors (prototype)
// - Fixed BPM, 4-bar drum loop (WebAudio)
// - Enemies spawn in bursts on quarter-note beat (+ light subdivisions later)
// - Lasers telegraph then fire on beat
// - Destructible crates
// - Player moves with WASD
// - Weapons:
//   * Pea shooter (auto fires)
//   * Grenade launcher (lands, waits 1s, explodes AoE)
//   * Rotating swords (orbiters)
//   * Mines (drop at feet, detonate on enemy)
// - Level-ups: pick 1 of 3 upgrades
// - Auto-restart when HP hits 0
//
// NOTE: Browsers require a user gesture to start audio. Click Start.

const TAU = Math.PI * 2;

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Enemy = {
  id: number;
  x: number;
  y: number;
  r: number;
  hp: number;
  maxHp: number;
  speed: number;
  type: "grunt" | "tank";
  spawnedAtMs: number;
};

type Crate = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
};

type Laser = {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  telegraphUntilMs: number;
  activeUntilMs: number;
  thickness: number;
};

type Bullet = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  aliveUntilMs: number;
};

type Orbiter = {
  id: number;
  angle: number;
  radius: number;
  r: number;
  dmg: number;
  spin: number; // rad/s
};

type Grenade = {
  id: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  launchAtMs: number;
  landAtMs: number;
  explodeAtMs: number;
  exploded: boolean;
  dmg: number;
  radius: number;
  flashUntilMs: number;
};

type Mine = {
  id: number;
  x: number;
  y: number;
  armAtMs: number;
  dmg: number;
  radius: number;
  aliveUntilMs: number;
  flashUntilMs: number;
  exploded: boolean;
};

type Player = {
  x: number;
  y: number;
  r: number;
  hp: number;
  maxHp: number;
  speed: number;

  // Pea shooter
  bulletDamage: number;
  bulletSpeed: number;
  fireIntervalMs: number;
  nextShotAtMs: number;
  multishot: number;

  // Orbiting swords
  swordDamage: number;
  swordSize: number;
  orbiters: Orbiter[];

  // Grenades
  grenadeUnlocked: boolean;
  grenadeDamage: number;
  grenadeRadius: number;
  grenadeIntervalMs: number;
  grenadeSalvo: number;
  nextGrenadeAtMs: number;

  // Mines
  mineUnlocked: boolean;
  mineDamage: number;
  mineRadius: number;
  mineIntervalMs: number;
  nextMineAtMs: number;
};

type UpgradeKey =
  | "move_speed"
  | "max_health"
  // pea
  | "bullet_damage"
  | "bullet_rate"
  | "multishot"
  // swords
  | "add_sword"
  | "sword_damage"
  | "sword_size"
  | "sword_count"
  // grenades
  | "unlock_grenade"
  | "grenade_damage"
  | "grenade_rate"
  | "grenade_mult"
  // mines
  | "unlock_mines"
  | "mine_damage"
  | "mine_rate";

type Upgrade = {
  key: UpgradeKey;
  name: string;
  desc: string;
};

const UPGRADE_POOL: Upgrade[] = [
  { key: "move_speed", name: "Move Speed +", desc: "+15% movement speed" },
  { key: "max_health", name: "Max Health +", desc: "+25 max HP (and heal +25)" },

  { key: "bullet_damage", name: "Pea Damage +", desc: "+25% pea shooter damage" },
  { key: "bullet_rate", name: "Faster Peas", desc: "Shoot 20% faster" },
  { key: "multishot", name: "Multi-shot", desc: "+1 extra pea per burst" },

  { key: "add_sword", name: "Rotating Sword", desc: "Add a rotating sword" },
  { key: "sword_damage", name: "Sword Damage +", desc: "+30% sword damage" },
  { key: "sword_size", name: "Bigger Swords", desc: "+20% sword size" },
  { key: "sword_count", name: "More Swords", desc: "+1 sword" },

  { key: "unlock_grenade", name: "Grenade Launcher", desc: "Launch grenades that explode after 1s" },
  { key: "grenade_damage", name: "Grenade Damage +", desc: "+30% grenade damage" },
  { key: "grenade_rate", name: "Faster Grenades", desc: "Launch 20% faster" },
  { key: "grenade_mult", name: "Multi Grenade", desc: "+1 grenade per salvo" },

  { key: "unlock_mines", name: "Drop Mines", desc: "Drop mines that detonate on enemies" },
  { key: "mine_damage", name: "Mine Damage +", desc: "+30% mine damage" },
  { key: "mine_rate", name: "More Mines", desc: "Drop mines 20% faster" },
];

function nowMs() {
  return performance.now();
}

function segmentDistanceSquared(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const c1 = wx * vx + wy * vy;
  if (c1 <= 0) return dist2(px, py, x1, y1);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return dist2(px, py, x2, y2);
  const t = c1 / c2;
  return dist2(px, py, x1 + t * vx, y1 + t * vy);
}

function makeNoiseBuffer(ctx: AudioContext, seconds = 1) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.9;
  return buf;
}

function makeAudioEngine(bpm: number) {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const master = ctx.createGain();
  master.gain.value = 0.2;
  master.connect(ctx.destination);

  // 4-bar loop at 16th-note resolution
  const stepsPerBar = 16;
  const bars = 4;
  const totalSteps = stepsPerBar * bars; // 64
  const secPerBeat = 60 / bpm; // quarter note
  const secPer16 = secPerBeat / 4;

  const kick = new Array(totalSteps).fill(0);
  const snare = new Array(totalSteps).fill(0);
  const clap = new Array(totalSteps).fill(0);
  const hat = new Array(totalSteps).fill(0);
  const hat16 = new Array(totalSteps).fill(0);
  const openHat = new Array(totalSteps).fill(0);
  const bass = new Array(totalSteps).fill(0);

  // Hats: 8ths + light 16ths
  for (let s = 0; s < totalSteps; s++) {
    if (s % 2 === 0) hat[s] = 1;
    if (s % 4 === 1) hat16[s] = 1;
  }

  // Kick + bass on 1 and 3 each bar, plus a small fill at end
  for (let bar = 0; bar < bars; bar++) {
    kick[bar * stepsPerBar + 0] = 1;
    kick[bar * stepsPerBar + 8] = 1;
    bass[bar * stepsPerBar + 0] = 1;
    bass[bar * stepsPerBar + 8] = 1;
  }
  kick[stepsPerBar * 3 + 12] = 1;
  kick[stepsPerBar * 3 + 14] = 1;
  bass[stepsPerBar * 3 + 12] = 1;

  // Snare on 2 and 4, clap layered lightly
  for (let bar = 0; bar < bars; bar++) {
    snare[bar * stepsPerBar + 4] = 1;
    snare[bar * stepsPerBar + 12] = 1;
    clap[bar * stepsPerBar + 4] = 1;
    clap[bar * stepsPerBar + 12] = 1;
    if (bar === 1 || bar === 3) openHat[bar * stepsPerBar + 14] = 1;
  }

  const noise = makeNoiseBuffer(ctx, 1.0);

  function playKick(t: number) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.09);
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(1.0, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  function playBass(t: number) {
    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(55, t);
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(280, t);
    lp.Q.setValueAtTime(0.8, t);

    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.38, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    osc.connect(lp);
    lp.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  function playHat(t: number, open = false) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(open ? 5200 : 7000, t);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(open ? 0.22 : 0.32, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.22 : 0.06));

    src.connect(hp);
    hp.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + (open ? 0.24 : 0.07));
  }

  function playClap(t: number) {
    const mk = (dt: number, gain: number) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(1900, t + dt);
      bp.Q.setValueAtTime(1.1, t + dt);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t + dt);
      g.gain.exponentialRampToValueAtTime(gain, t + dt + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.08);
      src.connect(bp);
      bp.connect(g);
      g.connect(master);
      src.start(t + dt);
      src.stop(t + dt + 0.09);
    };
    mk(0.0, 0.22);
    mk(0.015, 0.16);
  }

  function playSnare(t: number) {
    const src = ctx.createBufferSource();
    src.buffer = noise;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1700, t);
    bp.Q.setValueAtTime(0.9, t);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.65, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    src.connect(bp);
    bp.connect(g);
    g.connect(master);

    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, t);
    og.gain.setValueAtTime(0.001, t);
    og.gain.exponentialRampToValueAtTime(0.18, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(og);
    og.connect(master);

    src.start(t);
    src.stop(t + 0.13);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  // Scheduler
  let isRunning = false;
  let stepIndex = 0;
  let nextStepTime = 0;
  let intervalId: number | null = null;

  const scheduleAheadSec = 0.14;
  const lookaheadMs = 25;

  function tick() {
    const current = ctx.currentTime;
    while (nextStepTime < current + scheduleAheadSec) {
      const s = stepIndex % totalSteps;

      if (kick[s]) playKick(nextStepTime);
      if (bass[s]) playBass(nextStepTime);
      if (snare[s]) playSnare(nextStepTime);
      if (clap[s]) playClap(nextStepTime + 0.006);
      if (hat[s]) playHat(nextStepTime, false);
      if (hat16[s]) playHat(nextStepTime, false);
      if (openHat[s]) playHat(nextStepTime, true);

      stepIndex += 1;
      nextStepTime += secPer16;
    }
  }

  async function start() {
    await ctx.resume();
    if (isRunning) return;
    isRunning = true;
    stepIndex = 0;
    nextStepTime = ctx.currentTime + 0.05;
    intervalId = window.setInterval(tick, lookaheadMs);
  }

  function stop() {
    if (!isRunning) return;
    isRunning = false;
    if (intervalId) window.clearInterval(intervalId);
    intervalId = null;
  }

  return {
    ctx,
    bpm,
    secPerBeat,
    secPer16,
    start,
    stop,
  };
}

export default function RhythmSurvivors() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const BPM = 120;

  const [started, setStarted] = useState(false);
  const [levelUpChoices, setLevelUpChoices] = useState<Upgrade[] | null>(null);

  const audioRef = useRef<ReturnType<typeof makeAudioEngine> | null>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const idsRef = useRef(1);

  const worldRef = useRef({ w: 1100, h: 700 });

  const playerRef = useRef<Player>({
    x: 550,
    y: 350,
    r: 14,
    hp: 100,
    maxHp: 100,
    speed: 240,

    bulletDamage: 9,
    bulletSpeed: 520,
    fireIntervalMs: 3000,
    nextShotAtMs: 0,
    multishot: 1,

    swordDamage: 10,
    swordSize: 1,
    orbiters: [],

    grenadeUnlocked: false,
    grenadeDamage: 26,
    grenadeRadius: 78,
    grenadeIntervalMs: 4200,
    grenadeSalvo: 1,
    nextGrenadeAtMs: 0,

    mineUnlocked: false,
    mineDamage: 22,
    mineRadius: 60,
    mineIntervalMs: 2600,
    nextMineAtMs: 0,
  });

  const enemiesRef = useRef<Enemy[]>([]);
  const cratesRef = useRef<Crate[]>([]);
  const lasersRef = useRef<Laser[]>([]);
  const bulletsRef = useRef<Bullet[]>([]);
  const grenadesRef = useRef<Grenade[]>([]);
  const minesRef = useRef<Mine[]>([]);

  const gameRef = useRef({
    lastMs: 0,
    timeMs: 0,
    kills: 0,
    beats: 0,
    enemyHp: 20,
    enemySpeed: 70,
    spawnPerBeat: 1,
    beatFlashUntilMs: 0,
    restartingUntilMs: 0,
  });

  const rhythmRef = useRef({
    next16Ms: 0,
    stepAbs: 0,
  });

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keysRef.current[e.key.toLowerCase()] = true;
    };
    const up = (e: KeyboardEvent) => {
      keysRef.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  function resetGame(hard = true) {
    const w = worldRef.current;
    const p = playerRef.current;
    const g = gameRef.current;

    p.x = w.w / 2;
    p.y = w.h / 2;
    p.hp = 100;
    p.maxHp = 100;
    p.speed = 240;

    p.bulletDamage = 9;
    p.bulletSpeed = 520;
    p.fireIntervalMs = 3000;
    p.nextShotAtMs = g.timeMs + 400;
    p.multishot = 1;

    p.swordDamage = 10;
    p.swordSize = 1;
    p.orbiters = [];

    p.grenadeUnlocked = false;
    p.grenadeDamage = 26;
    p.grenadeRadius = 78;
    p.grenadeIntervalMs = 4200;
    p.grenadeSalvo = 1;
    p.nextGrenadeAtMs = g.timeMs + 900;

    p.mineUnlocked = false;
    p.mineDamage = 22;
    p.mineRadius = 60;
    p.mineIntervalMs = 2600;
    p.nextMineAtMs = g.timeMs + 600;

    enemiesRef.current = [];
    cratesRef.current = [];
    lasersRef.current = [];
    bulletsRef.current = [];
    grenadesRef.current = [];
    minesRef.current = [];

    g.kills = 0;
    g.beats = 0;
    g.enemyHp = 20;
    g.enemySpeed = 70;
    g.spawnPerBeat = 1;
    g.beatFlashUntilMs = 0;

    if (hard) {
      g.timeMs = 0;
      g.lastMs = nowMs();
      rhythmRef.current.next16Ms = 0;
      rhythmRef.current.stepAbs = 0;
    }

    setLevelUpChoices(null);
  }

  function spawnEnemy(tMs: number) {
    const w = worldRef.current;
    const p = playerRef.current;
    const g = gameRef.current;

    const side = Math.floor(Math.random() * 4);
    const pad = 30;
    let x = 0,
      y = 0;

    if (side === 0) {
      x = -pad;
      y = Math.random() * w.h;
    } else if (side === 1) {
      x = w.w + pad;
      y = Math.random() * w.h;
    } else if (side === 2) {
      x = Math.random() * w.w;
      y = -pad;
    } else {
      x = Math.random() * w.w;
      y = w.h + pad;
    }

    if (dist2(x, y, p.x, p.y) < 240 * 240) {
      x = x < w.w / 2 ? -pad : w.w + pad;
      y = y < w.h / 2 ? -pad : w.h + pad;
    }

    const id = idsRef.current++;
    const phase2 = gameRef.current.timeMs >= 60000;

    const makeTank = phase2 && gameRef.current.beats % 4 === 0 && Math.random() < 0.35;

    const baseHp = gameRef.current.enemyHp;
    const hp = makeTank ? baseHp * 3.0 : baseHp;

    enemiesRef.current.push({
      id,
      x,
      y,
      r: makeTank ? 18 : 12,
      hp,
      maxHp: hp,
      speed: (makeTank ? gameRef.current.enemySpeed * 0.7 : gameRef.current.enemySpeed) + Math.random() * 25,
      type: makeTank ? "tank" : "grunt",
      spawnedAtMs: tMs,
    });
  }

  function spawnCrate() {
    const w = worldRef.current;
    const id = idsRef.current++;
    cratesRef.current.push({
      id,
      x: rand(40, w.w - 40),
      y: rand(40, w.h - 40),
      w: 28,
      h: 28,
      hp: 18,
    });
  }

  function spawnLaser(tMs: number) {
    const w = worldRef.current;
    const id = idsRef.current++;
    const horizontal = Math.random() < 0.5;

    if (horizontal) {
      const y = Math.random() * w.h;
      lasersRef.current.push({
        id,
        x1: -50,
        y1: y,
        x2: w.w + 50,
        y2: y,
        telegraphUntilMs: tMs + 180,
        activeUntilMs: tMs + 180 + 170,
        thickness: 10,
      });
    } else {
      const x = Math.random() * w.w;
      lasersRef.current.push({
        id,
        x1: x,
        y1: -50,
        x2: x,
        y2: w.h + 50,
        telegraphUntilMs: tMs + 180,
        activeUntilMs: tMs + 180 + 170,
        thickness: 10,
      });
    }
  }

  function shootPea(tMs: number) {
    const p = playerRef.current;
    const enemies = enemiesRef.current;
    if (enemies.length === 0) return;

    let best = enemies[0];
    let bestD2 = dist2(p.x, p.y, best.x, best.y);
    for (let i = 1; i < enemies.length; i++) {
      const e = enemies[i];
      const d2 = dist2(p.x, p.y, e.x, e.y);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }

    const baseAngle = Math.atan2(best.y - p.y, best.x - p.x);
    const spread = 0.16;

    for (let i = 0; i < p.multishot; i++) {
      const offset = (i - (p.multishot - 1) / 2) * spread;
      const a = baseAngle + offset;
      const id = idsRef.current++;
      bulletsRef.current.push({
        id,
        x: p.x,
        y: p.y,
        vx: Math.cos(a) * p.bulletSpeed,
        vy: Math.sin(a) * p.bulletSpeed,
        r: 4,
        dmg: p.bulletDamage,
        aliveUntilMs: tMs + 1500,
      });
    }
  }

  function launchGrenade(tMs: number) {
    const p = playerRef.current;
    if (!p.grenadeUnlocked) return;
    const enemies = enemiesRef.current;
    if (enemies.length === 0) return;

    // pick nearest enemy and throw to its current position
    let best = enemies[0];
    let bestD2 = dist2(p.x, p.y, best.x, best.y);
    for (let i = 1; i < enemies.length; i++) {
      const e = enemies[i];
      const d2 = dist2(p.x, p.y, e.x, e.y);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }

    for (let i = 0; i < p.grenadeSalvo; i++) {
      const jitter = 26;
      const toX = clamp(best.x + rand(-jitter, jitter), 20, worldRef.current.w - 20);
      const toY = clamp(best.y + rand(-jitter, jitter), 20, worldRef.current.h - 20);

      const travelMs = 420;
      const landAt = tMs + travelMs;
      const explodeAt = landAt + 1000;
      const id = idsRef.current++;

      grenadesRef.current.push({
        id,
        fromX: p.x,
        fromY: p.y,
        toX,
        toY,
        launchAtMs: tMs,
        landAtMs: landAt,
        explodeAtMs: explodeAt,
        exploded: false,
        dmg: p.grenadeDamage,
        radius: p.grenadeRadius,
        flashUntilMs: 0,
      });
    }
  }

  function dropMine(tMs: number) {
    const p = playerRef.current;
    if (!p.mineUnlocked) return;

    const id = idsRef.current++;
    minesRef.current.push({
      id,
      x: p.x,
      y: p.y,
      armAtMs: tMs + 180,
      dmg: p.mineDamage,
      radius: p.mineRadius,
      aliveUntilMs: tMs + 12000,
      flashUntilMs: 0,
      exploded: false,
    });
  }

  function levelUp() {
    const choices = shuffle(UPGRADE_POOL).slice(0, 3);
    setLevelUpChoices(choices);
  }

  function applyUpgrade(u: Upgrade) {
    const p = playerRef.current;

    switch (u.key) {
      case "move_speed":
        p.speed *= 1.15;
        break;
      case "max_health":
        p.maxHp += 25;
        p.hp = clamp(p.hp + 25, 0, p.maxHp);
        break;

      case "bullet_damage":
        p.bulletDamage *= 1.25;
        break;
      case "bullet_rate":
        p.fireIntervalMs = Math.max(300, Math.floor(p.fireIntervalMs * 0.8));
        break;
      case "multishot":
        p.multishot = Math.min(8, p.multishot + 1);
        break;

      case "add_sword": {
        const id = idsRef.current++;
        // keep radii spaced so multiple swords don't overlap too much
        const baseR = 44 + p.orbiters.length * 12;
        p.orbiters.push({
          id,
          angle: Math.random() * TAU,
          radius: baseR,
          r: 8 * p.swordSize,
          dmg: p.swordDamage,
          spin: 2.6,
        });
        break;
      }
      case "sword_damage":
        p.swordDamage *= 1.3;
        p.orbiters.forEach((o) => (o.dmg = p.swordDamage));
        break;
      case "sword_size":
        p.swordSize *= 1.2;
        p.orbiters.forEach((o) => (o.r = 8 * p.swordSize));
        break;
      case "sword_count": {
        const id = idsRef.current++;
        const baseR = 44 + p.orbiters.length * 12;
        p.orbiters.push({
          id,
          angle: Math.random() * TAU,
          radius: baseR,
          r: 8 * p.swordSize,
          dmg: p.swordDamage,
          spin: 2.6,
        });
        break;
      }

      case "unlock_grenade":
        p.grenadeUnlocked = true;
        break;
      case "grenade_damage":
        p.grenadeDamage *= 1.3;
        break;
      case "grenade_rate":
        p.grenadeIntervalMs = Math.max(700, Math.floor(p.grenadeIntervalMs * 0.8));
        break;
      case "grenade_mult":
        p.grenadeSalvo = Math.min(6, p.grenadeSalvo + 1);
        break;

      case "unlock_mines":
        p.mineUnlocked = true;
        break;
      case "mine_damage":
        p.mineDamage *= 1.3;
        break;
      case "mine_rate":
        p.mineIntervalMs = Math.max(500, Math.floor(p.mineIntervalMs * 0.8));
        break;
    }

    setLevelUpChoices(null);
  }

  function step(dt: number, tMs: number) {
    const w = worldRef.current;
    const p = playerRef.current;
    const g = gameRef.current;

    // Movement (WASD)
    const k = keysRef.current;
    const up = k["w"];
    const down = k["s"];
    const left = k["a"];
    const right = k["d"];

    let vx = 0,
      vy = 0;
    if (up) vy -= 1;
    if (down) vy += 1;
    if (left) vx -= 1;
    if (right) vx += 1;

    const mag = Math.hypot(vx, vy);
    if (mag > 0) {
      vx /= mag;
      vy /= mag;
    }

    p.x = clamp(p.x + vx * p.speed * dt, p.r, w.w - p.r);
    p.y = clamp(p.y + vy * p.speed * dt, p.r, w.h - p.r);

    // Orbiters update + damage (continuous contact)
    for (const o of p.orbiters) {
      o.angle += o.spin * dt;
      const ox = p.x + Math.cos(o.angle) * o.radius;
      const oy = p.y + Math.sin(o.angle) * o.radius;

      for (let i = enemiesRef.current.length - 1; i >= 0; i--) {
        const e = enemiesRef.current[i];
        const rr = (o.r + e.r) * (o.r + e.r);
        if (dist2(ox, oy, e.x, e.y) <= rr) {
          e.hp -= o.dmg * dt * 8;
          if (e.hp <= 0) {
            enemiesRef.current.splice(i, 1);
            g.kills += 1;
          }
        }
      }
    }

    // Enemies chase
    for (const e of enemiesRef.current) {
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      e.x += (dx / d) * e.speed * dt;
      e.y += (dy / d) * e.speed * dt;
    }

    // Bullets
    for (let i = bulletsRef.current.length - 1; i >= 0; i--) {
      const b = bulletsRef.current[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (tMs > b.aliveUntilMs || b.x < -40 || b.x > w.w + 40 || b.y < -40 || b.y > w.h + 40) {
        bulletsRef.current.splice(i, 1);
        continue;
      }

      for (let j = enemiesRef.current.length - 1; j >= 0; j--) {
        const e = enemiesRef.current[j];
        const rr = (b.r + e.r) * (b.r + e.r);
        if (dist2(b.x, b.y, e.x, e.y) <= rr) {
          e.hp -= b.dmg;
          bulletsRef.current.splice(i, 1);
          if (e.hp <= 0) {
            enemiesRef.current.splice(j, 1);
            g.kills += 1;
          }
          break;
        }
      }
    }

    // Grenades (position lerp while flying; explode after delay)
    for (let i = grenadesRef.current.length - 1; i >= 0; i--) {
      const gr = grenadesRef.current[i];

      if (!gr.exploded && tMs >= gr.explodeAtMs) {
        gr.exploded = true;
        gr.flashUntilMs = tMs + 120;

        // AoE damage
        const r2 = gr.radius * gr.radius;
        for (let j = enemiesRef.current.length - 1; j >= 0; j--) {
          const e = enemiesRef.current[j];
          if (dist2(gr.toX, gr.toY, e.x, e.y) <= r2) {
            e.hp -= gr.dmg;
            if (e.hp <= 0) {
              enemiesRef.current.splice(j, 1);
              g.kills += 1;
            }
          }
        }
      }

      // cleanup after explosion flash ends
      if (gr.exploded && tMs > gr.flashUntilMs + 160) {
        grenadesRef.current.splice(i, 1);
        continue;
      }
    }

    // Mines (arm, detonate on enemy contact)
    for (let i = minesRef.current.length - 1; i >= 0; i--) {
      const m = minesRef.current[i];

      if (tMs > m.aliveUntilMs) {
        minesRef.current.splice(i, 1);
        continue;
      }

      if (!m.exploded && tMs >= m.armAtMs) {
        for (let j = enemiesRef.current.length - 1; j >= 0; j--) {
          const e = enemiesRef.current[j];
          const rr = (m.radius + e.r) * (m.radius + e.r);
          if (dist2(m.x, m.y, e.x, e.y) <= rr) {
            m.exploded = true;
            m.flashUntilMs = tMs + 120;
            const r2 = m.radius * m.radius;
            for (let k2 = enemiesRef.current.length - 1; k2 >= 0; k2--) {
              const ee = enemiesRef.current[k2];
              if (dist2(m.x, m.y, ee.x, ee.y) <= r2) {
                ee.hp -= m.dmg;
                if (ee.hp <= 0) {
                  enemiesRef.current.splice(k2, 1);
                  g.kills += 1;
                }
              }
            }
            break;
          }
        }
      }

      if (m.exploded && tMs > m.flashUntilMs + 160) {
        minesRef.current.splice(i, 1);
      }
    }

    // Lasers cleanup
    lasersRef.current = lasersRef.current.filter((lz) => lz.activeUntilMs > tMs);

    // Contact damage
    for (const e of enemiesRef.current) {
      const rr = (p.r + e.r) * (p.r + e.r);
      if (dist2(p.x, p.y, e.x, e.y) <= rr) {
        p.hp -= 22 * dt;
      }
    }

    // Laser damage
    for (const lz of lasersRef.current) {
      if (tMs >= lz.telegraphUntilMs && tMs <= lz.activeUntilMs) {
        const d2 = segmentDistanceSquared(p.x, p.y, lz.x1, lz.y1, lz.x2, lz.y2);
        const rr = (p.r + lz.thickness / 2) * (p.r + lz.thickness / 2);
        if (d2 <= rr) p.hp -= 90 * dt;
      }
    }

    p.hp = clamp(p.hp, 0, p.maxHp);

    // Weapon timers
    if (tMs >= p.nextShotAtMs) {
      shootPea(tMs);
      p.nextShotAtMs = tMs + p.fireIntervalMs;
    }

    if (p.grenadeUnlocked && tMs >= p.nextGrenadeAtMs) {
      launchGrenade(tMs);
      p.nextGrenadeAtMs = tMs + p.grenadeIntervalMs;
    }

    if (p.mineUnlocked && tMs >= p.nextMineAtMs) {
      dropMine(tMs);
      p.nextMineAtMs = tMs + p.mineIntervalMs;
    }

    // Auto restart
    if (p.hp <= 0 && tMs >= g.restartingUntilMs) {
      g.restartingUntilMs = tMs + 650;
      resetGame(false);
    }
  }

  function onQuarterBeat(tMs: number) {
    const g = gameRef.current;
    g.beats += 1;

    g.beatFlashUntilMs = tMs + 85;

    // Difficulty ramp every 16 beats (~8 seconds at 120 BPM)
    if (g.beats % 16 === 0) {
      if (g.spawnPerBeat < 7) g.spawnPerBeat += 1;
      g.enemySpeed += 3;
      levelUp();
    }

    // One-minute mark: enemies get tougher (more base HP over time)
    if (g.timeMs >= 60000 && g.beats % 8 === 0) {
      g.enemyHp += 18;
    }

    for (let i = 0; i < g.spawnPerBeat; i++) spawnEnemy(tMs);

    if (g.beats % 8 === 0) spawnCrate();

    if (g.beats % 4 === 0) spawnLaser(tMs);
  }

  function onSubdivStep(step: number, tMs: number) {
    // 16th note steps; quarter notes are multiples of 4
    if (step % 4 === 0) onQuarterBeat(tMs);

    // Very light off-beat spawns after 25s (keeps beat obvious)
    if (step % 4 !== 0 && gameRef.current.timeMs >= 25000) {
      if (step % 8 === 6 && Math.random() < 0.12) spawnEnemy(tMs);
    }
  }

  function draw(ctx: CanvasRenderingContext2D, tMs: number) {
    const w = worldRef.current;
    const p = playerRef.current;
    const g = gameRef.current;

    ctx.clearRect(0, 0, w.w, w.h);
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, w.w, w.h);

    // Crates
    for (const c of cratesRef.current) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.fillStyle = "#2a2430";
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.strokeStyle = "#4c3f58";
      ctx.lineWidth = 2;
      ctx.strokeRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }

    // Lasers
    for (const lz of lasersRef.current) {
      const tele = tMs < lz.telegraphUntilMs;
      const active = tMs >= lz.telegraphUntilMs && tMs <= lz.activeUntilMs;
      if (!tele && !active) continue;
      ctx.save();
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(lz.x1, lz.y1);
      ctx.lineTo(lz.x2, lz.y2);
      ctx.lineWidth = lz.thickness;
      ctx.strokeStyle = tele ? "rgba(255,60,60,0.20)" : "rgba(255,60,60,0.75)";
      ctx.stroke();
      if (tele) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(255,60,60,0.55)";
        ctx.stroke();
      }
      ctx.restore();
    }

    // Mines
    for (const m of minesRef.current) {
      const armed = tMs >= m.armAtMs;
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.fillStyle = armed ? "rgba(120,255,160,0.85)" : "rgba(120,255,160,0.35)";
      ctx.fillRect(-7, -7, 14, 14);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.strokeRect(-7, -7, 14, 14);
      ctx.restore();

      if (m.exploded && tMs <= m.flashUntilMs) {
        const a = (m.flashUntilMs - tMs) / 120;
        ctx.fillStyle = `rgba(120,255,160,${0.12 * a})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.radius, 0, TAU);
        ctx.fill();
      }
    }

    // Grenades
    for (const gr of grenadesRef.current) {
      const flying = tMs < gr.landAtMs;
      let gx = gr.toX;
      let gy = gr.toY;
      if (flying) {
        const t = clamp((tMs - gr.launchAtMs) / (gr.landAtMs - gr.launchAtMs), 0, 1);
        gx = gr.fromX + (gr.toX - gr.fromX) * t;
        gy = gr.fromY + (gr.toY - gr.fromY) * t - Math.sin(t * Math.PI) * 26; // tiny arc
      }

      // grenade body
      ctx.beginPath();
      ctx.arc(gx, gy, 6, 0, TAU);
      ctx.fillStyle = "#ffd166";
      ctx.fill();

      // armed ring while waiting
      if (tMs >= gr.landAtMs && !gr.exploded) {
        const remain = Math.max(0, gr.explodeAtMs - tMs);
        const frac = clamp(1 - remain / 1000, 0, 1);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(gr.toX, gr.toY, 12, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
        ctx.stroke();
      }

      if (gr.exploded && tMs <= gr.flashUntilMs) {
        const a = (gr.flashUntilMs - tMs) / 120;
        ctx.fillStyle = `rgba(255,209,102,${0.14 * a})`;
        ctx.beginPath();
        ctx.arc(gr.toX, gr.toY, gr.radius, 0, TAU);
        ctx.fill();
      }
    }

    // Bullets
    for (const b of bulletsRef.current) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fillStyle = "#c7f9cc";
      ctx.fill();
    }

    // Enemies
    for (const e of enemiesRef.current) {
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, TAU);
      ctx.fillStyle = e.type === "tank" ? "#8a3bff" : "#b44b6a";
      ctx.fill();

      const age = tMs - e.spawnedAtMs;
      if (age >= 0 && age < 220) {
        const a = 1 - age / 220;
        const rr = e.r + 10 + age * 0.07;
        ctx.strokeStyle = `rgba(255,255,255,${0.35 * a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x, e.y, rr, 0, TAU);
        ctx.stroke();
      }

      if (e.type === "tank") {
        const frac = clamp(e.hp / e.maxHp, 0, 1);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r + 6, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
        ctx.stroke();
      }
    }

    // Orbiters (draw as swords)
    for (const o of p.orbiters) {
      const ox = p.x + Math.cos(o.angle) * o.radius;
      const oy = p.y + Math.sin(o.angle) * o.radius;
      const rot = o.angle + Math.PI / 2;

      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(rot);
      const s = p.swordSize;

      // Blade
      ctx.fillStyle = "#f2c14e";
      ctx.beginPath();
      ctx.moveTo(0, -18 * s);
      ctx.lineTo(6 * s, 10 * s);
      ctx.lineTo(0, 18 * s);
      ctx.lineTo(-6 * s, 10 * s);
      ctx.closePath();
      ctx.fill();

      // Guard
      ctx.fillStyle = "#d19b2a";
      ctx.fillRect(-10 * s, 8 * s, 20 * s, 4 * s);

      // Handle
      ctx.fillStyle = "#8a5a2b";
      ctx.fillRect(-3 * s, 12 * s, 6 * s, 10 * s);

      ctx.restore();
    }

    // Player
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fillStyle = "#64b6ff";
    ctx.fill();

    // UI
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "14px ui-sans-serif, system-ui, -apple-system";
    ctx.fillText(`BPM: ${BPM} (4-bar loop)`, 12, 18);
    ctx.fillText(`Beats: ${g.beats}`, 12, 38);
    ctx.fillText(`Kills: ${g.kills}`, 12, 58);
    ctx.fillText(
      `Pea: ${Math.round(p.bulletDamage)} dmg / ${p.fireIntervalMs}ms / x${p.multishot} | Spawn/beat: ${g.spawnPerBeat} | HPbase: ${Math.round(g.enemyHp)}`,
      12,
      78
    );
    ctx.fillText(
      `Grenades: ${p.grenadeUnlocked ? `ON (${p.grenadeIntervalMs}ms x${p.grenadeSalvo})` : "OFF"} | Mines: ${p.mineUnlocked ? `ON (${p.mineIntervalMs}ms)` : "OFF"} | Swords: ${p.orbiters.length}`,
      12,
      98
    );

    // Beat flash overlay
    if (tMs < g.beatFlashUntilMs) {
      const a = (g.beatFlashUntilMs - tMs) / 85;
      ctx.fillStyle = `rgba(255,255,255,${0.10 * a})`;
      ctx.fillRect(0, 0, w.w, w.h);
    }

    // HP bar
    const barW = 280;
    const barH = 12;
    const x = 12;
    const y = w.h - 14;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x, y - barH, barW, barH);
    ctx.fillStyle = "rgba(120,255,160,0.85)";
    ctx.fillRect(x, y - barH, barW * (p.hp / p.maxHp), barH);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.strokeRect(x, y - barH, barW, barH);

    if (tMs < g.restartingUntilMs) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, w.w, w.h);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = "26px ui-sans-serif, system-ui, -apple-system";
      ctx.fillText("YOU DIED", w.w / 2 - 58, w.h / 2 - 8);
      ctx.font = "14px ui-sans-serif, system-ui, -apple-system";
      ctx.fillText("Auto-restarting…", w.w / 2 - 58, w.h / 2 + 18);
    }
  }

  function loop() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const t = nowMs();
    const g = gameRef.current;

    if (!g.lastMs) g.lastMs = t;
    const dt = clamp((t - g.lastMs) / 1000, 0, 0.05);
    g.lastMs = t;

    if (started && !levelUpChoices) {
      g.timeMs += dt * 1000;
      step(dt, g.timeMs);
    }

    // Rhythm clock in lockstep with game time
    if (started && !levelUpChoices) {
      const r = rhythmRef.current;
      const secPer16 = (60 / BPM) / 4;
      const stepMs = secPer16 * 1000;
      if (r.next16Ms === 0) r.next16Ms = stepMs;
      while (g.timeMs >= r.next16Ms) {
        const stepInLoop = r.stepAbs % 64;
        onSubdivStep(stepInLoop, r.next16Ms);
        r.stepAbs += 1;
        r.next16Ms += stepMs;
      }
    }

    draw(ctx, g.timeMs);
    rafRef.current = requestAnimationFrame(loop);
  }

  async function start() {
    if (!audioRef.current) audioRef.current = makeAudioEngine(BPM);
    resetGame(true);
    setStarted(true);
    await audioRef.current!.start();
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = worldRef.current;
    canvas.width = w.w;
    canvas.height = w.h;

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, levelUpChoices]);

  const upgradeOverlay = levelUpChoices ? (
    <div className="rs-upgrade-overlay">
      <div className="rs-upgrade-list">
        {levelUpChoices.map((u) => (
          <button key={u.key + u.name} onClick={() => applyUpgrade(u)} className="rs-upgrade-button">
            <div className="rs-upgrade-title">{u.name}</div>
            <div className="rs-upgrade-desc">{u.desc}</div>
            <div className="rs-upgrade-meta">Click to choose</div>
          </button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div className="rs-page">
      <div className="rs-shell">
        <div className="rs-header">
          <div>
            <div className="rs-title">Rhythm Survivors</div>
            <div className="rs-subtitle">
              WASD to move. Spawns &amp; lasers sync to the beat. Starter weapon: pea shooter.
            </div>
          </div>
          {!started ? (
            <button onClick={start} className="rs-start-button">
              Start (enable audio)
            </button>
          ) : (
            <div className="rs-status">Running</div>
          )}
        </div>

        <div className="rs-canvas-wrap">
          <canvas ref={canvasRef} className="rs-canvas" />
          {upgradeOverlay}
          {!started && (
            <div className="rs-overlay">
              <div className="rs-overlay-card">
                <div className="rs-overlay-title">Click Start</div>
                <div className="rs-overlay-body">
                  Browsers block audio until you click. Then the 4-bar loop starts and spawns begin.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="rs-footer">
          <span>• Enemies chase</span>
          <span>• Lasers telegraph then fire on beat</span>
          <span>• Crates are destructible (cosmetic)</span>
          <span>• Level-up every 16 beats</span>
        </div>
      </div>
    </div>
  );
}
