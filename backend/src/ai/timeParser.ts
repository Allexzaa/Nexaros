/**
 * Rule-based time expression parser.
 * Converts natural language like "after 3pm", "before noon", "between 2 and 4pm"
 * into a structured { from, to, bucket } — no LLM needed.
 */

export interface TimeRange {
  from:   string | null;  // HH:MM 24h lower bound, null = no lower bound
  to:     string | null;  // HH:MM 24h upper bound, null = no upper bound
  bucket: 'morning' | 'afternoon' | 'evening' | 'any';
}

function fmt(h: number, m = 0): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Convert 12h hour + optional am/pm to 24h.
// If am/pm is missing, infer from business-hours context:
//   1–6  without indicator → pm (1pm–6pm are common appointment times)
//   7–11 without indicator → am (morning slots)
//   12   without indicator → pm (noon)
function to24(h: number, ampm?: string): number {
  if (ampm) {
    const p = ampm.toLowerCase();
    if (p === 'pm' && h !== 12) return h + 12;
    if (p === 'am' && h === 12) return 0;
    return h;
  }
  if (h >= 1 && h <= 6)  return h + 12; // infer pm
  if (h === 12)           return 12;     // noon
  return h;                              // 7–11 stay as-is (am)
}

function bucket(h: number): TimeRange['bucket'] {
  if (h < 12)  return 'morning';
  if (h < 17)  return 'afternoon';
  return 'evening';
}

export function parseTimeExpression(text: string): TimeRange {
  if (!text) return { from: null, to: null, bucket: 'any' };
  const t = text.toLowerCase();

  // ── "after X[:MM] [am|pm]" ───────────────────────────────────────────────
  const afterM = t.match(/after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (afterM) {
    const h = to24(parseInt(afterM[1], 10), afterM[3]);
    const m = afterM[2] ? parseInt(afterM[2], 10) : 0;
    return { from: fmt(h, m), to: null, bucket: bucket(h) };
  }

  // ── "before X[:MM] [am|pm]" ──────────────────────────────────────────────
  const beforeM = t.match(/before\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (beforeM) {
    const h = to24(parseInt(beforeM[1], 10), beforeM[3]);
    const m = beforeM[2] ? parseInt(beforeM[2], 10) : 0;
    return { from: null, to: fmt(h, m), bucket: bucket(h) };
  }

  // ── "between X [am|pm] and Y [am|pm]" / "X to Y" / "X-Y" / "X-YPM" ────
  const betweenM = t.match(
    /between\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:and|to|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/,
  );
  if (betweenM) {
    const ampm1 = betweenM[3] || betweenM[6];
    const ampm2 = betweenM[6] || ampm1;
    const h1 = to24(parseInt(betweenM[1], 10), ampm1);
    const m1 = betweenM[2] ? parseInt(betweenM[2], 10) : 0;
    const h2 = to24(parseInt(betweenM[4], 10), ampm2);
    const m2 = betweenM[5] ? parseInt(betweenM[5], 10) : 0;
    return { from: fmt(h1, m1), to: fmt(h2, m2), bucket: bucket(h1) };
  }

  // ── "around X [am|pm]" → ±45 min window ─────────────────────────────────
  const aroundM = t.match(/around\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (aroundM) {
    const h = to24(parseInt(aroundM[1], 10), aroundM[3]);
    const m = aroundM[2] ? parseInt(aroundM[2], 10) : 0;
    const center = h * 60 + m;
    const lo = Math.max(0,       center - 45);
    const hi = Math.min(23 * 60, center + 45);
    return {
      from:   fmt(Math.floor(lo / 60), lo % 60),
      to:     fmt(Math.floor(hi / 60), hi % 60),
      bucket: bucket(h),
    };
  }

  // ── Time-of-day words ─────────────────────────────────────────────────────
  if (/\bmorning\b/.test(t))              return { from: null, to: null, bucket: 'morning' };
  if (/\bafternoon\b/.test(t))            return { from: null, to: null, bucket: 'afternoon' };
  if (/\bevening\b|\bnight\b/.test(t))   return { from: null, to: null, bucket: 'evening' };
  if (/\bnoon\b|\bmidday\b/.test(t))     return { from: '12:00', to: '13:00', bucket: 'afternoon' };

  return { from: null, to: null, bucket: 'any' };
}
