/**
 * Oxygen rules for one pen and day. Inputs are the fixed sensor string and drone readings from the
 * cells the swarm inspected that day. Values are % saturation, as in the UI.
 *
 * Thresholds are demo starting values. Sources for real ones are in the design doc §5.3.
 */
import type { Outcome } from './types.ts';

export const OXYGEN = { warn: 65, critical: 50 };

export interface OxygenSource {
  /** "sensor 15 m" or "drone cell 189". */
  id: string;
  kind: 'sensor' | 'drone';
  depth: number;
  oxygen: number;
  /** Day the value was measured; older than the decision day means no fresh value arrived. */
  readingDay: number;
}

export interface OxygenDecision extends Outcome {
  /** Sensors excluded by O1 because they sent no fresh value. */
  flaggedSensors: string[];
  /** The lowest trusted reading, if any. */
  min: OxygenSource | null;
  lowSources: OxygenSource[];
}

/**
 * O0 no data → escalate · O1 sensor with no fresh value → flag and exclude · O2 any trusted
 * reading below critical → high alert · O3 two or more sources below warn → medium alert and
 * recommend pausing feeding · O4 one source below warn → sample more · O5 otherwise OK.
 */
export function decideOxygen(sources: OxygenSource[], day: number): OxygenDecision {
  const rules: string[] = [];
  const flaggedSensors = sources.filter((s) => s.kind === 'sensor' && s.readingDay < day).map((s) => s.id);
  if (flaggedSensors.length > 0) rules.push('O1');
  const trusted = sources.filter((s) => !flaggedSensors.includes(s.id));

  const flagNote = flaggedSensors.length > 0 ? ` ${flaggedSensors.join(', ')} sent no fresh value: excluded, needs a check.` : '';
  if (trusted.length === 0) {
    return { kind: 'ESCALATE', rules: [...rules, 'O0'], reason: `No trusted oxygen data.${flagNote}`, flaggedSensors, min: null, lowSources: [] };
  }

  const min = trusted.reduce((a, b) => (b.oxygen < a.oxygen ? b : a));
  const low = trusted.filter((s) => s.oxygen < OXYGEN.warn);
  const where = `${min.oxygen.toFixed(0)}% at ${min.depth.toFixed(1)} m (${min.id})`;
  const base = { flaggedSensors, min, lowSources: low };

  if (min.oxygen < OXYGEN.critical) {
    return { ...base, kind: 'ALERT', level: 'high', rules: [...rules, 'O2'], reason: `Oxygen critical: ${where}; ${low.length} sources below ${OXYGEN.warn}%.${flagNote}`, recommend: 'Stop feeding and handling; consider oxygenation.' };
  }
  if (low.length >= 2) {
    return { ...base, kind: 'ALERT', level: 'medium', rules: [...rules, 'O3'], reason: `Low oxygen confirmed by ${low.length} sources, lowest ${where}.${flagNote}`, recommend: 'Pause feeding in this pen until oxygen recovers.' };
  }
  if (low.length === 1) {
    return { ...base, kind: 'SAMPLE_MORE', rules: [...rules, 'O4'], reason: `One low reading (${where}); send a second drone to confirm.${flagNote}` };
  }
  return { ...base, kind: 'OK', rules: [...rules, 'O5'], reason: `Oxygen fine, lowest ${where}.${flagNote}` };
}
