/**
 * Small JSON API for the operator UI (web/) and for robots or the simulator (missions). Decisions
 * are computed from the shared world; viewing a day records them in the decision log, and what
 * people and robots do (reviews, closures, proposals, mission results) is stored.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { modelStatus, openStore } from './app.ts';
import { runCurator } from './curator.ts';
import { defaultDecisionModel } from './d1.ts';
import { findingById, oxygenEventText, penDecisions, siteAlerts } from './engine.ts';
import { buildPlan, importObservations } from './inspection.ts';
import { ask } from './investigator.ts';
import { logEntries, missions, recordDay, trace, updateMission } from './log.ts';
import { sameFinding, similarEpisodes } from './memory.ts';
import { rulesVersion } from './rules/types.ts';
import { TODAY, dayLabel, world } from './world.ts';

const PORT = Number(process.env.PORT ?? 8787);
const store = openStore();

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const dayParam = (url: URL): number => {
  const raw = url.searchParams.get('day');
  const day = raw === null ? TODAY : Number(raw);
  if (!Number.isInteger(day) || day < 0 || day > 96) throw new HttpError(400, 'day must be an integer 0–96');
  return day;
};

async function body<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}';
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new HttpError(400, parsed.error.message);
  return parsed.data;
}

async function route(req: IncomingMessage, url: URL): Promise<unknown> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const config = store.config();
  const reviews = store.reviews();

  if (method === 'GET' && path === '/api/health') {
    return { ok: true, today: TODAY, todayDate: dayLabel(TODAY), rulesVersion: rulesVersion(config), models: modelStatus() };
  }
  if (method === 'GET' && path === '/api/alerts') {
    const day = dayParam(url);
    // Viewing a day records its decisions, so the log holds what was shown at the time.
    await recordDay(store, day, defaultDecisionModel());
    return siteAlerts(day, config, reviews, store.alertClosures());
  }
  if (method === 'GET' && path === '/api/log') {
    const pen = url.searchParams.get('pen');
    const day = url.searchParams.get('day');
    return logEntries(store, { day: day === null ? undefined : dayParam(url), penId: pen === null ? undefined : Number(pen), entity: url.searchParams.get('entity') ?? undefined });
  }
  if (method === 'GET' && path === '/api/trace') {
    const entity = url.searchParams.get('entity');
    if (!entity || !/^(cell:\d+:\d+|finding:\d+|oxygen:\d+)$/.test(entity)) throw new HttpError(400, 'entity must be cell:<pen>:<cell>, finding:<id> or oxygen:<pen>');
    return trace(store, entity);
  }
  if (method === 'GET' && path === '/api/missions') {
    const status = z.enum(['requested', 'assigned', 'done', 'cancelled']).optional().safeParse(url.searchParams.get('status') ?? undefined);
    if (!status.success) throw new HttpError(400, 'status must be requested, assigned, done or cancelled');
    const pen = url.searchParams.get('pen');
    return missions(store, { status: status.data, penId: pen === null ? undefined : Number(pen) });
  }
  if (method === 'POST' && path === '/api/observations') {
    // Isaac captures + image-pipeline reports (contracts.ts); closes missions whose photos came back.
    const b = await body(req, z.object({
      pen_id: z.number().int(), captures: z.array(z.unknown()).default([]), reports: z.array(z.unknown()),
      cage_radius_m: z.number().positive().optional(), cage_depth_m: z.number().positive().optional(),
      grid: z.object({ ui_sectors: z.number().int(), ui_wall_rows: z.number().int() }).optional().describe('The "grid" object from ground_truth.json'),
    }));
    try {
      return importObservations(store, { penId: b.pen_id, captures: b.captures, reports: b.reports, cageRadiusM: b.cage_radius_m, cageDepthM: b.cage_depth_m, grid: b.grid });
    } catch (error) {
      if (error instanceof z.ZodError || (error instanceof Error && error.message.startsWith('grid mismatch'))) throw new HttpError(400, error.message);
      throw error;
    }
  }
  if (method === 'GET' && path === '/api/plan') {
    const pen = Number(url.searchParams.get('pen') ?? 7);
    if (!world.pens.some((p) => p.id === pen)) throw new HttpError(404, `unknown pen ${pen}`);
    const robots = Number(url.searchParams.get('robots') ?? 3);
    if (!Number.isInteger(robots) || robots < 1 || robots > 20) throw new HttpError(400, 'robots must be 1–20');
    return buildPlan(store, { penId: pen, day: dayParam(url), robots });
  }
  const mm = path.match(/^\/api\/missions\/(\d+)$/);
  if (method === 'POST' && mm) {
    const b = await body(req, z.object({ status: z.enum(['assigned', 'done', 'cancelled']), robot: z.string().max(40).optional(), result: z.string().max(200).optional(), note: z.string().max(500).optional() }));
    try {
      return updateMission(store, Number(mm[1]), b);
    } catch (error) {
      throw new HttpError(404, (error as Error).message);
    }
  }
  if (method === 'POST' && path === '/api/alerts/close') {
    const b = await body(req, z.object({ key: z.string(), status: z.enum(['confirmed', 'dismissed']), reason: z.string().nullable().default(null) }));
    store.closeAlert(b.key, b.status, b.reason);
    return { ok: true };
  }
  let m = path.match(/^\/api\/pens\/(\d+)$/);
  if (method === 'GET' && m) {
    const penId = Number(m[1]);
    if (!world.pens.some((p) => p.id === penId)) throw new HttpError(404, `unknown pen ${penId}`);
    const day = dayParam(url);
    await recordDay(store, day, defaultDecisionModel());
    return penDecisions(penId, day, config, reviews);
  }
  m = path.match(/^\/api\/pens\/(\d+)\/oxygen-memory$/);
  if (method === 'GET' && m) {
    const penId = Number(m[1]);
    const day = dayParam(url);
    const oxygen = penDecisions(penId, day, config, reviews).oxygen;
    return similarEpisodes({ kind: 'oxygen', penId, day, text: oxygenEventText(penId, day, oxygen.reason) }, store, defaultDecisionModel());
  }
  m = path.match(/^\/api\/findings\/(\d+)\/review$/);
  if (method === 'POST' && m) {
    const b = await body(req, z.object({ status: z.enum(['confirmed', 'rejected']), note: z.string().nullable().default(null) }));
    findingById(Number(m[1]));
    store.addReview(Number(m[1]), b.status, b.note);
    return { ok: true };
  }
  m = path.match(/^\/api\/findings\/(\d+)\/memory$/);
  if (method === 'GET' && m) {
    return { sameFinding: await sameFinding(findingById(Number(m[1])), store, defaultDecisionModel()) };
  }
  if (method === 'POST' && path === '/api/ask') {
    const b = await body(req, z.object({ question: z.string().min(3).max(500), day: z.number().int().min(0).max(96).optional() }));
    return ask(store, b.question, b.day);
  }
  if (method === 'POST' && path === '/api/curator') {
    const b = await body(req, z.object({ day: z.number().int().min(0).max(96).optional() }));
    return runCurator(store, b.day ?? TODAY);
  }
  if (method === 'GET' && path === '/api/proposals') return store.proposals();
  m = path.match(/^\/api\/proposals\/(\d+)$/);
  if (method === 'POST' && m) {
    const b = await body(req, z.object({ decision: z.enum(['accepted', 'rejected']) }));
    return store.decideProposal(Number(m[1]), b.decision);
  }
  if (method === 'POST' && path === '/api/reset') {
    store.reset();
    return { ok: true };
  }
  throw new HttpError(404, `no route ${method} ${path}`);
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  // The UI runs on another localhost port during the demo.
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  try {
    send(res, 200, await route(req, new URL(req.url ?? '/', 'http://localhost')));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error(error);
    send(res, status, { error: (error as Error).message });
  }
}).listen(PORT, () => {
  const models = modelStatus();
  console.log(`decision layer on http://localhost:${PORT}  (agent: ${models.agent ?? 'none'}, d1: ${models.d1 ?? 'none, fallback rules'})`);
});
