/** UI state: where the operator is in the Site › Pen › Cell › Finding hierarchy, the time and the active layer. */
import { CELLS, DAYS, TODAY, type Finding, type FindingStatus, type LayerId, type World } from '../data/model';
import { MAP_LAYERS } from './layers';

export type Review = 'confirmed' | 'rejected';
export type PenViewMode = '3d' | 'unrolled';

export interface UiState {
  penIndex: number | null;
  cell: number | null;
  findingId: number | null;
  /** Selected swarm drone, shown in the side panel. */
  droneId: string | null;
  day: number;
  layer: LayerId;
  playing: boolean;
  view: PenViewMode;
  /** Operator decisions made in this session (review of unreviewed findings). */
  reviews: Record<number, Review>;
}

export const initialState: UiState = {
  penIndex: null,
  cell: null,
  findingId: null,
  droneId: null,
  day: TODAY,
  layer: 'risk',
  playing: false,
  view: '3d',
  reviews: {},
};

export type Action =
  | { type: 'site' }
  | { type: 'pen'; penIndex: number }
  | { type: 'cell'; penIndex: number; cell: number | null }
  | { type: 'finding'; penIndex: number; cell: number; findingId: number }
  | { type: 'up' }
  | { type: 'drone'; id: string | null }
  | { type: 'day'; day: number }
  | { type: 'layer'; layer: LayerId }
  | { type: 'play'; playing: boolean }
  | { type: 'view'; view: PenViewMode }
  | { type: 'review'; findingId: number; review: Review }
  | { type: 'restore'; location: ViewLocation };

/** The part of the state that lives in the URL, so reload, sharing and Back keep the view. */
export interface ViewLocation {
  penIndex: number | null;
  cell: number | null;
  findingId: number | null;
  day: number;
  layer: LayerId;
}

export function toHash(s: ViewLocation): string {
  const p = new URLSearchParams();
  if (s.penIndex !== null) p.set('pen', String(s.penIndex + 1));
  if (s.cell !== null) p.set('cell', String(s.cell));
  if (s.findingId !== null) p.set('finding', String(s.findingId));
  if (s.day !== TODAY) p.set('day', String(s.day));
  if (s.layer !== 'risk') p.set('layer', s.layer);
  const q = p.toString();
  return q ? `#${q}` : '';
}

/** Parses a hash written by toHash; anything invalid falls back to the default view. */
export function fromHash(hash: string, penCount: number): ViewLocation {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const int = (k: string, min: number, max: number): number | null => {
    const v = Number(p.get(k));
    return p.has(k) && Number.isInteger(v) && v >= min && v <= max ? v : null;
  };
  const pen = int('pen', 1, penCount);
  const layer = MAP_LAYERS.find((id) => id === p.get('layer')) ?? 'risk';
  return {
    penIndex: pen === null ? null : pen - 1,
    cell: pen === null ? null : int('cell', 0, CELLS - 1),
    findingId: pen === null ? null : int('finding', 0, 1e6),
    day: int('day', 0, DAYS - 1) ?? TODAY,
    layer,
  };
}

const clampDay = (d: number): number => Math.max(0, Math.min(DAYS - 1, d));

export function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'site':
      return { ...state, penIndex: null, cell: null, findingId: null, droneId: null };
    case 'pen':
      return { ...state, penIndex: action.penIndex, cell: null, findingId: null, droneId: null };
    case 'cell':
      return { ...state, penIndex: action.penIndex, cell: action.cell, findingId: null, droneId: null };
    case 'finding':
      return { ...state, penIndex: action.penIndex, cell: action.cell, findingId: action.findingId, droneId: null };
    case 'drone':
      return { ...state, droneId: action.id };
    case 'up':
      if (state.droneId !== null) return { ...state, droneId: null };
      if (state.findingId !== null) return { ...state, findingId: null };
      if (state.cell !== null) return { ...state, cell: null };
      return { ...state, penIndex: null };
    case 'day':
      // Replay stops when it reaches "now".
      return { ...state, day: clampDay(action.day), playing: state.playing && action.day < TODAY };
    case 'layer':
      return { ...state, layer: action.layer };
    case 'play':
      return { ...state, playing: action.playing, day: action.playing && state.day >= TODAY ? 0 : state.day };
    case 'view':
      return { ...state, view: action.view };
    case 'review':
      return { ...state, reviews: { ...state.reviews, [action.findingId]: action.review } };
    case 'restore':
      return { ...state, ...action.location, playing: false };
  }
}

const CLOSED: FindingStatus[] = ['verified', 'rejected'];

/** Status of a finding as known on `day`, including the operator's review from this session. */
export function statusAt(f: Finding, day: number, reviews: Record<number, Review>): FindingStatus {
  let status: FindingStatus = 'unreviewed';
  for (const s of f.steps) if (s.day <= day) status = s.status;
  const review = reviews[f.id];
  if (status === 'unreviewed' && review && day >= TODAY) return review;
  return status;
}

/**
 * A hole finding is treated as a hole (pin, urgent alert, drawn opening) once someone has confirmed
 * it. Before that it is a possible opening that needs a second look.
 */
export function isConfirmedHole(f: Finding, day: number, reviews: Record<number, Review>): boolean {
  return f.kind === 'hole' && statusAt(f, day, reviews) !== 'unreviewed';
}

export function isOpen(f: Finding, day: number, reviews: Record<number, Review>): boolean {
  return f.detectedDay <= day && !CLOSED.includes(statusAt(f, day, reviews));
}

export function openFindings(world: World, day: number, reviews: Record<number, Review>, penId?: number): Finding[] {
  return world.findings.filter((f) => (penId === undefined || f.penId === penId) && isOpen(f, day, reviews));
}
