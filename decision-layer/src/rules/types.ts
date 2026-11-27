/** Every decision ends in exactly one outcome (design doc §5.2). */
export type OutcomeKind = 'OK' | 'SAMPLE_MORE' | 'REVIEW' | 'MISSION' | 'ALERT' | 'ESCALATE';

export type AlertLevel = 'low' | 'medium' | 'high';

export interface Outcome {
  kind: OutcomeKind;
  /** Only for ALERT. */
  level?: AlertLevel;
  /** Rule ids that fired, in order, e.g. ["O1", "O3"]. */
  rules: string[];
  /** One plain sentence: what to do and why. */
  reason: string;
  /** Farm action a person must approve (never executed by the system). */
  recommend?: string;
}

/**
 * Settings the curator can change through an accepted proposal. Defaults are the "v1" rules.
 * Every number here is a demo starting value, not a research finding.
 */
export interface RulesConfig {
  /** If set, fraying findings below this confidence go to a re-image (F1) instead of operator review. */
  frayingReimageBelow: number | null;
}

export const DEFAULT_CONFIG: RulesConfig = { frayingReimageBelow: null };

export function rulesVersion(config: RulesConfig): string {
  return config.frayingReimageBelow === null ? 'v1' : `v2 (F1 < ${config.frayingReimageBelow})`;
}
