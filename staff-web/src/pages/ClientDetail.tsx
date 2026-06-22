import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface Appointment {
  id: string;
  starts_at: string;
  service_type: string | null;
  status: string;
}

interface ClientDetail {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  app_registered: boolean;
  opted_out: boolean;
  created_at: string;
  appointments: Appointment[];
}

const APPT_STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  confirmed:        { bg: '#dcfce7', color: '#15803d' },
  available:        { bg: '#f3f4f6', color: '#6b7280' },
  'ai-active':      { bg: '#dbeafe', color: '#1d4ed8' },
  'pending-outreach': { bg: '#fef9c3', color: '#a16207' },
  cancelled:        { bg: '#fee2e2', color: '#b91c1c' },
  'no-response':    { bg: '#f3f4f6', color: '#4b5563' },
  rescheduled:      { bg: '#ede9fe', color: '#6d28d9' },
};

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [optOutMsg, setOptOutMsg] = useState('');

  useEffect(() => {
    if (!id) return;
    api.get<ClientDetail>(`/clients/${id}`)
      .then(data => { setClient(data); setLoading(false); })
      .catch(() => { setError('Client not found.'); setLoading(false); });
  }, [id]);

  async function toggleOptOut() {
    if (!client || !id) return;
    const newVal = !client.opted_out;
    const confirm = newVal && !window.confirm(`Mark ${client.name} as opted out? This will cancel all active conversations.`);
    if (confirm) return;
    setSaving(true);
    setOptOutMsg('');
    try {
      await api.patch(`/clients/${id}`, { opted_out: newVal });
      setClient(c => c ? { ...c, opted_out: newVal } : c);
      setOptOutMsg(newVal ? 'Client marked as opted out.' : 'Client opt-out removed.');
    } catch (err) {
      if (err instanceof ApiError) setOptOutMsg(err.message);
      else setOptOutMsg('Failed to update.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p style={{ color: '#666' }}>Loading...</p>;
  if (error || !client) return <p style={{ color: '#dc2626' }}>{error || 'Not found.'}</p>;

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button onClick={() => navigate('/clients')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#6b7280' }}>←</button>
        <h1 style={{ margin: 0 }}>{client.name}</h1>
        {client.opted_out && (
          <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: '#fee2e2', color: '#b91c1c' }}>
            Opted Out
          </span>
        )}
      </div>

      {/* Profile card */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '20px 24px', background: '#fff', marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', marginBottom: 16 }}>
          <Field label="Phone" value={client.phone ?? '—'} />
          <Field label="Email" value={client.email ?? '—'} />
          <Field label="App Registered" value={client.app_registered ? 'Yes' : 'No'} />
          <Field label="Client Since" value={fmtDate(client.created_at)} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={toggleOptOut}
            disabled={saving}
            style={{
              padding: '7px 14px', borderRadius: 6, border: '1px solid', cursor: 'pointer', fontSize: 13,
              background: client.opted_out ? '#fff' : '#fee2e2',
              color: client.opted_out ? '#374151' : '#b91c1c',
              borderColor: client.opted_out ? '#d1d5db' : '#fca5a5',
            }}
          >
            {saving ? 'Saving...' : client.opted_out ? 'Remove Opt-Out' : 'Mark Opted Out'}
          </button>
          {optOutMsg && <span style={{ fontSize: 13, color: '#6b7280' }}>{optOutMsg}</span>}
        </div>
      </div>

      {/* Appointment history */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Recent Appointments</h2>
      {client.appointments.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>No appointments yet.</p>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
          {client.appointments.map((appt, i) => {
            const s = APPT_STATUS_STYLE[appt.status] ?? { bg: '#f3f4f6', color: '#4b5563' };
            return (
              <div key={appt.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 18px', borderTop: i > 0 ? '1px solid #f3f4f6' : 'none',
              }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>{appt.service_type ?? 'Service TBD'}</div>
                  <div style={{ color: '#6b7280', fontSize: 13 }}>{fmt(appt.starts_at)}</div>
                </div>
                <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: s.bg, color: s.color }}>
                  {appt.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.05em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, color: '#111827' }}>{value}</div>
    </div>
  );
}
