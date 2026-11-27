/**
 * Net rules: turn the UI's risk score per cell, and each new finding, into one outcome.
 * The score itself comes from web/src/data/risk.ts (condition × exposure × consequence);
 * these rules only decide what to do about it.
 */
import type { Outcome, RulesConfig } from './types.ts';

/** The parts of the UI's CellRisk these rules use. */
export interface CellRiskInput {
  level: 'low' | 'elevated' | 'high' | 'critical';
  score: number;
  stale: boolean;
  coverageAge: number | null;
  predicted: boolean;
  knownHole: boolean;
  recommendation: string;
}

/**
 * N0 known hole → high alert · N1 stale data → sample more (never "all clear" on old data) ·
 * N2 forecast high/critical → low alert · N3 critical → medium alert + close inspection ·
 * N4 high → close-inspection mission · N5 otherwise OK.
 */
export function decideCell(risk: CellRiskInput): Outcome {
  if (risk.knownHole) {
    return { kind: 'ALERT', level: 'high', rules: ['N0'], reason: 'Known hole in this area.', recommend: risk.recommendation };
  }
  if (risk.stale) {
    const age = risk.coverageAge === null ? 'never inspected' : `last seen ${risk.coverageAge} days ago`;
    return { kind: 'SAMPLE_MORE', rules: ['N1'], reason: `Data too old to judge (${age}); send a drone to re-image.` };
  }
  if (risk.predicted && (risk.level === 'high' || risk.level === 'critical')) {
    return { kind: 'ALERT', level: 'low', rules: ['N2'], reason: `Forecast risk ${risk.level} (${risk.score.toFixed(2)}).`, recommend: risk.recommendation };
  }
  if (risk.level === 'critical') {
    return { kind: 'ALERT', level: 'medium', rules: ['N3'], reason: `Risk critical (${risk.score.toFixed(2)}).`, recommend: risk.recommendation };
  }
  if (risk.level === 'high') {
    return { kind: 'MISSION', rules: ['N4'], reason: `Risk high (${risk.score.toFixed(2)}): close inspection.`, recommend: risk.recommendation };
  }
  return { kind: 'OK', rules: ['N5'], reason: `Risk ${risk.level} (${risk.score.toFixed(2)}).` };
}

export interface FindingInput {
  kind: 'fraying' | 'chafe' | 'distortion' | 'hole';
  confidence: number;
}

/**
 * F0 hole at confidence ≥ 0.7 → high alert · F1 (learned, off in v1) low-confidence fraying →
 * re-image before bothering the operator · F2 otherwise → operator review.
 */
export function decideFinding(finding: FindingInput, config: RulesConfig): Outcome {
  if (finding.kind === 'hole' && finding.confidence >= 0.7) {
    return { kind: 'ALERT', level: 'high', rules: ['F0'], reason: `Possible hole (confidence ${finding.confidence.toFixed(2)}).`, recommend: 'Verify now; repair and report escape risk if confirmed.' };
  }
  if (config.frayingReimageBelow !== null && finding.kind === 'fraying' && finding.confidence < config.frayingReimageBelow) {
    return {
      kind: 'SAMPLE_MORE',
      rules: ['F1'],
      reason: `Fraying at confidence ${finding.confidence.toFixed(2)} (< ${config.frayingReimageBelow}): re-image close up before asking the operator.`,
    };
  }
  return { kind: 'REVIEW', rules: ['F2'], reason: `New ${finding.kind} finding (confidence ${finding.confidence.toFixed(2)}): operator review.` };
}
