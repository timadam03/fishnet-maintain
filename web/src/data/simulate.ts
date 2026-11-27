/**
 * Synthetic demo world: one Nordic site with eight pens, 90 days of history and a 7-day forecast.
 *
 * Each pen's net is simulated cell by cell with simple, hand-tuned wear physics taken from the
 * preventive-damage concept: contact with the weight system, cleaning passes, current load and
 * fouling drag wear the netting until a twine breaks. Nothing here is calibrated against real
 * farms; it exists so the UI can show the concepts with plausible-looking data.
 *
 * Inspection is done by a resident swarm that revisits every cell every few days and prioritises
 * risky and stale cells ("sample more"). Findings lead to repairs, which change how the net wears.
 */
import {
  ANGLE_SECTORS,
  CELLS,
  DAYS,
  DELOUSING_DAY,
  DELOUSING_PEN_IDS,
  STORM_FORECAST_DAY,
  STORM_PAST_DAY,
  ROWS,
  SECTOR_DEG,
  TODAY,
  WALL_ROWS,
  cellCol,
  cellIndex,
  cellRow,
  type Finding,
  type FindingKind,
  type FindingStep,
  type Operation,
  type Pen,
  type PenSim,
  type SiteEnv,
  type World,
} from './model';
import { mulberry32 } from './rng';

const FRAY_FINDING = 0.5;
const DISTORTION_FINDING = 0.45;
const SWARM_CELLS_PER_DAY = 66; // a quarter of each net per day
/** Scripted for the demo: a seal bite yesterday leaves a hole that is still open today. */
const PREDATOR_BITE = { penId: 2, day: TODAY - 1, cell: cellIndex(2, 17) };
const PEN4_RERIG_DAY = 35;
export const CONE_DRONE_DOCKED_DAY = 70;
const PEN7_SAG_CELL = cellIndex(WALL_ROWS - 1, 20);

/**
 * Scripted problem areas, so every case shows up somewhere on the site:
 * - `fouling`: a patch where growth is faster and the cleaner misses part of it (a mooring rope or
 *   a seam in the way). Heavy fouling adds drag and can hide damage.
 * - `thin`: twine worn thin, just below the level where the vision model flags it. Only the risk
 *   map shows it, which is the point of prevention.
 * - `openings`: small openings in the mesh. `confirmed` ones are reviewed and sent to the service
 *   crew; the others are "possible openings" seen once and waiting for a second look.
 * Findings from these get ids after the regular ones (#209 on), so earlier finding ids stay fixed.
 */
interface Seeds {
  fouling?: Array<{ row: number; col: number; size: number }>;
  thin?: Array<{ row: number; col: number; fray: number }>;
  openings?: Array<{ row: number; col: number; confidence: number; confirmed: boolean }>;
}
const SEEDS: Record<number, Seeds> = {
  1: { fouling: [{ row: 2, col: 4, size: 2.2 }], thin: [{ row: 6, col: 15, fray: 0.46 }], openings: [{ row: 5, col: 9, confidence: 0.91, confirmed: true }] },
  2: { fouling: [{ row: 5, col: 4, size: 1.6 }] },
  3: { thin: [{ row: 4, col: 9, fray: 0.47 }] },
  4: { fouling: [{ row: 1, col: 13, size: 1.8 }] },
  5: { openings: [{ row: 3, col: 14, confidence: 0.55, confirmed: false }], thin: [{ row: 3, col: 12, fray: 0.44 }] },
  6: { openings: [{ row: 5, col: 7, confidence: 0.76, confirmed: false }], fouling: [{ row: 2, col: 20, size: 2 }] },
  8: { fouling: [{ row: 6, col: 10, size: 2.4 }], thin: [{ row: 2, col: 1, fray: 0.45 }, { row: 3, col: 1, fray: 0.42 }] },
};
/**
 * Both start after the last regular finding (day 84), so the history before them is unchanged:
 * thin spots wear in over the last four days, openings appear overnight and are found this morning.
 */
const THIN_FROM_DAY = TODAY - 4;
const OPENING_DAY = TODAY;

/** 0..1 weight of a cell inside a patch centred on (row, col), wrapping around the pen. */
function patchWeight(c: number, row: number, col: number, size: number): number {
  const dc = Math.min(Math.abs(cellCol(c) - col), ANGLE_SECTORS - Math.abs(cellCol(c) - col));
  const dr = cellRow(c) - row;
  return Math.exp(-(dc * dc + dr * dr * 1.6) / (size * size));
}

function makePens(): Pen[] {
  const base = [
    { age: 300, fish: 168_000, every: 12, passes: 1 },
    { age: 200, fish: 172_000, every: 12, passes: 1 },
    { age: 420, fish: 151_000, every: 12, passes: 1 },
    { age: 380, fish: 160_000, every: 12, passes: 1 },
    { age: 250, fish: 175_000, every: 7, passes: 2 }, // aggressive cleaning regime
    { age: 59, fish: 158_000, every: 12, passes: 1 }, // net changed during the shown period
    { age: 520, fish: 144_000, every: 14, passes: 1 }, // oldest net
    { age: 150, fish: 170_000, every: 12, passes: 1 },
  ];
  return base.map((b, i) => {
    const id = i + 1;
    const row = i < 4 ? 0 : 1;
    const col = i % 4;
    return {
      id,
      name: `Pen ${id}`,
      x: 230 + col * 120 + row * 40,
      y: 150 + row * 125,
      netId: `NET-${2025 + (b.age < 200 ? 1 : 0)}-${String(40 + id * 7).padStart(3, '0')}`,
      netInstalledDay: TODAY - b.age,
      material: id === 7 ? 'Nylon, copper coating' : 'Nylon, copper-free coating',
      fishCount: b.fish,
      boatSideAngle: row === 0 ? 180 : 0,
      cleaningEvery: b.every,
      cleaningOffset: (id * 3) % b.every,
      passesPerCleaning: b.passes,
    };
  });
}

const bump = (day: number, centre: number, width: number): number =>
  Math.exp(-((day - centre) ** 2) / (2 * width * width));

function makeEnv(rnd: () => number): SiteEnv {
  const currentSpeed = new Float32Array(DAYS);
  const currentDir = new Float32Array(DAYS);
  const waveHeight = new Float32Array(DAYS);
  const surfaceTemp = new Float32Array(DAYS);
  for (let d = 0; d < DAYS; d++) {
    const stormPast = bump(d, STORM_PAST_DAY, 1.4);
    const stormForecast = bump(d, STORM_FORECAST_DAY, 1.2);
    const storm = Math.max(stormPast, stormForecast);
    currentSpeed[d] = 13 + 5 * Math.sin((2 * Math.PI * d) / 14.8) + rnd() * 3 + 38 * stormPast + 44 * stormForecast;
    currentDir[d] = (45 + 25 * Math.sin((2 * Math.PI * d) / 6.2) + rnd() * 8 - 25 * stormForecast + 360) % 360;
    waveHeight[d] = 0.5 + rnd() * 0.4 + 3.2 * storm;
    surfaceTemp[d] = 13.8 - (5.6 * d) / DAYS + (rnd() - 0.5) * 0.4;
  }
  return { currentSpeed, currentDir, waveHeight, surfaceTemp };
}

/** Typical contact hours per day at nominal load, by where the weight system touches the net. */
function contactBase(penId: number, row: number, col: number, day: number): number {
  let hours = 0;
  const chainCol = col % 3 === 0; // sinker-tube chains every 45°
  if (row === WALL_ROWS - 1) hours += chainCol ? 0.22 : 0.04;
  if (row === WALL_ROWS) hours += chainCol ? 0.32 : 0.08;
  // Pen 4: after re-rigging on day 35, a weight rope sits too close to the net at ~135°.
  if (penId === 4 && day >= PEN4_RERIG_DAY && col === 9 && (row === 4 || row === 5)) hours += row === 4 ? 4 : 2.4;
  if (penId === 4 && day >= PEN4_RERIG_DAY && col === 10 && row === 4) hours += 1.2;
  // Pen 7: since day 80 the old net sags onto the sinker tube on one side (emerging risk, little damage yet).
  if (isPen7Sag(penId, row, col) && day >= 80) hours += col === 20 ? 8.5 : 5;
  return hours;
}

/** The sagging net rests on the tube rather than sawing on a chain, so it wears more slowly per contact hour. */
const isPen7Sag = (penId: number, row: number, col: number): boolean => penId === 7 && row === WALL_ROWS - 1 && (col === 20 || col === 21);
const contactWearFactor = (penId: number, row: number, col: number): number => (isPen7Sag(penId, row, col) ? 0.35 : 1);

const FISH_DENSITY = [0.5, 0.7, 0.9, 1, 1, 0.9, 0.75, 0.6];
export const fishDensity = (row: number): number => (row < WALL_ROWS ? FISH_DENSITY[row] : 0.4);

const angleDiff = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
};

/** How directly a cell faces the incoming current (1 = head-on, 0 = sheltered side). */
export function facing(col: number, currentDirDeg: number): number {
  const upstream = (currentDirDeg + 180) % 360;
  const centre = col * SECTOR_DEG + SECTOR_DEG / 2;
  return Math.max(0, Math.cos((angleDiff(centre, upstream) * Math.PI) / 180));
}

function allocSim(): PenSim {
  const n = DAYS * CELLS;
  return {
    coating: new Float32Array(n),
    fray: new Float32Array(n),
    distortion: new Float32Array(n),
    repairs: new Uint8Array(n),
    fouling: new Float32Array(n),
    load: new Float32Array(n),
    contactCum: new Float32Array((DAYS + 1) * CELLS),
    cleaningCum: new Float32Array((DAYS + 1) * CELLS),
    holeOpen: new Uint8Array(n),
    lastSeen: new Int16Array(n),
  };
}

interface Repair {
  cells: number[];
  weightFix: boolean;
}

function simulatePen(pen: Pen, env: SiteEnv, seed: number, findings: Finding[], seededFindings: Finding[]): PenSim {
  const sim = allocSim();
  // Separate stream for the scripted problem areas, so they don't shift the regular findings.
  const seedRng = mulberry32(seed * 733 + pen.id * 17);
  const seeds = SEEDS[pen.id] ?? {};
  const foulGrowth = new Float32Array(CELLS).fill(1);
  const cleanerMiss = new Float32Array(CELLS);
  const thinTarget = new Float32Array(CELLS);
  for (let c = 0; c < CELLS; c++) {
    for (const f of seeds.fouling ?? []) {
      const w = patchWeight(c, f.row, f.col, f.size);
      foulGrowth[c] += 2.5 * w;
      cleanerMiss[c] = Math.max(cleanerMiss[c], w);
    }
    for (const t of seeds.thin ?? []) {
      // The spot itself plus a weaker rim on its direct neighbours.
      const w = cellRow(c) === t.row && cellCol(c) === t.col ? 1 : 0.8 * patchWeight(c, t.row, t.col, 1);
      if (w >= 0.25) thinTarget[c] = Math.max(thinTarget[c], t.fray * w);
    }
  }
  const init = mulberry32(seed * 131 + pen.id);
  const insp = mulberry32(seed * 977 + pen.id * 7);
  const fp = mulberry32(seed * 409 + pen.id * 13);

  const coat = new Float32Array(CELLS);
  const fray = new Float32Array(CELLS);
  const dist = new Float32Array(CELLS);
  const foul = new Float32Array(CELLS);
  const reps = new Uint8Array(CELLS);
  const hole = new Uint8Array(CELLS);
  const contactMult = new Float32Array(CELLS).fill(1);
  const lastSeen = new Int16Array(CELLS);
  const openFinding = new Int32Array(CELLS).fill(-1);
  const repairsDue = new Map<number, Repair[]>();

  const resetNet = (ageDays: number): void => {
    for (let c = 0; c < CELLS; c++) {
      const row = cellRow(c);
      const ageWear = Math.min(1, ageDays / 600);
      coat[c] = Math.min(1, 0.05 + 0.4 * ageWear + init() * 0.1);
      fray[c] = Math.min(0.4, 0.02 + 0.18 * ageWear + init() * 0.08);
      dist[c] = 0.02 + init() * 0.06;
      foul[c] = 0.05 + init() * 0.1;
      reps[c] = 0;
      hole[c] = 0;
      lastSeen[c] = row < 6 ? 0 : -1;
    }
    // Old nets carry repairs from earlier cycles; patch edges are weak points.
    const oldRepairs = Math.floor(ageDays / 120);
    for (let i = 0; i < oldRepairs; i++) {
      const c = Math.floor(init() * CELLS);
      reps[c] = 1;
      fray[c] = Math.min(0.45, fray[c] + 0.12);
    }
  };

  const startAge = Math.max(0, -pen.netInstalledDay);
  resetNet(pen.netInstalledDay > 0 ? 240 : startAge);

  const contact30 = (day: number, c: number): number => {
    const hi = (day + 1) * CELLS + c;
    const lo = Math.max(0, day - 29) * CELLS + c;
    return sim.contactCum[hi] - sim.contactCum[lo];
  };

  const addFinding = (day: number, c: number, kind: FindingKind, confidence: number, falseAlarm: boolean, scripted?: { confirmed: boolean }): void => {
    const steps: FindingStep[] = [{ day, status: 'unreviewed', note: kind === 'hole' ? 'Hole flagged by vision model' : 'Wear sign flagged by vision model' }];
    const severity = kind === 'hole' && (!scripted || scripted.confirmed) ? 'critical' : 'warning';
    const finding: Finding = {
      id: 0, // assigned in time order once all pens are simulated
      penId: pen.id,
      cell: c,
      kind,
      side: (scripted ? seedRng() : fp()) < 0.8 ? 'outside' : 'inside',
      detectedDay: day,
      openedDay: kind === 'hole' ? openedDayFor(c, day) : undefined,
      confidence,
      severity,
      steps,
    };
    openFinding[c] = (scripted ? seededFindings : findings).push(finding) - 1;
    // A possible opening seen once waits for a second look before anyone acts on it.
    if (scripted && !scripted.confirmed) return;
    // Holes are urgent: confirmed and sent to the service crew the same day.
    const urgent = kind === 'hole';
    // Other recent findings stay unreviewed so the operator can act on them in the demo.
    if (!urgent && day >= TODAY - 1) return;
    if (falseAlarm) {
      steps.push({ day: day + 1, status: 'rejected', note: 'Rejected on review: fouling shadow, not damage' });
      openFinding[c] = -1;
      return;
    }
    const fixDay = day + (kind === 'hole' ? 2 : kind === 'distortion' ? 4 : 3);
    const reviewDay = urgent ? day : day + 1;
    const repairNote =
      kind === 'hole' ? 'Hole closed by service crew' : kind === 'chafe' ? 'Patched and weight rope re-rigged' : kind === 'distortion' ? 'Area reinforced' : 'Worn twine replaced';
    steps.push({ day: reviewDay, status: 'confirmed', note: 'Confirmed by site operator' });
    steps.push({ day: reviewDay, status: 'work-order', note: urgent ? 'Urgent work order to service crew, due in 2 days' : 'Work order planned' });
    if (fixDay <= TODAY) {
      steps.push({ day: fixDay, status: 'repaired', note: repairNote });
      const list = repairsDue.get(fixDay) ?? [];
      list.push({ cells: [c], weightFix: kind === 'chafe' });
      repairsDue.set(fixDay, list);
      if (fixDay + 1 <= TODAY) steps.push({ day: fixDay + 1, status: 'verified', note: 'Re-inspected and verified' });
    }
  };

  const holeOpenedDay = new Int16Array(CELLS).fill(-1);
  const openedDayFor = (c: number, day: number): number => (holeOpenedDay[c] >= 0 ? holeOpenedDay[c] : day);

  /** A repair patches the flagged cell plus worn neighbours around it. */
  const patchArea = (c: number): number[] => {
    const out = [c];
    for (const n of neighbours(c)) if (fray[n] > 0.35 || hole[n]) out.push(n);
    return out;
  };

  const hasOpenNear = (c: number): boolean => openFinding[c] >= 0 || neighbours(c).some((n) => openFinding[n] >= 0);


  for (let day = 0; day < DAYS; day++) {
    const isHistory = day <= TODAY;

    if (day === pen.netInstalledDay) {
      resetNet(0);
      for (let c = 0; c < CELLS; c++) {
        lastSeen[c] = day;
        openFinding[c] = -1;
        holeOpenedDay[c] = -1;
      }
    }

    for (const rep of repairsDue.get(day) ?? []) {
      for (const c of patchArea(rep.cells[0])) {
        fray[c] = 0.05;
        coat[c] = 0.2;
        dist[c] = 0.05;
        hole[c] = 0;
        holeOpenedDay[c] = -1;
        reps[c] = Math.min(255, reps[c] + 1);
        openFinding[c] = -1;
        lastSeen[c] = day; // the crew sees the area they repair
        if (rep.weightFix) {
          const r = cellRow(c);
          const col = cellCol(c);
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              if (rr < 0 || rr >= ROWS) continue;
              contactMult[cellIndex(rr, (col + dc + ANGLE_SECTORS) % ANGLE_SECTORS)] *= 0.25;
            }
          }
        }
      }
    }

    const speed = env.currentSpeed[day];
    const dir = env.currentDir[day];
    const temp = env.surfaceTemp[day];
    const cleaningToday = day % pen.cleaningEvery === pen.cleaningOffset;
    const base = day * CELLS;

    for (let c = 0; c < CELLS; c++) {
      const row = cellRow(c);
      const col = cellCol(c);
      const face = facing(col, dir);

      foul[c] += 0.022 * foulGrowth[c] * (temp / 10) * (1 - (0.75 * row) / ROWS) * (1 - foul[c]);
      let passes = 0;
      if (cleaningToday && row < WALL_ROWS) {
        passes = pen.passesPerCleaning + (face > 0.6 ? 1 : 0);
        foul[c] *= 0.2 + 0.7 * cleanerMiss[c];
      }

      const depthShelter = row < WALL_ROWS ? 1 - row * 0.04 : 0.6;
      const load = Math.min(3, (speed / 22) ** 2 * (0.12 + 0.88 * face) * (1 + 2 * foul[c]) * depthShelter);
      const contact = Math.min(24, contactBase(pen.id, row, col, day) * contactMult[c] * (0.4 + 0.8 * Math.min(load, 2.5)));

      coat[c] = Math.min(1, coat[c] + 0.015 * passes + 0.002 * contact);
      fray[c] = Math.min(1, fray[c] + 0.0085 * contact * contactWearFactor(pen.id, row, col) * (0.6 + coat[c]) + 0.004 * passes + 0.006 * Math.max(0, load - 1.3) + 0.0003);
      dist[c] = Math.min(1, Math.max(0, dist[c] + 0.012 * Math.max(0, load - 0.9) * (0.3 + fray[c]) - 0.0015));

      if (thinTarget[c] > 0 && day >= THIN_FROM_DAY && day <= TODAY) {
        // Thinning comes with worn coating and a slightly stretched mesh.
        const k = (thinTarget[c] / 0.47) * Math.min(1, (day - THIN_FROM_DAY + 1) / (TODAY - THIN_FROM_DAY + 1));
        fray[c] = Math.max(fray[c], 0.47 * k);
        coat[c] = Math.max(coat[c], 0.7 * k);
        dist[c] = Math.max(dist[c], 0.3 * k);
        if (day === TODAY) lastSeen[c] = day; // this morning's sweep filmed it
      }

      if (fray[c] >= 1 && !hole[c]) {
        hole[c] = 1;
        holeOpenedDay[c] = day;
      }

      sim.coating[base + c] = coat[c];
      sim.fray[base + c] = fray[c];
      sim.distortion[base + c] = dist[c];
      sim.repairs[base + c] = reps[c];
      sim.fouling[base + c] = foul[c];
      sim.load[base + c] = load;
      sim.contactCum[(day + 1) * CELLS + c] = sim.contactCum[day * CELLS + c] + contact;
      sim.cleaningCum[(day + 1) * CELLS + c] = sim.cleaningCum[day * CELLS + c] + passes;
    }

    // Sudden damage (predator bite) cannot be predicted from wear; it still needs frequent checks.
    if (pen.id === PREDATOR_BITE.penId && day === PREDATOR_BITE.day) {
      const c = PREDATOR_BITE.cell;
      fray[c] = 1;
      hole[c] = 1;
      holeOpenedDay[c] = day;
      sim.fray[base + c] = 1;
      // A drone filming that side the same evening catches it.
      lastSeen[c] = day;
      addFinding(day, c, 'hole', 0.94, false);
    }
    if (day === OPENING_DAY) {
      for (const o of seeds.openings ?? []) {
        const c = cellIndex(o.row, o.col);
        fray[c] = 1;
        hole[c] = 1;
        holeOpenedDay[c] = day;
        sim.fray[base + c] = 1;
      }
    }
    if (day === OPENING_DAY) {
      for (const o of seeds.openings ?? []) {
        const c = cellIndex(o.row, o.col);
        lastSeen[c] = day;
        addFinding(day, c, 'hole', o.confidence, false, { confirmed: o.confirmed });
      }
    }
    for (let c = 0; c < CELLS; c++) sim.holeOpen[base + c] = hole[c];

    if (isHistory) {
      // Scripted for the demo: this morning the vision model flagged early wear where Pen 7 sags onto the sinker tube.
      if (pen.id === 7 && day === TODAY && openFinding[PEN7_SAG_CELL] < 0) {
        lastSeen[PEN7_SAG_CELL] = day;
        addFinding(day, PEN7_SAG_CELL, 'fraying', 0.64, false);
      }
      const seen = swarmPlan(day);
      for (const c of seen) {
        lastSeen[c] = day;
        if (hole[c] && openFinding[c] < 0) {
          addFinding(day, c, 'hole', 0.86 + fp() * 0.12, false);
        } else if (!hasOpenNear(c)) {
          if (fray[c] >= FRAY_FINDING) {
            addFinding(day, c, contact30(day, c) > 20 ? 'chafe' : 'fraying', 0.7 + fp() * 0.25, false);
            // Looking closely at a worn area also reveals a hole right next to it.
            for (const n of neighbours(c)) {
              if (hole[n] && openFinding[n] < 0) {
                lastSeen[n] = day;
                addFinding(day, n, 'hole', 0.9 + fp() * 0.08, false);
              }
            }
          } else if (dist[c] >= DISTORTION_FINDING) {
            addFinding(day, c, 'distortion', 0.62 + fp() * 0.25, false);
          } else if (fray[c] > 0.3 && fp() < 0.004) {
            addFinding(day, c, 'fraying', 0.42 + fp() * 0.18, true);
          }
        }
      }
    }
    sim.lastSeen.set(lastSeen, base);
  }
  return sim;

  /** Resident swarm: visit the cells where staleness × estimated risk is highest ("sample more"). */
  function swarmPlan(day: number): number[] {
    const scored: Array<[number, number]> = [];
    for (let c = 0; c < CELLS; c++) {
      // Data-trust demo: the drone that films Pen 8's bottom cone has been docked for repair since day 70.
      if (pen.id === 8 && day >= CONE_DRONE_DOCKED_DAY && cellRow(c) >= WALL_ROWS) continue;
      const seenDay = lastSeen[c];
      const age = seenDay < 0 ? 60 : day - seenDay;
      const obsFray = seenDay < 0 ? 0.3 : sim.fray[seenDay * CELLS + c];
      const exposure = Math.min(1, contact30(Math.max(0, day - 1), c) / 30);
      scored.push([c, (age + 1) * (0.3 + obsFray + exposure) + insp() * 0.5]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, SWARM_CELLS_PER_DAY).map(([c]) => c);
  }
}

function neighbours(c: number): number[] {
  const r = cellRow(c);
  const col = cellCol(c);
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr;
      if ((dr === 0 && dc === 0) || rr < 0 || rr >= ROWS) continue;
      out.push(cellIndex(rr, (col + dc + ANGLE_SECTORS) % ANGLE_SECTORS));
    }
  }
  return out;
}

function makeOperations(pens: Pen[]): Operation[] {
  const ops: Operation[] = [
    { day: STORM_PAST_DAY, penId: null, kind: 'storm', label: 'Storm: current up to ~55 cm/s' },
    { day: STORM_FORECAST_DAY, penId: null, kind: 'storm', label: 'Forecast storm: current up to ~60 cm/s' },
    ...DELOUSING_PEN_IDS.map((penId): Operation => ({ day: DELOUSING_DAY, penId, kind: 'delousing', label: `Delousing, Pen ${penId}` })),
    { day: DELOUSING_DAY + 1, penId: 3, kind: 'wellboat', label: 'Wellboat alongside, Pen 3' },
  ];
  for (const pen of pens) {
    if (pen.netInstalledDay > 0) ops.push({ day: pen.netInstalledDay, penId: pen.id, kind: 'net-change', label: `Net change, ${pen.name}` });
    for (let d = 0; d <= TODAY; d++) {
      if (d % pen.cleaningEvery === pen.cleaningOffset) ops.push({ day: d, penId: pen.id, kind: 'cleaning', label: `Net cleaning, ${pen.name}` });
    }
  }
  return ops.sort((a, b) => a.day - b.day);
}

export function generateWorld(seed = 7): World {
  const pens = makePens();
  const env = makeEnv(mulberry32(seed));
  const findings: Finding[] = [];
  const seeded: Finding[] = [];
  const sims = pens.map((pen) => simulatePen(pen, env, seed, findings, seeded));
  const order = (a: Finding, b: Finding): number => a.detectedDay - b.detectedDay || a.penId - b.penId || a.cell - b.cell;
  findings.sort(order);
  findings.push(...seeded.sort(order));
  findings.forEach((f, i) => (f.id = 201 + i));
  return { siteName: 'Site A', pens, env, operations: makeOperations(pens), sims, findings };
}
