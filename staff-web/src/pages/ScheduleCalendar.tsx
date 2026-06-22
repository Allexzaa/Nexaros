import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

// ── types ─────────────────────────────────────────────────────────────────────

interface Slot {
  id: string;
  starts_at: string;
  service_type: string | null;
  status: string;
  client_name: string | null;
}

interface DayData {
  scheduleId: string;
  slots: Slot[];
}

type RangeData = Record<string, DayData>; // key: YYYY-MM-DD

type ViewMode = 'month' | 'week';

// ── constants ─────────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_HEIGHT = 56;
const DAY_START = 7;
const DAY_END   = 21;

const STATUS_COLOR: Record<string, string> = {
  'confirmed':       '#22c55e',
  'available':       '#94a3b8',
  'pending-outreach':'#f59e0b',
  'ai-active':       '#3b82f6',
  'cancelled':       '#ef4444',
  'no-response':     '#9ca3af',
  'rescheduled':     '#8b5cf6',
};

const STATUS_BG: Record<string, string> = {
  'confirmed':       '#f0fdf4',
  'available':       '#f8fafc',
  'pending-outreach':'#fefce8',
  'ai-active':       '#eff6ff',
  'cancelled':       '#fef2f2',
  'no-response':     '#f9fafb',
  'rescheduled':     '#f5f3ff',
};

// ── helpers ───────────────────────────────────────────────────────────────────

function toISO(d: Date): string { return d.toISOString().slice(0, 10); }

function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}

function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date):   Date { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function startOfWeek(d: Date):  Date { const r = new Date(d); r.setDate(r.getDate() - r.getDay()); return r; }
function endOfWeek(d: Date):    Date { return addDays(startOfWeek(d), 6); }

function fmtMonth(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function fmtWeekRange(d: Date): string {
  const s = startOfWeek(d), e = endOfWeek(d);
  return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function todayStr(): string {
  return new Date().toLocaleDateString('en-CA');
}

function dayStatusDots(slots: Slot[]): { color: string; count: number }[] {
  const groups: Record<string, number> = {};
  for (const s of slots) {
    const color = STATUS_COLOR[s.status] ?? '#94a3b8';
    groups[color] = (groups[color] ?? 0) + 1;
  }
  return Object.entries(groups).map(([color, count]) => ({ color, count }));
}

// ── main component ────────────────────────────────────────────────────────────

export function ScheduleCalendar() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const viewParam = (searchParams.get('view') as ViewMode) ?? 'month';
  const dateParam  = searchParams.get('date') ?? todayStr();

  const [view, setView] = useState<ViewMode>(viewParam);
  const [cursor, setCursor] = useState<Date>(new Date(dateParam + 'T12:00:00'));
  const [data, setData] = useState<RangeData>({});
  const [loading, setLoading] = useState(true);

  // Batch modal
  const [showBatch, setShowBatch] = useState(false);
  const [batchFrom,     setBatchFrom]     = useState('');
  const [batchTo,       setBatchTo]       = useState('');
  const [batchDays,     setBatchDays]     = useState<number[]>([1,2,3,4,5]);
  const [batchStart,    setBatchStart]    = useState('09:00');
  const [batchEnd,      setBatchEnd]      = useState('17:00');
  const [batchInterval, setBatchInterval] = useState(30);
  const [batchService,  setBatchService]  = useState('');
  const [batchLoading,  setBatchLoading]  = useState(false);
  const [batchResult,   setBatchResult]   = useState('');
  const [batchError,    setBatchError]    = useState('');

  // Compute range to fetch
  const { fetchFrom, fetchTo } = useCallback(() => {
    if (view === 'month') {
      const s = startOfMonth(cursor);
      const e = endOfMonth(cursor);
      // Pad to full weeks
      const from = addDays(s, -s.getDay());
      const to   = addDays(e, 6 - e.getDay());
      return { fetchFrom: toISO(from), fetchTo: toISO(to) };
    } else {
      return { fetchFrom: toISO(startOfWeek(cursor)), fetchTo: toISO(endOfWeek(cursor)) };
    }
  }, [view, cursor])();

  useEffect(() => {
    setLoading(true);
    api.get<{ days: RangeData }>(`/appointments/range?from=${fetchFrom}&to=${fetchTo}`)
      .then(r => { setData(r.days); setLoading(false); })
      .catch(() => setLoading(false));
  }, [fetchFrom, fetchTo]);

  // Sync URL
  useEffect(() => {
    setSearchParams({ view, date: toISO(cursor) }, { replace: true });
  }, [view, cursor]);

  function navigate_to(offset: number) {
    if (view === 'month') {
      setCursor(d => new Date(d.getFullYear(), d.getMonth() + offset, 1));
    } else {
      setCursor(d => addDays(d, offset * 7));
    }
  }

  function goToDay(dateStr: string) {
    const day = data[dateStr];
    if (day) {
      navigate(`/schedules/${day.scheduleId}`);
    } else {
      // Create schedule then navigate
      const today = todayStr();
      if (dateStr < today) return; // past — ignore
      api.post<{ id: string }>('/schedules', { date: dateStr })
        .then(r => navigate(`/schedules/${r.id}`))
        .catch(() => {});
    }
  }

  async function submitBatch(e: React.FormEvent) {
    e.preventDefault();
    setBatchLoading(true); setBatchResult(''); setBatchError('');
    try {
      const r = await api.post<{ schedulesCreated: number; slotsCreated: number }>(
        '/schedules/batch',
        { dateFrom: batchFrom, dateTo: batchTo, daysOfWeek: batchDays,
          timeStart: batchStart, timeEnd: batchEnd, intervalMinutes: batchInterval,
          serviceType: batchService.trim() || undefined },
      );
      setBatchResult(`Created ${r.slotsCreated} slots across ${r.schedulesCreated} new schedule days.`);
      // Reload data
      api.get<{ days: RangeData }>(`/appointments/range?from=${fetchFrom}&to=${fetchTo}`)
        .then(rd => setData(rd.days));
    } catch (err) {
      setBatchError(err instanceof ApiError ? err.message : 'Batch creation failed.');
    } finally {
      setBatchLoading(false);
    }
  }

  // Compute batch preview count
  const batchPreviewCount = (() => {
    if (!batchFrom || !batchTo || batchFrom > batchTo) return null;
    const [sh, sm] = batchStart.split(':').map(Number);
    const [eh, em] = batchEnd.split(':').map(Number);
    const slotsPerDay = Math.floor(((eh * 60 + em) - (sh * 60 + sm)) / batchInterval);
    if (slotsPerDay <= 0) return null;
    let days = 0;
    const cur = new Date(batchFrom + 'T12:00:00Z');
    const end = new Date(batchTo   + 'T12:00:00Z');
    while (cur <= end) { if (batchDays.includes(cur.getUTCDay())) days++; cur.setUTCDate(cur.getUTCDate() + 1); }
    return { slots: days * slotsPerDay, days };
  })();

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 4rem)', minHeight: 0 }}>

      {/* ── Toolbar ── */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {/* View tabs */}
        <div style={{ display: 'flex', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
          {(['month', 'week'] as ViewMode[]).map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '6px 16px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: view === v ? '#0057ff' : '#fff',
              color:      view === v ? '#fff'    : '#374151',
            }}>{v.charAt(0).toUpperCase() + v.slice(1)}</button>
          ))}
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => navigate_to(-1)} style={navBtn}>‹</button>
          <button onClick={() => setCursor(new Date())} style={{ ...navBtn, fontSize: 12, padding: '6px 12px' }}>Today</button>
          <button onClick={() => navigate_to(1)}  style={navBtn}>›</button>
        </div>

        {/* Current range label */}
        <span style={{ fontWeight: 700, fontSize: 16, flex: 1 }}>
          {view === 'month' ? fmtMonth(cursor) : fmtWeekRange(cursor)}
        </span>

        {/* Batch create button */}
        <button onClick={() => { setShowBatch(true); setBatchFrom(todayStr()); setBatchTo(toISO(addDays(new Date(), 14))); setBatchResult(''); setBatchError(''); }} style={{
          padding: '7px 16px', background: '#0057ff', color: '#fff',
          border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600,
        }}>
          ⚡ Batch Create Slots
        </button>
      </div>

      {loading && <p style={{ color: '#9ca3af' }}>Loading...</p>}

      {/* ── Month view ── */}
      {!loading && view === 'month' && <MonthView cursor={cursor} data={data} onDayClick={goToDay} />}

      {/* ── Week view ── */}
      {!loading && view === 'week' && <WeekView cursor={cursor} data={data} onDayClick={goToDay} />}

      {/* ── Batch modal ── */}
      {showBatch && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>⚡ Batch Create Slots</h2>
              <button onClick={() => setShowBatch(false)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>

            <form onSubmit={submitBatch} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* Date range */}
              <div>
                <div style={sectionLabel}>Date Range</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input id="batch-from" name="batch-from" type="date" value={batchFrom} onChange={e => setBatchFrom(e.target.value)} style={modalInput} required />
                  <span style={{ color: '#9ca3af' }}>to</span>
                  <input id="batch-to" name="batch-to" type="date" value={batchTo} min={batchFrom} onChange={e => setBatchTo(e.target.value)} style={modalInput} required />
                </div>
              </div>

              {/* Days of week */}
              <div>
                <div style={sectionLabel}>Days of Week</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {DAYS.map((d, i) => (
                    <button key={i} type="button" onClick={() => setBatchDays(ds => ds.includes(i) ? ds.filter(x => x !== i) : [...ds, i].sort())}
                      style={{
                        width: 40, height: 40, borderRadius: '50%', border: '1px solid',
                        cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: batchDays.includes(i) ? '#0057ff' : '#f9fafb',
                        color:      batchDays.includes(i) ? '#fff'    : '#6b7280',
                        borderColor: batchDays.includes(i) ? '#0057ff' : '#e5e7eb',
                      }}>{d.slice(0,2)}</button>
                  ))}
                </div>
              </div>

              {/* Time template */}
              <div>
                <div style={sectionLabel}>Time Template</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                  <label style={modalLabel}>
                    Start time
                    <input id="batch-start" name="batch-start" type="time" value={batchStart} onChange={e => setBatchStart(e.target.value)} style={modalInput} required />
                  </label>
                  <label style={modalLabel}>
                    End time
                    <input id="batch-end" name="batch-end" type="time" value={batchEnd} onChange={e => setBatchEnd(e.target.value)} style={modalInput} required />
                  </label>
                  <label style={modalLabel}>
                    Interval
                    <select id="batch-interval" name="batch-interval" value={batchInterval} onChange={e => setBatchInterval(+e.target.value)} style={modalInput}>
                      <option value={15}>15 min</option>
                      <option value={30}>30 min</option>
                      <option value={45}>45 min</option>
                      <option value={60}>60 min</option>
                    </select>
                  </label>
                </div>
              </div>

              {/* Service type */}
              <label style={modalLabel}>
                Service type <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional — applied to all slots)</span>
                <input id="batch-service" name="batch-service" type="text" placeholder="e.g. Haircut" value={batchService} onChange={e => setBatchService(e.target.value)} style={modalInput} />
              </label>

              {/* Preview */}
              {batchPreviewCount && (
                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 14px', fontSize: 14, color: '#1d4ed8' }}>
                  This will create <strong>{batchPreviewCount.slots} slots</strong> across <strong>{batchPreviewCount.days} days</strong>.
                </div>
              )}

              {batchResult && <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 14, color: '#15803d' }}>{batchResult}</div>}
              {batchError  && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 14, color: '#dc2626' }}>{batchError}</div>}

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4, borderTop: '1px solid #f3f4f6' }}>
                <button type="button" onClick={() => setShowBatch(false)} style={{ padding: '9px 18px', background: '#f3f4f6', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 14 }}>
                  {batchResult ? 'Close' : 'Cancel'}
                </button>
                {!batchResult && (
                  <button type="submit" disabled={batchLoading || batchDays.length === 0} style={{
                    padding: '9px 22px', background: '#0057ff', color: '#fff',
                    border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 14, fontWeight: 600,
                    opacity: batchLoading || batchDays.length === 0 ? 0.6 : 1,
                  }}>
                    {batchLoading ? 'Creating...' : 'Create Slots'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Month View ────────────────────────────────────────────────────────────────

function MonthView({ cursor, data, onDayClick }: { cursor: Date; data: RangeData; onDayClick: (d: string) => void }) {
  const today = todayStr();
  const s = startOfMonth(cursor);
  const e = endOfMonth(cursor);
  const gridStart = addDays(s, -s.getDay());

  const cells: Date[] = [];
  const cur = new Date(gridStart);
  while (cur <= e || cells.length % 7 !== 0 || cells.length < 35) {
    cells.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
    if (cells.length >= 42) break;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Day headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 4 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#9ca3af', padding: '4px 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{d}</div>
        ))}
      </div>

      {/* Grid */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridTemplateRows: `repeat(${cells.length / 7}, 1fr)`, gap: 2, minHeight: 0 }}>
        {cells.map((day, i) => {
          const ds = toISO(day);
          const inMonth = day.getMonth() === cursor.getMonth();
          const isToday = ds === today;
          const isPast  = ds < today;
          const dayData = data[ds];
          const dots = dayData ? dayStatusDots(dayData.slots) : [];

          return (
            <div key={i} onClick={() => inMonth && !isPast && onDayClick(ds)}
              style={{
                border: '1px solid #f3f4f6',
                borderRadius: 8,
                padding: '6px 8px',
                background: isToday ? '#eff6ff' : '#fff',
                opacity: !inMonth || isPast ? 0.4 : 1,
                cursor: inMonth && !isPast ? 'pointer' : 'default',
                display: 'flex', flexDirection: 'column', gap: 3,
                minHeight: 70,
                transition: 'box-shadow 0.1s',
              }}
              onMouseEnter={e => inMonth && !isPast && (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)')}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
            >
              <div style={{
                fontSize: 13, fontWeight: isToday ? 800 : 500,
                color: isToday ? '#0057ff' : inMonth ? '#111827' : '#9ca3af',
                width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: '50%', background: isToday ? '#dbeafe' : 'transparent',
              }}>
                {day.getDate()}
              </div>

              {/* Slot dots / mini blocks */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {dots.slice(0, 3).map((dot, di) => (
                  <div key={di} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: dot.color }} />
                    <span style={{ fontSize: 10, color: dot.color, fontWeight: 600 }}>{dot.count}</span>
                  </div>
                ))}
              </div>

              {/* Slot pills — show first 2 */}
              {dayData?.slots.slice(0, 2).map(slot => (
                <div key={slot.id} style={{
                  fontSize: 10, padding: '1px 5px', borderRadius: 4,
                  background: STATUS_BG[slot.status] ?? '#f9fafb',
                  color: STATUS_COLOR[slot.status] ?? '#6b7280',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  fontWeight: 600,
                }}>
                  {fmtTime(slot.starts_at)} {slot.client_name ?? slot.service_type ?? ''}
                </div>
              ))}
              {dayData && dayData.slots.length > 2 && (
                <div style={{ fontSize: 10, color: '#9ca3af' }}>+{dayData.slots.length - 2} more</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Week View ─────────────────────────────────────────────────────────────────

function WeekView({ cursor, data, onDayClick }: { cursor: Date; data: RangeData; onDayClick: (d: string) => void }) {
  const today  = todayStr();
  const weekStart = startOfWeek(cursor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const hours = Array.from({ length: DAY_END - DAY_START + 1 }, (_, i) => DAY_START + i);
  const totalH = (DAY_END - DAY_START) * HOUR_HEIGHT;
  const TIME_COL = 44;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Day headers */}
      <div style={{ display: 'grid', gridTemplateColumns: `${TIME_COL}px repeat(7, 1fr)`, flexShrink: 0, borderBottom: '1px solid #e5e7eb', paddingBottom: 6, marginBottom: 0 }}>
        <div />
        {days.map(day => {
          const ds = toISO(day);
          const isToday = ds === today;
          return (
            <div key={ds} onClick={() => onDayClick(ds)} style={{ textAlign: 'center', cursor: 'pointer', padding: '4px 0' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>
                {DAYS[day.getDay()]}
              </div>
              <div style={{
                fontSize: 18, fontWeight: 700,
                color: isToday ? '#0057ff' : '#111827',
                width: 32, height: 32, borderRadius: '50%',
                background: isToday ? '#dbeafe' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '2px auto 0',
              }}>
                {day.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Scrollable time grid */}
      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `${TIME_COL}px repeat(7, 1fr)`, position: 'relative', height: totalH + HOUR_HEIGHT }}>
          {/* Hour lines */}
          {hours.map(h => {
            const top = (h - DAY_START) * HOUR_HEIGHT;
            const label = new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
            return (
              <div key={h} style={{ gridColumn: '1 / -1', position: 'absolute', top, left: 0, right: 0, display: 'flex', pointerEvents: 'none' }}>
                <div style={{ width: TIME_COL, fontSize: 10, color: '#9ca3af', textAlign: 'right', paddingRight: 6, paddingTop: 2, flexShrink: 0 }}>{label}</div>
                <div style={{ flex: 1, borderTop: '1px solid #f3f4f6' }} />
              </div>
            );
          })}

          {/* Slots per day */}
          {days.map((day, colIdx) => {
            const ds = toISO(day);
            const dayData = data[ds];
            const slots = dayData?.slots ?? [];

            return slots.map(slot => {
              const d = new Date(slot.starts_at);
              const hourF = d.getHours() + d.getMinutes() / 60;
              if (hourF < DAY_START || hourF >= DAY_END) return null;
              const top   = (hourF - DAY_START) * HOUR_HEIGHT;
              const color = STATUS_COLOR[slot.status] ?? '#94a3b8';
              const bgCol = STATUS_BG[slot.status]   ?? '#f9fafb';

              return (
                <div key={slot.id}
                  onClick={() => dayData && onDayClick(ds)}
                  style={{
                    position: 'absolute',
                    top: top + 1,
                    height: HOUR_HEIGHT - 4,
                    left: `calc(${TIME_COL}px + ${colIdx} * (100% - ${TIME_COL}px) / 7 + 3px)`,
                    width: `calc((100% - ${TIME_COL}px) / 7 - 8px)`,
                    background: bgCol,
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 5,
                    padding: '3px 6px',
                    cursor: 'pointer',
                    overflow: 'hidden',
                    zIndex: 1,
                    fontSize: 11,
                    color,
                    fontWeight: 600,
                  }}
                >
                  <div>{fmtTime(slot.starts_at)}</div>
                  <div style={{ opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {slot.client_name ?? slot.service_type ?? ''}
                  </div>
                </div>
              );
            });
          })}
        </div>
      </div>
    </div>
  );
}

// ── shared styles ─────────────────────────────────────────────────────────────

const navBtn: React.CSSProperties = {
  padding: '6px 12px', background: '#fff', border: '1px solid #e5e7eb',
  borderRadius: 7, cursor: 'pointer', fontSize: 16, color: '#374151',
};

const sectionLabel: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: '#374151',
  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8,
};

const modalLabel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  fontSize: 12, fontWeight: 600, color: '#374151',
};

const modalInput: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 14, width: '100%', boxSizing: 'border-box',
};
