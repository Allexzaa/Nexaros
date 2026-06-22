import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

// ── types ─────────────────────────────────────────────────────────────────────

interface Appointment {
  id: string;
  starts_at: string;
  service_type: string | null;
  status: string;
  client_id: string | null;
  client_name: string | null;
}

interface ScheduleDetail {
  id: string;
  date: string;
  created_at: string;
  appointments: Appointment[];
}

interface Client {
  id: string;
  name: string;
  phone: string | null;
}

// ── constants ─────────────────────────────────────────────────────────────────

const HOUR_HEIGHT = 80; // px per hour
const BLOCK_HEIGHT = 60; // px per appointment block
const TIME_COL_WIDTH = 56; // px for the time label column

const STATUS_CFG: Record<string, { bg: string; border: string; color: string; label: string }> = {
  'available':          { bg: '#f9fafb', border: '#d1d5db', color: '#6b7280',  label: 'Available' },
  'pending-outreach':   { bg: '#fefce8', border: '#f59e0b', color: '#92400e',  label: 'Pending Outreach' },
  'ai-active':          { bg: '#eff6ff', border: '#3b82f6', color: '#1e40af',  label: 'AI Active' },
  'confirmed':          { bg: '#f0fdf4', border: '#22c55e', color: '#15803d',  label: 'Confirmed' },
  'cancelled':          { bg: '#fef2f2', border: '#ef4444', color: '#b91c1c',  label: 'Cancelled' },
  'rescheduled':        { bg: '#f5f3ff', border: '#8b5cf6', color: '#5b21b6',  label: 'Rescheduled' },
  'no-response':        { bg: '#f9fafb', border: '#9ca3af', color: '#4b5563',  label: 'No Response' },
};

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function getHourFloat(iso: string): number {
  const d = new Date(iso);
  return d.getHours() + d.getMinutes() / 60;
}

function toDatetimeLocal(date: string, timeStr: string) {
  return `${date}T${timeStr}`;
}

function snapTo15(rawHour: number): string {
  const h = Math.floor(rawHour);
  const m = Math.round((rawHour - h) * 60 / 15) * 15;
  const hh = Math.min(h, 23);
  const mm = m >= 60 ? 0 : m;
  const hFinal = mm >= 60 ? hh + 1 : hh;
  return `${String(hFinal).padStart(2, '0')}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}

function deriveRange(appts: Appointment[]): { startHour: number; endHour: number } {
  if (appts.length === 0) return { startHour: 8, endHour: 18 };
  const hours = appts.map(a => getHourFloat(a.starts_at));
  const min = Math.floor(Math.min(...hours)) - 1;
  const max = Math.ceil(Math.max(...hours)) + 2;
  return { startHour: Math.max(7, min), endHour: Math.min(21, max) };
}

// Assign column indices to overlapping slots
function assignColumns(appts: Appointment[]): Map<string, { col: number; totalCols: number }> {
  const sorted = [...appts].sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  const result = new Map<string, { col: number; totalCols: number }>();
  // Group into clusters of overlapping appointments
  const clusters: Appointment[][] = [];
  for (const appt of sorted) {
    const apptStart = new Date(appt.starts_at).getTime();
    const apptEnd = apptStart + 60 * 60 * 1000; // treat each as 60-min wide
    let placed = false;
    for (const cluster of clusters) {
      const clusterEnd = Math.max(...cluster.map(a => new Date(a.starts_at).getTime() + 60 * 60 * 1000));
      const clusterStart = Math.min(...cluster.map(a => new Date(a.starts_at).getTime()));
      if (apptStart < clusterEnd && apptEnd > clusterStart) {
        cluster.push(appt);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([appt]);
  }
  for (const cluster of clusters) {
    cluster.forEach((appt, i) => {
      result.set(appt.id, { col: i, totalCols: cluster.length });
    });
  }
  return result;
}

// ── main component ────────────────────────────────────────────────────────────

type PanelMode = 'empty' | 'selected' | 'add' | 'edit';

export function ScheduleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const timelineRef = useRef<HTMLDivElement>(null);

  const [schedule, setSchedule] = useState<ScheduleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [clients, setClients] = useState<Client[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);

  // Right panel
  const [panelMode, setPanelMode] = useState<PanelMode>('empty');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Add form
  const [addTime,     setAddTime]     = useState('09:00');
  const [addEndTime,  setAddEndTime]  = useState('09:30');
  const [addInterval, setAddInterval] = useState(30);
  const [addService,  setAddService]  = useState('');
  const [addClientId, setAddClientId] = useState('');
  const [addError,    setAddError]    = useState('');
  const [adding,      setAdding]      = useState(false);

  // Edit form
  const [editTime, setEditTime] = useState('');
  const [editService, setEditService] = useState('');
  const [editClientId, setEditClientId] = useState('');
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete / outreach
  const [deleting, setDeleting] = useState(false);
  const [outreachLoading, setOutreachLoading] = useState(false);
  const [outreachMsg, setOutreachMsg] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const load = useCallback(() => {
    if (!id) return;
    api.get<ScheduleDetail>(`/schedules/${id}`)
      .then(d => { setSchedule(d); setLoading(false); })
      .catch(() => { setError('Schedule not found.'); setLoading(false); });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  function ensureClients() {
    if (clientsLoaded) return;
    api.get<{ data: Client[] }>('/clients?limit=100')
      .then(r => { setClients(r.data); setClientsLoaded(true); })
      .catch(() => {});
  }

  // ── selection ──────────────────────────────────────────────────────────────

  function selectAppt(appt: Appointment, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedId(appt.id);
    setPanelMode('selected');
    setActionMsg('');
    setEditError('');
  }

  // ── timeline click (add) ───────────────────────────────────────────────────

  function handleTimelineClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!schedule) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const { startHour } = deriveRange(schedule.appointments);
    const rawHour = y / HOUR_HEIGHT + startHour;
    const snapped = snapTo15(rawHour);
    openAdd(snapped);
  }

  function openAdd(time = '09:00') {
    const [h, m] = time.split(':').map(Number);
    const endMins = h * 60 + m + 30;
    const endH = Math.floor(endMins / 60).toString().padStart(2, '0');
    const endM = (endMins % 60).toString().padStart(2, '0');
    setAddTime(time);
    setAddEndTime(`${endH}:${endM}`);
    setAddInterval(30);
    setAddService('');
    setAddClientId('');
    setAddError('');
    setSelectedId(null);
    setPanelMode('add');
    ensureClients();
  }

  // Compute list of slot times from start→end at interval
  function computeSlotTimes(start: string, end: string, interval: number): string[] {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin   = eh * 60 + em;
    if (endMin <= startMin) return [start];
    const times: string[] = [];
    for (let m = startMin; m < endMin; m += interval) {
      times.push(`${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`);
    }
    return times;
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !schedule) return;
    setAdding(true); setAddError('');
    const times = computeSlotTimes(addTime, addEndTime, addInterval);
    // Only assign client when creating a single slot
    const clientId = times.length === 1 ? (addClientId || undefined) : undefined;
    try {
      for (const t of times) {
        const starts_at = new Date(toDatetimeLocal(schedule.date, t)).toISOString();
        await api.post(`/schedules/${id}/appointments`, {
          starts_at,
          service_type: addService.trim() || undefined,
          client_id: clientId,
        });
      }
      setPanelMode('empty');
      load();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : 'Failed to add slot(s).');
    } finally {
      setAdding(false);
    }
  }

  // ── edit ───────────────────────────────────────────────────────────────────

  function openEdit(appt: Appointment) {
    setEditTime(new Date(appt.starts_at).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false }));
    setEditService(appt.service_type ?? '');
    setEditClientId(appt.client_id ?? '');
    setEditError('');
    setPanelMode('edit');
    ensureClients();
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!schedule || !selectedId) return;
    setSaving(true); setEditError('');
    try {
      const starts_at = new Date(toDatetimeLocal(schedule.date, editTime)).toISOString();
      await api.put(`/appointments/${selectedId}`, {
        starts_at,
        service_type: editService.trim() || null,
        client_id: editClientId || null,
      });
      setPanelMode('selected');
      load();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  // ── delete ─────────────────────────────────────────────────────────────────

  async function deleteAppt() {
    if (!id || !selectedId || !window.confirm('Delete this available slot?')) return;
    setDeleting(true);
    try {
      await api.delete(`/schedules/${id}/appointments/${selectedId}`);
      setSelectedId(null);
      setPanelMode('empty');
      load();
    } catch (err) {
      setActionMsg(err instanceof ApiError ? err.message : 'Failed to delete.');
    } finally {
      setDeleting(false);
    }
  }

  // ── outreach ───────────────────────────────────────────────────────────────

  async function triggerOutreach() {
    if (!id) return;
    setOutreachLoading(true); setOutreachMsg('');
    try {
      const result = await api.post<{ queued: number }>(`/schedules/${id}/outreach`, {});
      setOutreachMsg(result.queued > 0
        ? `Outreach queued for ${result.queued} client${result.queued !== 1 ? 's' : ''}.`
        : 'No pending-outreach appointments found.');
      load();
    } catch (err) {
      setOutreachMsg(err instanceof ApiError ? err.message : 'Outreach failed.');
    } finally {
      setOutreachLoading(false);
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────

  if (loading) return <p style={{ color: '#666' }}>Loading...</p>;
  if (error || !schedule) return <p style={{ color: '#dc2626' }}>{error || 'Not found.'}</p>;

  const { startHour, endHour } = deriveRange(schedule.appointments);
  const totalHours = endHour - startHour;
  const gridHeight = totalHours * HOUR_HEIGHT;
  const hours = Array.from({ length: totalHours + 1 }, (_, i) => startHour + i);

  const colMap = assignColumns(schedule.appointments);

  const selectedAppt = schedule.appointments.find(a => a.id === selectedId) ?? null;

  const pendingCount  = schedule.appointments.filter(a => a.status === 'pending-outreach').length;
  const confirmedCount = schedule.appointments.filter(a => a.status === 'confirmed').length;
  const availableCount = schedule.appointments.filter(a => a.status === 'available').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 4rem)', minHeight: 0 }}>

      {/* Header */}
      <div style={{ flexShrink: 0, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <button onClick={() => navigate('/schedules')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#6b7280' }}>←</button>
          <h1 style={{ margin: 0, fontSize: 20 }}>{fmtDate(schedule.date)}</h1>
        </div>
        <div style={{ display: 'flex', gap: 20, fontSize: 13, color: '#6b7280', paddingLeft: 34 }}>
          <span><strong style={{ color: '#111' }}>{schedule.appointments.length}</strong> slots</span>
          <span><strong style={{ color: '#15803d' }}>{confirmedCount}</strong> confirmed</span>
          <span><strong style={{ color: '#92400e' }}>{pendingCount}</strong> pending outreach</span>
          <span><strong style={{ color: '#6b7280' }}>{availableCount}</strong> available</span>
        </div>

        {/* Outreach banner */}
        {pendingCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, marginTop: 10, marginLeft: 34 }}>
            <span style={{ flex: 1, fontSize: 13, color: '#92400e' }}>
              <strong>{pendingCount}</strong> client{pendingCount !== 1 ? 's' : ''} ready for AI outreach.
            </span>
            <button onClick={triggerOutreach} disabled={outreachLoading} style={{ padding: '6px 14px', background: '#d97706', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              {outreachLoading ? 'Sending...' : 'Trigger Outreach'}
            </button>
            {outreachMsg && <span style={{ fontSize: 12, color: '#92400e' }}>{outreachMsg}</span>}
          </div>
        )}
      </div>

      {/* Body: timeline + panel */}
      <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>

        {/* ── Timeline ── */}
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
          <div style={{ position: 'relative', height: gridHeight + HOUR_HEIGHT, cursor: 'crosshair' }}
               ref={timelineRef}
               onClick={handleTimelineClick}>

            {/* Hour grid lines + labels */}
            {hours.map(h => {
              const top = (h - startHour) * HOUR_HEIGHT;
              const label = new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
              return (
                <div key={h} style={{ position: 'absolute', top, left: 0, right: 0, display: 'flex', alignItems: 'flex-start' }}>
                  <div style={{ width: TIME_COL_WIDTH, flexShrink: 0, fontSize: 11, color: '#9ca3af', paddingRight: 8, textAlign: 'right', paddingTop: 2, userSelect: 'none' }}>
                    {label}
                  </div>
                  <div style={{ flex: 1, borderTop: '1px solid #f3f4f6', height: HOUR_HEIGHT }} />
                </div>
              );
            })}

            {/* Appointment blocks */}
            {schedule.appointments.map(appt => {
              const hourFloat = getHourFloat(appt.starts_at);
              const top = (hourFloat - startHour) * HOUR_HEIGHT;
              const cfg = STATUS_CFG[appt.status] ?? STATUS_CFG['available'];
              const { col, totalCols } = colMap.get(appt.id) ?? { col: 0, totalCols: 1 };
              const blockAreaWidth = `calc(100% - ${TIME_COL_WIDTH}px - 16px)`;
              const colWidth = 100 / totalCols;
              const isSelected = selectedId === appt.id;

              return (
                <div
                  key={appt.id}
                  onClick={e => selectAppt(appt, e)}
                  style={{
                    position: 'absolute',
                    top: top + 2,
                    height: BLOCK_HEIGHT,
                    left: `calc(${TIME_COL_WIDTH}px + ${col * colWidth}% * (100% - ${TIME_COL_WIDTH}px - 16px) / 100)`,
                    width: `calc((100% - ${TIME_COL_WIDTH}px - 24px) / ${totalCols})`,
                    marginLeft: TIME_COL_WIDTH + 4 + (col * ((100 / totalCols) / 100)) as any,
                    background: cfg.bg,
                    borderLeft: `3px solid ${cfg.border}`,
                    borderRadius: 6,
                    padding: '6px 10px',
                    cursor: 'pointer',
                    boxShadow: isSelected ? `0 0 0 2px #0057ff` : '0 1px 3px rgba(0,0,0,0.06)',
                    overflow: 'hidden',
                    userSelect: 'none',
                    zIndex: isSelected ? 2 : 1,
                    transition: 'box-shadow 0.1s',
                  }}
                >
                  <div style={{ fontSize: 11, color: cfg.color, fontWeight: 700, marginBottom: 2 }}>
                    {fmtTime(appt.starts_at)}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: cfg.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {appt.client_name ?? 'Open slot'}
                  </div>
                  {appt.service_type && (
                    <div style={{ fontSize: 11, color: cfg.color, opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {appt.service_type}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right panel ── */}
        <div style={{ width: 280, flexShrink: 0, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>

          {/* EMPTY */}
          {panelMode === 'empty' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>📅</div>
              <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>No slot selected</div>
              <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20, lineHeight: 1.5 }}>
                Click a slot to view details, or click anywhere on the timeline to add a new slot.
              </div>
              <button onClick={() => openAdd()} style={primaryBtn}>+ Add Slot</button>
            </div>
          )}

          {/* SELECTED */}
          {panelMode === 'selected' && selectedAppt && (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{fmtTime(selectedAppt.starts_at)}</span>
                <button onClick={() => { setSelectedId(null); setPanelMode('empty'); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#9ca3af' }}>×</button>
              </div>

              {/* Status badge */}
              {(() => {
                const cfg = STATUS_CFG[selectedAppt.status] ?? STATUS_CFG['available'];
                return (
                  <span style={{ alignSelf: 'flex-start', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}>
                    {cfg.label}
                  </span>
                );
              })()}

              <PanelRow label="Service">{selectedAppt.service_type ?? <em style={{ color: '#9ca3af' }}>Not set</em>}</PanelRow>
              <PanelRow label="Client">
                {selectedAppt.client_name
                  ? <span onClick={() => navigate(`/clients/${selectedAppt.client_id}`)} style={{ color: '#0057ff', cursor: 'pointer', fontWeight: 500 }}>{selectedAppt.client_name} →</span>
                  : <em style={{ color: '#9ca3af' }}>Unassigned</em>}
              </PanelRow>

              {actionMsg && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>{actionMsg}</p>}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid #f3f4f6', paddingTop: 14 }}>
                {(selectedAppt.status === 'available' || selectedAppt.status === 'pending-outreach') && (
                  <button onClick={() => openEdit(selectedAppt)} style={primaryBtn}>Edit Slot</button>
                )}
                {selectedAppt.status === 'available' && (
                  <button onClick={deleteAppt} disabled={deleting} style={{ ...ghostBtn, color: '#dc2626', borderColor: '#fca5a5' }}>
                    {deleting ? 'Deleting...' : 'Delete Slot'}
                  </button>
                )}
                <button onClick={() => openAdd()} style={ghostBtn}>+ Add Another Slot</button>
              </div>
            </div>
          )}

          {/* ADD */}
          {panelMode === 'add' && (() => {
            const slotTimes = computeSlotTimes(addTime, addEndTime, addInterval);
            const multiSlot = slotTimes.length > 1;
            return (
            <div style={{ padding: 18 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Add Slot</div>
              <form onSubmit={submitAdd} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

                {/* Start / End times */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <FormField label="Start *">
                    <input id="add-time" name="add-time" type="time" value={addTime}
                      onChange={e => setAddTime(e.target.value)} required style={inputStyle} />
                  </FormField>
                  <FormField label="End">
                    <input id="add-end-time" name="add-end-time" type="time" value={addEndTime}
                      onChange={e => setAddEndTime(e.target.value)} style={inputStyle} />
                  </FormField>
                </div>

                {/* Interval */}
                <FormField label="Interval">
                  <select id="add-interval" name="add-interval" value={addInterval}
                    onChange={e => setAddInterval(+e.target.value)} style={inputStyle}>
                    <option value={15}>Every 15 min</option>
                    <option value={30}>Every 30 min</option>
                    <option value={45}>Every 45 min</option>
                    <option value={60}>Every 60 min</option>
                  </select>
                </FormField>

                {/* Preview */}
                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#1d4ed8' }}>
                  {multiSlot
                    ? <>Creates <strong>{slotTimes.length} slots</strong>: {slotTimes[0]} → {slotTimes[slotTimes.length - 1]}</>
                    : <>Creates <strong>1 slot</strong> at {slotTimes[0]}</>}
                </div>

                <FormField label="Service type">
                  <input id="add-service" name="add-service" type="text" placeholder="e.g. Haircut"
                    value={addService} onChange={e => setAddService(e.target.value)} style={inputStyle} />
                </FormField>

                {/* Client — only shown for single slot */}
                {!multiSlot && (
                  <FormField label="Assign client">
                    <select id="add-client" name="add-client" value={addClientId}
                      onChange={e => setAddClientId(e.target.value)} style={inputStyle}>
                      <option value="">— Leave unassigned —</option>
                      {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` (${c.phone})` : ''}</option>)}
                    </select>
                  </FormField>
                )}
                {multiSlot && (
                  <p style={{ fontSize: 11, color: '#9ca3af', margin: 0 }}>
                    Multiple slots are created as <em>available</em> — assign clients individually after.
                  </p>
                )}
                {!multiSlot && (
                  <p style={{ fontSize: 11, color: '#9ca3af', margin: 0 }}>
                    Assigning a client sets status to <em>pending-outreach</em>.
                  </p>
                )}

                {addError && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>{addError}</p>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" disabled={adding} style={primaryBtn}>
                    {adding ? 'Adding...' : multiSlot ? `Add ${slotTimes.length} Slots` : 'Add Slot'}
                  </button>
                  <button type="button" onClick={() => setPanelMode('empty')} style={ghostBtn}>Cancel</button>
                </div>
              </form>
            </div>
            );
          })()}

          {/* EDIT */}
          {panelMode === 'edit' && selectedAppt && (
            <div style={{ padding: 18 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Edit Slot</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>{fmtTime(selectedAppt.starts_at)}</div>
              <form onSubmit={submitEdit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <FormField label="Time *">
                  <input id="edit-time" name="edit-time" type="time" value={editTime} onChange={e => setEditTime(e.target.value)} required style={inputStyle} />
                </FormField>
                <FormField label="Service type">
                  <input id="edit-service" name="edit-service" type="text" placeholder="e.g. Haircut" value={editService} onChange={e => setEditService(e.target.value)} style={inputStyle} />
                </FormField>
                <FormField label="Assign client">
                  <select id="edit-client" name="edit-client" value={editClientId} onChange={e => setEditClientId(e.target.value)} style={inputStyle}>
                    <option value="">— Unassigned —</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` (${c.phone})` : ''}</option>)}
                  </select>
                </FormField>
                {editError && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>{editError}</p>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" disabled={saving} style={primaryBtn}>{saving ? 'Saving...' : 'Save'}</button>
                  <button type="button" onClick={() => setPanelMode('selected')} style={ghostBtn}>Cancel</button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

function PanelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.05em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, color: '#111827' }}>{children}</div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151' }}>
      {label}
      {children}
    </label>
  );
}

// ── shared styles ─────────────────────────────────────────────────────────────

const primaryBtn: React.CSSProperties = {
  padding: '8px 14px', background: '#0057ff', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, width: '100%',
};

const ghostBtn: React.CSSProperties = {
  padding: '7px 12px', background: '#fff', color: '#374151',
  border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 13, width: '100%',
};

const inputStyle: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, width: '100%', boxSizing: 'border-box',
};
