import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface Conversation {
  id: string;
  state: string;
  client_name: string;
  client_id: string;
  service_type: string | null;
  starts_at: string;
  escalation_reason: string | null;
  created_at: string;
}

function fmtAppt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtAge(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function ApproveBooking() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});

  function load() {
    setLoading(true);
    api.get<{ data: Conversation[] }>('/conversations?state=awaiting_approval&limit=50')
      .then(r => { setConversations(r.data); setLoading(false); })
      .catch(() => { setError('Failed to load.'); setLoading(false); });
  }

  useEffect(() => { load(); }, []);

  async function act(convId: string, action: 'approve' | 'reject') {
    setActing(a => ({ ...a, [convId]: action }));
    setMessages(m => ({ ...m, [convId]: '' }));
    try {
      await api.patch(`/conversations/${convId}/booking`, { action });
      setMessages(m => ({
        ...m,
        [convId]: action === 'approve' ? 'Approved — AI will offer the slot.' : 'Rejected — AI will inform the client.',
      }));
      // Remove from list after short delay
      setTimeout(() => {
        setConversations(cs => cs.filter(c => c.id !== convId));
        setMessages(m => { const n = { ...m }; delete n[convId]; return n; });
      }, 2500);
    } catch (err) {
      setMessages(m => ({
        ...m,
        [convId]: err instanceof ApiError ? err.message : 'Action failed.',
      }));
    } finally {
      setActing(a => { const n = { ...a }; delete n[convId]; return n; });
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Approve Bookings</h1>
        {conversations.length > 0 && (
          <span style={{ background: '#f97316', color: '#fff', borderRadius: 12, padding: '2px 10px', fontSize: 13, fontWeight: 700 }}>
            {conversations.length} pending
          </span>
        )}
      </div>
      <p style={{ color: '#6b7280', marginTop: 4, marginBottom: 24, fontSize: 14 }}>
        Client-initiated booking requests waiting for staff approval before the AI confirms.
      </p>

      {loading && <p style={{ color: '#666' }}>Loading...</p>}
      {error   && <p style={{ color: '#dc2626' }}>{error}</p>}

      {!loading && !error && conversations.length === 0 && (
        <div style={{ border: '1px dashed #d1d5db', borderRadius: 8, padding: '48px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
          <div style={{ fontWeight: 600, color: '#374151' }}>All caught up</div>
          <div style={{ color: '#9ca3af', fontSize: 14, marginTop: 4 }}>No booking requests waiting for approval.</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {conversations.map(conv => {
          const isActing = !!acting[conv.id];
          const msg = messages[conv.id];
          return (
            <div key={conv.id} style={{
              border: '1px solid #fed7aa', borderLeft: '4px solid #f97316',
              borderRadius: 8, padding: '18px 20px', background: '#fff',
            }}>
              {/* Header row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{conv.client_name}</div>
                  <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>
                    {conv.service_type ?? 'Service TBD'} &middot; {fmtAppt(conv.starts_at)}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>Requested {fmtAge(conv.created_at)}</div>
              </div>

              {/* Escalation context (if any) */}
              {conv.escalation_reason && (
                <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#92400e', marginBottom: 12 }}>
                  <strong>Context:</strong> {conv.escalation_reason}
                </div>
              )}

              {/* Action row */}
              {!msg ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    onClick={() => act(conv.id, 'approve')}
                    disabled={isActing}
                    style={{ padding: '8px 20px', background: '#15803d', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}
                  >
                    {acting[conv.id] === 'approve' ? 'Approving...' : 'Approve'}
                  </button>
                  <button
                    onClick={() => act(conv.id, 'reject')}
                    disabled={isActing}
                    style={{ padding: '8px 20px', background: '#fff', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}
                  >
                    {acting[conv.id] === 'reject' ? 'Rejecting...' : 'Reject'}
                  </button>
                  <button
                    onClick={() => navigate(`/conversations/${conv.id}`)}
                    style={{ padding: '8px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                  >
                    View thread →
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 14, color: '#15803d', fontWeight: 500 }}>{msg}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
