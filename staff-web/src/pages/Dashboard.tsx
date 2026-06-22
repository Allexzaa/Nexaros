import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

interface Conversation {
  id: string;
  state: string;
  client_name: string;
  service_type: string | null;
  starts_at: string;
  follow_up_count: number;
  escalation_reason: string | null;
  created_at: string;
}

const STATE_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  escalated:         { label: 'Escalated',        bg: '#fee2e2', color: '#b91c1c' },
  awaiting_approval: { label: 'Needs Approval',   bg: '#ffedd5', color: '#c2410c' },
  awaiting_reply:    { label: 'Awaiting Reply',   bg: '#dbeafe', color: '#1d4ed8' },
  staff_active:      { label: 'Staff Active',     bg: '#ede9fe', color: '#6d28d9' },
  confirmed:         { label: 'Confirmed',        bg: '#dcfce7', color: '#15803d' },
  waitlisted:        { label: 'Waitlisted',       bg: '#fef9c3', color: '#a16207' },
  no_response:       { label: 'No Response',      bg: '#f3f4f6', color: '#4b5563' },
  cancelled:         { label: 'Cancelled',        bg: '#f3f4f6', color: '#4b5563' },
  resolved:          { label: 'Resolved',         bg: '#f3f4f6', color: '#4b5563' },
};

function StateBadge({ state }: { state: string }) {
  const cfg = STATE_BADGE[state] ?? { label: state, bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{
      padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
      background: cfg.bg, color: cfg.color,
    }}>
      {cfg.label}
    </span>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const FILTERS = ['all', 'escalated', 'awaiting_approval', 'awaiting_reply', 'staff_active', 'confirmed', 'resolved'];

export function Dashboard() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    const url = filter === 'all' ? '/conversations?limit=50' : `/conversations?limit=50&state=${filter}`;
    api.get<{ data: Conversation[] }>(url)
      .then(r => setConversations(r.data))
      .catch(() => setError('Failed to load conversations.'))
      .finally(() => setLoading(false));
  }, [filter]);

  const needsAttention = conversations.filter(c =>
    c.state === 'escalated' || c.state === 'awaiting_approval'
  ).length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Conversations</h1>
        {needsAttention > 0 && (
          <span style={{
            background: '#ef4444', color: '#fff', borderRadius: 12,
            padding: '2px 10px', fontSize: 13, fontWeight: 700,
          }}>
            {needsAttention} need attention
          </span>
        )}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '5px 14px', borderRadius: 20, border: '1px solid #ddd', cursor: 'pointer',
            background: filter === f ? '#0057ff' : '#fff',
            color: filter === f ? '#fff' : '#333',
            fontSize: 13, fontWeight: filter === f ? 600 : 400,
          }}>
            {f === 'all' ? 'All' : (STATE_BADGE[f]?.label ?? f)}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: '#666' }}>Loading...</p>}
      {error   && <p style={{ color: '#dc2626' }}>{error}</p>}

      {!loading && !error && conversations.length === 0 && (
        <p style={{ color: '#666' }}>No conversations found.</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {conversations.map(conv => (
          <div
            key={conv.id}
            onClick={() => navigate(`/conversations/${conv.id}`)}
            style={{
              border: `1px solid ${conv.state === 'escalated' ? '#fca5a5' : '#e5e7eb'}`,
              borderLeft: `4px solid ${conv.state === 'escalated' ? '#ef4444' : conv.state === 'awaiting_approval' ? '#f97316' : '#e5e7eb'}`,
              borderRadius: 8, padding: '14px 18px', cursor: 'pointer',
              background: '#fff', display: 'flex', alignItems: 'center', gap: 16,
              transition: 'box-shadow 0.1s',
            }}
            onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)')}
            onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{conv.client_name}</div>
              <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>
                {conv.service_type ?? 'Service TBD'} &middot; {fmt(conv.starts_at)}
              </div>
              {conv.escalation_reason && (
                <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>
                  {conv.escalation_reason}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <StateBadge state={conv.state} />
              {conv.follow_up_count > 0 && (
                <span style={{ fontSize: 11, color: '#9ca3af' }}>
                  {conv.follow_up_count} follow-up{conv.follow_up_count !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
