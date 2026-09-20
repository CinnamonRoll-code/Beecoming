// 蜂年 · 实时原型 · 模拟核心
// 设计依据: doc/蜂群游戏_02_玩法设计_v6.md (第 1.4、1.9、2、4、5、9 节)
// 1 tick = 1 天。数量按 1:100 缩小(1 只 = 真实 100 只),时间不缩。
// 蜂蜜以"格"为单位:1 单位蜂蜜占 1 格巢房。
(function (root) {
'use strict';

const CFG = {
  S: 91,                 // 春/夏/秋每季天数
  W: 90,                 // 冬季天数
  startBees: 120,
  startHoney: 200,         // 开春靠越冬剩下的存蜜
  startCells: 450,         // 开局巢房用了约七成,留出产卵空间
  startBroodPerDay: 5,     // 开局子脾:每个日龄 5 只(否则前 21 天没有新蜂)
  startTarget: { forage: 0.40, nurse: 0.25, guard: 0.15, build: 0.20 },

  // 采集与加工
  nectarPerForager: 0.30,  // 每只采集蜂每天带回的蜜(花期 1.0、晴天);主流蜜期 ×2.2。真实:约 10 趟 × 40 mg 花蜜
  procPerBuilder: 0.90,    // 每只筑巢蜂每天能接收的蜜(巢空时)
  procFillSlow: 1.2,       // 巢越满加工越慢:容量 ÷ (1 + 1.8 × 满度²)  —— 空巢约 10 分钟、满巢约 28 分钟
  overflowKeep: 0.3,       // 卸不下的蜜只能留住三成

  // 造脾
  buildPerBuilder: 0.12,   // 每只筑巢蜂每天造的巢房格数(条件满足时);强群流蜜期一周约 1~2 张脾
  buildIdleFrac: 0.05,     // 条件不满足时的造脾比例
  waxCost: 0.2,            // 每格巢房耗蜜(1 g 蜡 ≈ 6 g 蜜)
  cellsPerLayer: 70,

  // 育幼
  broodDays: 21,
  eggsPerNurse: 0.30,      // 每只育幼蜂每天能照顾的新卵
  eggHoneyCost: 0.30,      // 养大一只蜂的耗蜜(真实约 140 mg)

  // 消耗与寿命
  eatActive: 0.0185,       // 真实约 7 mg/只/天
  eatWinter: 0.022,        // 一冬约 2 格/只
  weakCluster: 150,        // 冬团小于此数,每只蜂耗蜜更多
  mortForager: 1 / 20,
  mortInside: 1 / 50,
  mortWinter: 1 / 200,

  shiftRate: 0.25,         // 改分配后,每天完成剩余差距的 25%(几天内逐步生效)

  // 歇工:连日下雨,采集蜂出不了门,一部分歇工;天晴后出现摇晃信号,要玩家派回岗位
  rainIdleAfter: 2,        // 连续下雨第几天起开始有蜂歇工
  rainIdleFrac: 0.25,      // 每个雨天有多少比例的采集蜂转去歇工

  // 分蜂
  swarmMinBees: 250,
  swarmOcc: 0.92,
  swarmMax: 14,            // 压力攒满就自然分蜂
  splitFrac: 0.40,         // 玩家主动分蜂:分出去 40%
  natSwarmLoss: 0.60,      // 自然分蜂:老王带走约 2/3
  natSwarmHoneyLoss: 0.25,
  requeenDays: 16,         // 自然分蜂后新王交尾前停产
  swarmCooldown: 40,       // 分蜂后这么多天内不会再攒分蜂压力

  minColony: 12,

  // 威胁
  hornetDailyChance: 0.03,
  hornetGuardFrac: 0.12,   // 胡蜂来时需要的守卫占蜂群比例(× 难度)
  robDailyChance: 0.015,
  robGuardFrac: 0.08,
  diffGrow: 0.12, diffRelief: 0.10, diffFloor: 0.6,

  sigThresh: 0.25,         // 信号强于此值算"明显"
  sigPersist: 4,           // 连续这么多天明显 = "持续"
};

const JOBS = ['forage', 'nurse', 'guard', 'build'];

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function seasonOf(d) {
  const S = CFG.S;
  return d < S ? 'spring' : d < 2 * S ? 'summer' : d < 3 * S ? 'autumn' : 'winter';
}
function yearLen() { return 3 * CFG.S + CFG.W; }

// 花期曲线:春天渐强 → 夏初主流蜜期(短而猛)→ 夏末缺蜜 → 秋季次蜜源 → 凋零
function bloomBase(d, yr) {
  const S = CFG.S;
  if (d < S) return 0.3 + 0.7 * d / S;
  if (d < 2 * S) {
    const x = d - S - yr.flowShift;
    if (x < 10) return 1.0;
    if (x < 10 + yr.flowLen) return 2.2;
    if (x < 55) return 1.0;
    return 0.35;
  }
  if (d < 3 * S) {
    const x = d - 2 * S;
    if (x < 30) return 0.85;
    return Math.max(0.05, 0.85 * (1 - (x - 30) / 61));
  }
  return 0;
}

function queenMax(d) {
  const S = CFG.S;
  if (d < S) return 6 + 14 * d / S;
  if (d < 2 * S) return (d - S) < 60 ? 20 : 20 - 8 * (d - S - 60) / (S - 60);
  if (d < 3 * S) return 12 - 10 * (d - 2 * S) / S;
  return (d > yearLen() - 21) ? 3 : 0;
}

const WEATHER = {
  sun:   { f: 1.00, label: '晴', icon: '☀️' },
  cloud: { f: 0.60, label: '阴', icon: '⛅' },
  rain:  { f: 0.05, label: '雨', icon: '🌧' },
};

function newYear(s) {
  const r = s.rng;
  const roll = r();
  s.yr = {
    bloomMult: roll < 0.25 ? 1.25 : roll < 0.75 ? 1.0 : 0.72,
    bloomLabel: roll < 0.25 ? '花期丰沛' : roll < 0.75 ? '花期平常' : '花期萧条',
    flowShift: Math.floor(r() * 15) - 7,
    flowLen: 18 + Math.floor(r() * 12),
    droughtStart: r() < 0.3 ? CFG.S + 30 + Math.floor(r() * 40) : -1,
    stormStart: r() < 0.5 ? Math.floor(r() * 2.5 * CFG.S) : -1,
    stormLen: 4 + Math.floor(r() * 4),
  };
  s.yearStartBees = s.bees();
}

function createState(opt) {
  opt = opt || {};
  const seed = opt.seed != null ? opt.seed : Math.floor(Math.random() * 1e9);
  const s = {
    cfg: CFG, seed, rng: mulberry32(seed),
    year: 1, day: 0,
    jobs: {}, target: Object.assign({}, CFG.startTarget),
    honey: CFG.startHoney, cells: CFG.startCells,
    brood: new Array(CFG.broodDays).fill(CFG.startBroodPerDay),
    eggCarry: 0,
    weather: 'sun', rainStreak: 0, rest: 0,    // rest = 歇工的蜂,不属于任何岗位
    swarmPressure: 0, requeen: 0, swarmCool: 0,
    difficulty: 1.0, peakBees: CFG.startBees,
    threat: null,              // { kind:'hornet'|'rob', scout, needed }
    splits: 0, natSwarms: 0,
    sig: {}, streak: {}, seen: {},
    events: [],                // 当天发生的事(给界面和日志)
    dead: false, winterStartBees: 0,
    history: [],               // 每年结算
    diag: {},
  };
  JOBS.forEach(j => s.jobs[j] = CFG.startBees * s.target[j]);
  attachHelpers(s);
  newYear(s);
  return s;
}

function attachHelpers(s) {
  s.working = () => JOBS.reduce((a, j) => a + s.jobs[j], 0);   // 在岗的蜂
  s.bees = () => s.working() + (s.rest || 0);                   // 全部成蜂(含歇工)
  s.broodTotal = () => s.brood.reduce((a, b) => a + b, 0);
}

// 把歇工的蜂按当前比例派回岗位(玩家看到摇晃信号后的动作)
function reassignRest(s) {
  const n = s.rest || 0;
  if (n < 0.5) return 0;
  JOBS.forEach(j => s.jobs[j] += n * s.target[j]);
  s.rest = 0;
  return n;
}

function setTarget(s, t) {
  const sum = JOBS.reduce((a, j) => a + Math.max(0, t[j] || 0), 0) || 1;
  JOBS.forEach(j => s.target[j] = Math.max(0, t[j] || 0) / sum);
}

function split(s) {
  if (s.bees() < 200 || s.dead) return false;
  const k = 1 - CFG.splitFrac;
  JOBS.forEach(j => s.jobs[j] *= k);
  s.rest *= k;
  s.honey *= 0.9;
  s.swarmPressure = 0; s.swarmCool = CFG.swarmCooldown;
  s.splits++;
  s.events.push({ t: 'split', text: '✂️ 你分出了一群蜂，它们去了新家' });
  return true;
}

// 取蜜:换取奖励的动作,当前只留接口(02 §4)
function harvest(s, amount) {
  const take = Math.min(amount, s.honey);
  s.honey -= take;
  return take;
}

function removeBees(s, n) {
  const tot = s.bees();
  if (tot <= 0 || n <= 0) return;
  const k = Math.max(0, (tot - n) / tot);
  JOBS.forEach(j => s.jobs[j] *= k);
  s.rest *= k;
}

function step(s) {
  if (s.dead) return;
  const r = s.rng, d = s.day, season = seasonOf(d);
  s.events = [];

  // ---------- 天气 ----------
  const prev = s.weather;
  if (s.yr.stormStart >= 0 && d >= s.yr.stormStart && d < s.yr.stormStart + s.yr.stormLen) {
    s.weather = 'rain';
    if (d === s.yr.stormStart) s.events.push({ t: 'event', text: '🌧 连日暴雨开始了' });
  } else if (season !== 'winter') {
    // 60% 概率延续昨天,否则重新抽:晴 60% / 阴 25% / 雨 15%(秋天雨 20%)
    if (r() > 0.6) {
      const pRain = season === 'autumn' ? 0.20 : 0.15, x = r();
      s.weather = x < pRain ? 'rain' : x < pRain + 0.25 ? 'cloud' : 'sun';
    }
  } else s.weather = 'cloud';
  if (s.weather === 'rain') s.rainStreak++;
  else s.rainStreak = 0;
  // 连日下雨:一部分采集蜂歇工
  if (season !== 'winter' && s.rainStreak >= CFG.rainIdleAfter) {
    const n = s.jobs.forage * CFG.rainIdleFrac;
    s.jobs.forage -= n; s.rest += n;
    if (s.rainStreak === CFG.rainIdleAfter) s.events.push({ t: 'event', text: '🌧 连着下雨，采集蜂出不了门，有一批歇工了' });
  }
  // 入冬结团:歇工的蜂自动归队
  if (season === 'winter' && s.rest > 0) reassignRest(s);
  const drought = s.yr.droughtStart >= 0 && d >= s.yr.droughtStart && d < s.yr.droughtStart + 20;
  if (d === s.yr.droughtStart) s.events.push({ t: 'event', text: '☀️ 干旱:花提前枯萎了' });
  const bloom = bloomBase(d, s.yr) * s.yr.bloomMult * (drought ? 0.5 : 1);
  const flow = bloom * WEATHER[s.weather].f;

  // ---------- 改分配逐步生效(只在在岗的蜂之间) ----------
  let total = s.working();
  JOBS.forEach(j => { s.jobs[j] += (s.target[j] * total - s.jobs[j]) * CFG.shiftRate; });

  const J = s.jobs;
  const broodNow = s.broodTotal();
  const fill = clamp((broodNow + s.honey) / s.cells, 0, 1.2);

  // ---------- 采集 → 卸货 → 入库 ----------
  const raw = season === 'winter' ? 0 : J.forage * CFG.nectarPerForager * flow;
  const cap = J.build * CFG.procPerBuilder / (1 + CFG.procFillSlow * fill * fill);
  const W = raw > 0 ? raw / Math.max(0.01, cap) : 0;   // 卸货等待时间的相对量
  let stored = W <= 1 ? raw : cap + (raw - cap) * CFG.overflowKeep;
  const free = Math.max(0, s.cells - broodNow - s.honey);
  stored = Math.min(stored, free);
  s.honey += stored;

  // ---------- 造脾 ----------
  let built = 0;
  if (season !== 'winter') {
    const urge = (flow >= 0.7 && fill >= 0.6) ? 1 : CFG.buildIdleFrac;
    built = J.build * CFG.buildPerBuilder * urge;
    const cost = built * CFG.waxCost;
    if (cost > s.honey) { built *= s.honey / cost; }
    s.honey -= built * CFG.waxCost;
    const layersBefore = Math.ceil(s.cells / CFG.cellsPerLayer);
    s.cells += built;
    if (Math.ceil(s.cells / CFG.cellsPerLayer) > layersBefore)
      s.events.push({ t: 'layer', text: '🧱 筑巢蜂造满了一层，开始造新的一层' });
  }

  // ---------- 育幼 ----------
  const emerged = s.brood.pop();
  const qmax = s.requeen > 0 ? 0 : queenMax(d);
  if (s.requeen > 0) s.requeen--;
  const freeForEggs = Math.max(0, s.cells - broodNow - s.honey);
  const nurseCap = J.nurse * CFG.eggsPerNurse;
  const stores = clamp(s.honey / (s.bees() * 0.4 + 1), 0, 1);   // 存蜜少时蜂王少产卵
  const potential = Math.min(qmax * stores, freeForEggs * 0.5);
  let eggs = Math.min(potential, nurseCap) + s.eggCarry;
  const whole = Math.floor(eggs);
  s.eggCarry = eggs - whole;          // 零头累积(02 §1.9)
  s.brood.unshift(whole);
  if (emerged > 0) {
    JOBS.forEach(j => s.jobs[j] += emerged * s.target[j]);   // 新蜂按当前比例并入(工种继承)
  }

  // ---------- 消耗 ----------
  total = s.bees();
  if (season === 'winter') {
    const weak = total < CFG.weakCluster ? 1 + 0.6 * (CFG.weakCluster - total) / CFG.weakCluster : 1;
    s.honey -= total * CFG.eatWinter * weak;
  } else {
    s.honey -= total * CFG.eatActive + whole * CFG.eggHoneyCost;
  }
  if (s.honey < 0) {
    const starve = Math.min(total * 0.2, -s.honey / CFG.eatActive * 0.3);
    removeBees(s, starve);
    s.honey = 0;
    if (starve > 1) s.events.push({ t: 'bad', text: '🍂 蜜吃光了，有蜂饿死' });
  }

  // ---------- 寿命 ----------
  if (season === 'winter') {
    JOBS.forEach(j => s.jobs[j] *= 1 - CFG.mortWinter);
  } else {
    s.jobs.forage *= 1 - CFG.mortForager;
    ['nurse', 'guard', 'build'].forEach(j => s.jobs[j] *= 1 - CFG.mortInside);
    s.rest *= 1 - CFG.mortInside;
  }

  // ---------- 分蜂压力 ----------
  total = s.bees();
  const occ = (total * 0.75 + s.broodTotal() + s.honey) / s.cells;
  const swarmSeason = d < CFG.S + 45;
  if (s.swarmCool > 0) { s.swarmCool--; s.swarmPressure = 0; }
  else if (swarmSeason && total >= CFG.swarmMinBees && occ > CFG.swarmOcc) s.swarmPressure += 1;
  else s.swarmPressure = Math.max(0, s.swarmPressure - 0.5);
  if (s.swarmPressure >= CFG.swarmMax) {
    removeBees(s, total * CFG.natSwarmLoss);
    s.honey *= 1 - CFG.natSwarmHoneyLoss;
    s.swarmPressure = 0; s.swarmCool = CFG.swarmCooldown; s.requeen = CFG.requeenDays; s.natSwarms++;
    s.events.push({ t: 'bad', text: '🐝💨 蜂群自己分蜂了！老蜂王带着一大半蜂飞走了' });
  }

  // ---------- 威胁 ----------
  total = s.bees();
  const hornetSeason = d >= CFG.S + 40 && d < 2 * CFG.S + 45;
  if (!s.threat) {
    if (hornetSeason && r() < CFG.hornetDailyChance * s.difficulty) {
      s.threat = { kind: 'hornet', scout: 4 + Math.floor(r() * 4),
        needed: Math.max(4, Math.round(total * CFG.hornetGuardFrac * s.difficulty)) };
    } else if (bloom < 0.5 && season !== 'winter' && s.honey > total * 1.5 && r() < CFG.robDailyChance) {
      s.threat = { kind: 'rob', scout: 3 + Math.floor(r() * 3),
        needed: Math.max(4, Math.round(total * CFG.robGuardFrac * s.difficulty)) };
    }
  }
  if (s.threat) {
    const T = s.threat;
    if (T.scout > 0) T.scout--;
    else {
      const g = s.jobs.guard;
      if (T.kind === 'hornet') {
        if (g >= T.needed) {
          const loss = Math.min(g, 2 + r() * 2);
          s.jobs.guard -= loss;
          s.difficulty += CFG.diffGrow;
          s.events.push({ t: 'good', text: `🐝⚔️ 胡蜂来袭，守卫把它围成球焖死了（牺牲 ${Math.round(loss)} 只）` });
        } else {
          const short = (T.needed - g) / T.needed;
          removeBees(s, total * 0.25 * short + 3);
          s.honey *= 1 - 0.3 * short;
          s.difficulty = Math.max(CFG.diffFloor, s.difficulty - CFG.diffRelief);
          s.events.push({ t: 'bad', text: `🐝⚔️ 胡蜂来袭，守卫太少挡不住，蜂群损失惨重` });
        }
      } else {
        const short = clamp((T.needed - g) / T.needed, 0, 1);
        const lost = s.honey * 0.35 * short;
        s.honey -= lost;
        s.events.push({ t: short > 0.2 ? 'bad' : 'good',
          text: short > 0.2 ? `🐝 盗蜂闯进来，抢走了 ${Math.round(lost)} 格蜜` : '🐝 盗蜂被守卫赶走了' });
      }
      s.threat = null;
    }
  }

  // ---------- 信号(02 §9) ----------
  const sig = {};
  sig.waggle = (season !== 'winter' && flow >= 0.8 && W < 0.9)
    ? clamp((flow - 0.6) * (1 - W) * 1.4, 0, 1) : 0;
  sig.tremble = W > 1.12 ? clamp((W - 1) * 0.9, 0, 1) : 0;
  sig.shake = (season !== 'winter' && s.weather !== 'rain' && s.rest >= 1)
    ? clamp(0.3 + s.rest / Math.max(1, s.bees()) * 3, 0, 1) : 0;
  sig.guard = s.threat
    ? (s.jobs.guard < s.threat.needed ? clamp(0.35 + (s.threat.needed - s.jobs.guard) / s.threat.needed, 0, 1) : 0.12)
    : 0;
  sig.nurse = (potential > 2 && nurseCap < potential * 0.7) ? clamp(1 - nurseCap / potential, 0, 1) : 0;
  sig.idle = s.swarmPressure >= 3 ? clamp(s.swarmPressure / CFG.swarmMax, 0, 1) : 0;
  s.sig = sig;
  Object.keys(sig).forEach(k => {
    s.streak[k] = sig[k] >= CFG.sigThresh ? (s.streak[k] || 0) + 1 : 0;
    if (sig[k] >= CFG.sigThresh && !s.seen[k]) { s.seen[k] = s.year * 1000 + d; s.events.push({ t: 'firstsig', sig: k }); }
  });

  s.diag = { bloom, flow, raw, cap, W, stored, built, eggs: whole, fill, occ, nurseCap, potential,
             swarm: s.swarmPressure, threat: s.threat ? s.threat.kind : null };

  // ---------- 日历 ----------
  s.peakBees = Math.max(s.peakBees, s.bees());
  if (d === 3 * CFG.S) s.winterStartBees = s.bees();
  if (s.bees() < CFG.minColony) {
    s.dead = true;
    s.events.push({ t: 'dead', text: '💀 蜂群崩溃了' });
    return;
  }
  s.day++;
  if (s.day >= yearLen()) {
    const survivedBees = s.bees();
    const ratio = s.winterStartBees > 0 ? survivedBees / s.winterStartBees : 1;
    s.history.push({ year: s.year, bees: survivedBees, winterStart: s.winterStartBees, honey: s.honey,
                     splits: s.splits, natSwarms: s.natSwarms });
    if (survivedBees >= s.peakBees * 0.95) s.difficulty += CFG.diffGrow;
    else if (ratio < 0.67) s.difficulty = Math.max(CFG.diffFloor, s.difficulty - CFG.diffRelief);
    s.year++; s.day = 0;
    newYear(s);
    s.events.push({ t: 'newyear', text: `🌸 第 ${s.year} 年开春了（${s.yr.bloomLabel}）` });
  }
}

function snapshot(s) {
  const c = JSON.parse(JSON.stringify(Object.assign({}, s, { rng: null, bees: null, working: null, broodTotal: null, cfg: null })));
  c._rngState = null;
  return c;
}
function restore(snap, seedOffset) {
  const s = JSON.parse(JSON.stringify(snap));
  s.cfg = CFG;
  s.rng = mulberry32((snap.seed || 1) + (seedOffset || 0) * 7919);
  if (s.rest == null) s.rest = 0;
  attachHelpers(s);
  return s;
}

const API = { CFG, JOBS, WEATHER, createState, step, setTarget, split, harvest, reassignRest, seasonOf, yearLen,
              bloomBase, snapshot, restore };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.BeeSim = API;
})(this);
