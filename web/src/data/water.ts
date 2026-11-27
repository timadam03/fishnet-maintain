/**
 * Water conditions per net cell: dissolved oxygen (% saturation) and temperature (°C).
 *
 * In the real system these come from fixed sensors at a few depths plus drone readings,
 * interpolated into a 3D map. Here they are computed on demand from simple rules:
 * oxygen falls with depth and on the downstream side of the pen (water loses oxygen as it
 * crosses the fish), more so in weak current; crowding during delousing causes a drop.
 * In late autumn the surface cools first, so deeper water ends up warmer.
 */
import { DAYS, DELOUSING_DAY, DELOUSING_PEN_IDS, WALL_ROWS, cellCol, cellRow, rowDepth, type World } from './model';
import { facing } from './simulate';
import { hashNoise } from './rng';

export interface Water {
  oxygen: number;
  temperature: number;
}

/** Fixed sensor depths on each pen's sensor string. */
export const SENSOR_DEPTHS = [1, 5, 10, 15, 20];

/** Data-trust demo: Pen 7's 15 m oxygen sensor froze on this day and has sent the same value since. */
export const FROZEN_SENSOR = { penId: 7, depth: 15, sinceDay: 85 };

function oxygenAt(world: World, penId: number, depth: number, downstream: number, day: number, jitter: number): number {
  const speed = world.env.currentSpeed[day];
  const weakCurrent = 1 - Math.min(1, speed / 30);
  let o2 = 98 - 0.75 * depth - downstream * (6 + 14 * weakCurrent) + (jitter - 0.5) * 3;
  // Crowding for delousing drops oxygen sharply.
  if (DELOUSING_PEN_IDS.includes(penId)) {
    if (day === DELOUSING_DAY) o2 -= 24;
    if (day === DELOUSING_DAY + 1) o2 -= 9;
  }
  return Math.max(35, Math.min(110, o2));
}

function temperatureAt(world: World, depth: number, day: number, jitter: number): number {
  const autumn = day / DAYS; // 0 = late August, 1 = early December
  const gradient = -0.09 * (1 - autumn) + 0.07 * autumn; // summer stratified, autumn inverted
  return world.env.surfaceTemp[day] + gradient * depth + (jitter - 0.5) * 0.3;
}

export function waterAt(world: World, penId: number, cell: number, day: number): Water {
  const row = cellRow(cell);
  const [d0, d1] = rowDepth(row);
  const depth = (d0 + d1) / 2;
  // 1 on the side the current leaves the pen, 0 on the side it enters.
  const downstream = row < WALL_ROWS ? 1 - facing(cellCol(cell), world.env.currentDir[day]) : 0.5;
  const jitter = hashNoise(penId, cell, day);
  return {
    oxygen: oxygenAt(world, penId, depth, downstream, day, jitter),
    temperature: temperatureAt(world, depth, day, hashNoise(cell, day, penId)),
  };
}

/**
 * Water inside the pen at a depth and a horizontal position (x east, y north, both −1..1 of the
 * pen radius). Smooth, without the per-cell jitter, for slices and depth-over-time charts.
 */
export function waterAtPoint(world: World, penId: number, depth: number, x: number, y: number, day: number): Water {
  const a = (world.env.currentDir[day] * Math.PI) / 180;
  // Position along the flow: −1 where water enters the pen, +1 where it leaves.
  const along = x * Math.sin(a) + y * Math.cos(a);
  const downstream = Math.max(0, Math.min(1, (along + 1) / 2));
  return {
    oxygen: oxygenAt(world, penId, depth, downstream, day, 0.5),
    temperature: temperatureAt(world, depth, day, 0.5),
  };
}

export interface SensorReading {
  depth: number;
  oxygen: number;
  temperature: number;
  /** Day of the reading shown; earlier than `day` when the sensor is frozen. */
  readingDay: number;
  stale: boolean;
}

/** The pen's sensor string (mid-pen, average of upstream and downstream sides). */
export function sensorProfile(world: World, penId: number, day: number): SensorReading[] {
  return SENSOR_DEPTHS.map((depth) => {
    const frozen = penId === FROZEN_SENSOR.penId && depth === FROZEN_SENSOR.depth && day > FROZEN_SENSOR.sinceDay;
    const readingDay = frozen ? FROZEN_SENSOR.sinceDay : day;
    const jitter = hashNoise(penId * 31 + depth, readingDay, 3);
    return {
      depth,
      oxygen: oxygenAt(world, penId, depth, 0.5, readingDay, jitter),
      temperature: temperatureAt(world, depth, readingDay, jitter),
      readingDay,
      stale: frozen,
    };
  });
}
