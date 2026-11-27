/**
 * The only state the decision layer keeps: what people did (reviews, alert closures, accepted
 * proposals), cached d1 answers and chat history. Decisions themselves are recomputed from the
 * world on every request, so they always match the UI.
 */
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CONFIG, type RulesConfig } from './rules/types.ts';

export type ReviewStatus = 'confirmed' | 'rejected';
export type AlertStatus = 'confirmed' | 'dismissed';
export type ProposalStatus = 'open' | 'accepted' | 'rejected';

export interface Proposal {
  id: number;
  created_at: string;
  rule: string;
  change: Partial<RulesConfig>;
  rationale: string;
  evidence: string[];
  author: string;
  status: ProposalStatus;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        finding_id INTEGER NOT NULL, status TEXT NOT NULL, note TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_closures (
        alert_key TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, rule TEXT NOT NULL,
        change_json TEXT NOT NULL, rationale TEXT NOT NULL, evidence_json TEXT NOT NULL,
        author TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decided_at TEXT);
      CREATE TABLE IF NOT EXISTS d1_cache (
        key TEXT PRIMARY KEY, answer_json TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL,
        tool_calls_json TEXT, at TEXT NOT NULL);
      -- Append-only record of what was decided, from which inputs, under which rules (log.ts).
      -- One row per day, entity and rules version: a rule change adds a row, it never overwrites.
      CREATE TABLE IF NOT EXISTS decision_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, logged_at TEXT NOT NULL,
        day INTEGER NOT NULL, pen_id INTEGER NOT NULL, entity TEXT NOT NULL, outcome TEXT NOT NULL,
        level TEXT, rules_json TEXT NOT NULL, rules_version TEXT NOT NULL, reason TEXT NOT NULL,
        recommend TEXT, inputs_json TEXT NOT NULL, links_json TEXT NOT NULL, alert_key TEXT,
        mission_id INTEGER);
      -- Work the decision layer asks the swarm to do; robots (Isaac, the UI's swarm) report back here.
      CREATE TABLE IF NOT EXISTS missions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        day INTEGER NOT NULL, pen_id INTEGER NOT NULL, kind TEXT NOT NULL, cells_json TEXT NOT NULL,
        priority TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested',
        robot TEXT, result TEXT, note TEXT, updated_at TEXT NOT NULL);
    `);
  }

  addReview(findingId: number, status: ReviewStatus, note: string | null): void {
    this.db.prepare('INSERT INTO reviews VALUES (?, ?, ?, ?)').run(findingId, status, note, new Date().toISOString());
  }

  /** Latest live review per finding (overrides the simulated history). */
  reviews(): Map<number, ReviewStatus> {
    const rows = this.db.prepare('SELECT finding_id, status FROM reviews ORDER BY rowid').all() as Array<{ finding_id: number; status: ReviewStatus }>;
    return new Map(rows.map((r) => [r.finding_id, r.status]));
  }

  closeAlert(key: string, status: AlertStatus, reason: string | null): void {
    this.db
      .prepare('INSERT INTO alert_closures VALUES (?, ?, ?, ?) ON CONFLICT(alert_key) DO UPDATE SET status = excluded.status, reason = excluded.reason, at = excluded.at')
      .run(key, status, reason, new Date().toISOString());
  }

  alertClosures(): Map<string, { status: AlertStatus; reason: string | null }> {
    const rows = this.db.prepare('SELECT alert_key, status, reason FROM alert_closures').all() as Array<{ alert_key: string; status: AlertStatus; reason: string | null }>;
    return new Map(rows.map((r) => [r.alert_key, { status: r.status, reason: r.reason }]));
  }

  addProposal(p: Omit<Proposal, 'id' | 'created_at' | 'status'>): Proposal {
    const created = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO proposals (created_at, rule, change_json, rationale, evidence_json, author) VALUES (?, ?, ?, ?, ?, ?)')
      .run(created, p.rule, JSON.stringify(p.change), p.rationale, JSON.stringify(p.evidence), p.author);
    return { ...p, id: Number(result.lastInsertRowid), created_at: created, status: 'open' };
  }

  proposals(): Proposal[] {
    const rows = this.db.prepare('SELECT * FROM proposals ORDER BY id').all() as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      id: Number(r.id),
      created_at: String(r.created_at),
      rule: String(r.rule),
      change: JSON.parse(String(r.change_json)),
      rationale: String(r.rationale),
      evidence: JSON.parse(String(r.evidence_json)),
      author: String(r.author),
      status: r.status as ProposalStatus,
    }));
  }

  decideProposal(id: number, status: 'accepted' | 'rejected'): Proposal {
    const result = this.db.prepare("UPDATE proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'open'").run(status, new Date().toISOString(), id);
    if (result.changes === 0) throw new Error(`proposal ${id} not found or not open`);
    const found = this.proposals().find((p) => p.id === id);
    if (!found) throw new Error(`proposal ${id} not found`);
    return found;
  }

  /** v1 defaults plus every accepted proposal, in order. */
  config(): RulesConfig {
    return this.proposals()
      .filter((p) => p.status === 'accepted')
      .reduce<RulesConfig>((config, p) => ({ ...config, ...p.change }), { ...DEFAULT_CONFIG });
  }

  cached<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT answer_json FROM d1_cache WHERE key = ?').get(key) as { answer_json: string } | undefined;
    return row ? (JSON.parse(row.answer_json) as T) : undefined;
  }

  cache(key: string, answer: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO d1_cache VALUES (?, ?, ?)').run(key, JSON.stringify(answer), new Date().toISOString());
  }

  addChat(role: 'user' | 'assistant', text: string, toolCalls: unknown = null): void {
    this.db.prepare('INSERT INTO chat_messages (role, text, tool_calls_json, at) VALUES (?, ?, ?, ?)').run(role, text, toolCalls === null ? null : JSON.stringify(toolCalls), new Date().toISOString());
  }

  /** Wipes everything people did, the decision log and missions, for a clean demo run. */
  reset(): void {
    // Also restart the id counters, so a fresh demo run shows proposal 1 again.
    this.db.exec(`DELETE FROM reviews; DELETE FROM alert_closures; DELETE FROM proposals; DELETE FROM chat_messages;
      DELETE FROM decision_log; DELETE FROM missions;
      DELETE FROM sqlite_sequence WHERE name IN ('proposals', 'chat_messages', 'decision_log', 'missions');`);
  }
}
