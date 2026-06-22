import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface Schedule {
  id: string;
  date: string;
  appointment_count: number;
  created_at: string;
}

function fmtDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function isToday(dateStr: string) {
  const today = new Date().toLocaleDateString('en-CA');
  return dateStr === today;
}

function isPast(dateStr: string) {
  const today = new Date().toLocaleDateString('en-CA');
  return dateStr < today;
}

export function ScheduleBuilder() {
  const navigate = useNavigate();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newDate, setNewDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  function load() {
    setLoading(true);
    api.get<{ data: Schedule[] }>('/schedules?limit=50')
      .then(r => { setSchedules(r.data); setLoading(false); })
      .catch(() => { setError('Failed to load schedules.'); setLoading(false); });
  }

  useEffect(() => { load(); }, []);

  async function createSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!newDate) return;
    setCreating(true);
    setCreateError('');
    try {
      await api.post('/schedules', { date: newDate });
      setNewDate('');
      load();
    } catch (err) {
      if (err instanceof ApiError) setCreateError(err.message);
      else setCreateError('Failed to create schedule.');
    } finally {
      setCreating(false);
    }
  }

  const today = new Date().toLocaleDateString('en-CA');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Schedules</h1>
        <span style={{ color: '#9ca3af', fontSize: 14 }}>{schedules.length} total</span>
      </div>

      {/* Create new */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '16px 20px', background: '#fff', marginBottom: 24 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Create New Schedule Day</div>
        <form onSubmit={createSchedule} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input
              id="schedule-date" name="schedule-date"
              type="date"
              value={newDate}
              min={today}
              onChange={e => { setNewDate(e.target.value); setCreateError(''); }}
              required
              style={{ padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 }}
            />
            {createError && <span style={{ fontSize: 12, color: '#dc2626' }}>{createError}</span>}
          </div>
          <button type="submit" disabled={creating || !newDate} style={{
            padding: '8px 16px', background: '#0057ff', color: '#fff',
            border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14,
            opacity: creating || !newDate ? 0.6 : 1,
          }}>
            {creating ? 'Creating...' : 'Create'}
          </button>
        </form>
      </div>

      {loading && <p style={{ color: '#666' }}>Loading...</p>}
      {error   && <p style={{ color: '#dc2626' }}>{error}</p>}

      {!loading && schedules.length === 0 && (
        <p style={{ color: '#9ca3af' }}>No schedules yet. Create one above.</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {schedules.map(s => {
          const past = isPast(s.date);
          const today_ = isToday(s.date);
          return (
            <div
              key={s.id}
              onClick={() => navigate(`/schedules/${s.id}`)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 18px', border: `1px solid ${today_ ? '#93c5fd' : '#e5e7eb'}`,
                borderLeft: `4px solid ${today_ ? '#3b82f6' : past ? '#e5e7eb' : '#10b981'}`,
                borderRadius: 8, background: '#fff', cursor: 'pointer',
                opacity: past && !today_ ? 0.6 : 1,
              }}
              onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  {fmtDate(s.date)}
                  {today_ && <span style={{ marginLeft: 8, fontSize: 12, color: '#3b82f6', fontWeight: 700 }}>TODAY</span>}
                </div>
                <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>
                  {s.appointment_count} appointment{s.appointment_count !== 1 ? 's' : ''}
                </div>
              </div>
              <span style={{ color: '#9ca3af', fontSize: 18 }}>→</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
