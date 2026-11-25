/**
 * Plain-language reading of a CVSS vector: what an attacker gets (impact) and
 * what they need (attack path). Works for CVSS 2.0, 3.x and 4.0 vectors, so the
 * CVE drawer can say "full takeover, remotely, no login" even when the NVD
 * description is only a placeholder.
 */

export type CvssImpact = 'takeover' | 'readWrite' | 'dataLeak' | 'tamper' | 'dos' | 'limited';
export type CvssAccess = 'network' | 'adjacent' | 'local' | 'physical';
export type CvssPrivileges = 'none' | 'low' | 'high';

export interface CvssSummary {
  impact: CvssImpact;
  /** Impact spreads beyond the vulnerable component (CVSS 3 S:C / CVSS 4 subsequent system). */
  scopeChanged: boolean;
  access: CvssAccess | null;
  privileges: CvssPrivileges | null;
  userInteraction: boolean | null;
}

function parse(vector: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of vector.replace(/^CVSS:[\d.]+\//i, '').replace(/^\(|\)$/g, '').split('/')) {
    const [k, v] = part.split(':');
    if (k && v) m.set(k.toUpperCase(), v.toUpperCase());
  }
  return m;
}

/**
 * H/L/N level of a CIA metric. CVSS 2 uses C(omplete)/P(artial)/N(one); there
 * "Partial" on all three is the classic code-execution-as-the-app result, so
 * it reads as High here rather than CVSS 3's Low.
 */
function level(v: string | undefined, v2 = false): 'H' | 'L' | 'N' {
  if (v === 'H' || v === 'C' || (v2 && v === 'P')) return 'H';
  if (v === 'L' || v === 'P') return 'L';
  return 'N';
}

export function summarizeCvss(vector: string | null | undefined): CvssSummary | null {
  if (!vector) return null;
  const m = parse(vector);
  // CVSS 4.0 names the vulnerable-system impacts VC/VI/VA and the downstream ones SC/SI/SA.
  const v2 = m.has('AU');
  const c = level(m.get('C') ?? m.get('VC'), v2);
  const i = level(m.get('I') ?? m.get('VI'), v2);
  const a = level(m.get('A') ?? m.get('VA'), v2);
  if (!m.has('AV') && !m.has('C') && !m.has('VC')) return null;

  let impact: CvssImpact;
  if (c === 'H' && i === 'H' && a === 'H') impact = 'takeover';
  else if (c === 'H' && i === 'H') impact = 'readWrite';
  else if (c === 'H') impact = 'dataLeak';
  else if (i === 'H') impact = 'tamper';
  else if (a === 'H') impact = 'dos';
  else impact = 'limited';

  const sub = [m.get('SC'), m.get('SI'), m.get('SA')].some((v) => level(v) !== 'N');
  const scopeChanged = m.get('S') === 'C' || sub;

  const av = m.get('AV');
  const access: CvssAccess | null =
    av === 'N' ? 'network' : av === 'A' ? 'adjacent' : av === 'L' ? 'local' : av === 'P' ? 'physical' : null;

  // CVSS 3/4: PR:N/L/H. CVSS 2: Au:N (none) / S (single) / M (multiple).
  const pr = m.get('PR') ?? (m.get('AU') === 'N' ? 'N' : m.get('AU') === 'S' ? 'L' : m.get('AU') === 'M' ? 'H' : undefined);
  const privileges: CvssPrivileges | null = pr === 'N' ? 'none' : pr === 'L' ? 'low' : pr === 'H' ? 'high' : null;

  // CVSS 3: UI:N/R. CVSS 4: UI:N/P/A (passive/active both need the user).
  const ui = m.get('UI');
  const userInteraction = ui === undefined ? null : ui !== 'N';

  return { impact, scopeChanged, access, privileges, userInteraction };
}
