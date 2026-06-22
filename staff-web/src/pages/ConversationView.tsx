import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface Message {
  id: string;
  sender: 'ai' | 'client' | 'staff';
  content: string;
  timestamp: string;
}

interface ConversationDetail {
  id: string;
  state: string;
  client_id: string;
  client_name: string;
  service_type: string | null;
  starts_at: string;
  follow_up_count: number;
  escalation_reason: string | null;
  context_summary: string | null;
  taken_over_by: string | null;
  messages: Message[];
}

const STATE_CFG: Record<string, { label: string; bg: string; color: string }> = {
  escalated:         { label: 'Escalated',       bg: '#fee2e2', color: '#b91c1c' },
  awaiting_approval: { label: 'Needs Approval',  bg: '#ffedd5', color: '#c2410c' },
  awaiting_reply:    { label: 'Awaiting Reply',  bg: '#dbeafe', color: '#1d4ed8' },
  staff_active:      { label: 'Staff Active',    bg: '#ede9fe', color: '#6d28d9' },
  confirmed:         { label: 'Confirmed',       bg: '#dcfce7', color: '#15803d' },
  waitlisted:        { label: 'Waitlisted',      bg: '#fef9c3', color: '#a16207' },
  no_response:       { label: 'No Response',     bg: '#f3f4f6', color: '#4b5563' },
  cancelled:         { label: 'Cancelled',       bg: '#f3f4f6', color: '#4b5563' },
  resolved:          { label: 'Resolved',        bg: '#f3f4f6', color: '#4b5563' },
};

const SENDER_STYLE: Record<string, { align: 'flex-start' | 'flex-end'; bg: string; color: string; label: string }> = {
  ai:     { align: 'flex-start', bg: '#f3f4f6', color: '#111827', label: 'AI' },
  staff:  { align: 'flex-end',   bg: '#6d28d9', color: '#fff',    label: 'Staff' },
  client: { align: 'flex-start', bg: '#dbeafe', color: '#1e3a8a', label: 'Client' },
};

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function fmtAppt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export function ConversationView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const bottomRef = useRef<HTMLDivElement>(null);

  const [conv, setConv] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [actionError, setActionError] = useState('');

  // Staff message input
  const [staffMsg, setStaffMsg] = useState('');
  const [staffSending, setStaffSending] = useState(false);
  const [staffMsgError, setStaffMsgError] = useState('');

  // Dev simulate reply
  const [simMsg, setSimMsg] = useState('');
  const [simLoading, setSimLoading] = useState(false);
  const [simStatus, setSimStatus] = useState('');

  function load() {
    if (!id) return;
    api.get<ConversationDetail>(`/conversations/${id}`)
      .then(data => { setConv(data); setLoading(false); })
      .catch(() => { setError('Conversation not found.'); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conv?.messages.length]);

  async function doAction(action: string, body?: Record<string, unknown>) {
    if (!id) return;
    setActionLoading(action);
    setActionError('');
    try {
      if (action === 'takeover') {
        await api.patch(`/conversations/${id}/takeover`, {});
      } else if (action === 'return') {
        await api.patch(`/conversations/${id}/return`, {});
      } else if (action === 'close') {
        await api.patch(`/conversations/${id}/close`, {});
      } else if (action === 'approve') {
        await api.patch(`/conversations/${id}/booking`, { action: 'approve' });
      } else if (action === 'reject') {
        await api.patch(`/conversations/${id}/booking`, { action: 'reject' });
      }
      load();
    } catch (err) {
      if (err instanceof ApiError) setActionError(err.message);
      else setActionError('Action failed.');
    } finally {
      setActionLoading('');
    }
  }

  async function sendStaffMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !staffMsg.trim()) return;
    setStaffSending(true);
    setStaffMsgError('');
    try {
      await api.post(`/conversations/${id}/messages`, { content: staffMsg.trim() });
      setStaffMsg('');
      load();
    } catch (err) {
      if (err instanceof ApiError) setStaffMsgError(err.message);
      else setStaffMsgError('Failed to send message.');
    } finally {
      setStaffSending(false);
    }
  }

  async function simulateReply(message: string) {
    if (!id || !message.trim()) return;
    setSimLoading(true);
    setSimStatus('Sending...');
    try {
      const res = await fetch('/dev/simulate-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: id, message: message.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: { message?: string } };
        setSimStatus(`Error: ${d.error?.message ?? res.statusText}`);
        setSimLoading(false);
        return;
      }
      setSimMsg('');
      setSimStatus('AI is thinking…');
      // Poll for updated state after a delay
      setTimeout(() => { load(); setSimStatus('Done — thread refreshed.'); setSimLoading(false); }, 8000);
    } catch {
      setSimStatus('Request failed.');
      setSimLoading(false);
    }
  }

  if (loading) return <p style={{ color: '#666' }}>Loading...</p>;
  if (error || !conv) return <p style={{ color: '#dc2626' }}>{error || 'Not found.'}</p>;

  const stateCfg = STATE_CFG[conv.state] ?? { label: conv.state, bg: '#f3f4f6', color: '#374151' };
  const TERMINAL = ['confirmed', 'cancelled', 'resolved', 'no_response'];
  const isTerminal = TERMINAL.includes(conv.state);

  return (
    <div style={{ display: 'flex', gap: 24, height: 'calc(100vh - 6rem)', minHeight: 0 }}>

      {/* ── Message thread ───────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#6b7280' }}>←</button>
          <h2 style={{ margin: 0 }}>{conv.client_name}</h2>
          <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: stateCfg.bg, color: stateCfg.color }}>
            {stateCfg.label}
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, background: '#fafafa' }}>
          {conv.messages.length === 0 && <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 40 }}>No messages yet.</p>}
          {conv.messages.map(msg => {
            const s = SENDER_STYLE[msg.sender] ?? SENDER_STYLE.ai;
            return (
              <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: s.align }}>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>
                  {s.label} &middot; {fmt(msg.timestamp)}
                </div>
                <div style={{
                  maxWidth: '75%', padding: '10px 14px', borderRadius: 12,
                  background: s.bg, color: s.color, fontSize: 14, lineHeight: 1.5,
                  borderBottomLeftRadius: msg.sender !== 'staff' ? 4 : 12,
                  borderBottomRightRadius: msg.sender === 'staff' ? 4 : 12,
                  whiteSpace: 'pre-line',
                }}>
                  {msg.content}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Staff message input — shown only when staff has taken over */}
        {conv.state === 'staff_active' && (
          <form onSubmit={sendStaffMessage} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                id="staff-message-input"
                name="staff-message-input"
                value={staffMsg}
                onChange={e => setStaffMsg(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendStaffMessage(e as any); } }}
                placeholder="Type a message to the client… (Enter to send, Shift+Enter for new line)"
                disabled={staffSending}
                rows={3}
                style={{
                  flex: 1, padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8,
                  fontSize: 14, resize: 'none', fontFamily: 'sans-serif', lineHeight: 1.5,
                  background: staffSending ? '#f9fafb' : '#fff',
                }}
              />
              <button
                type="submit"
                disabled={staffSending || !staffMsg.trim()}
                style={{
                  padding: '10px 20px', background: '#6d28d9', color: '#fff', border: 'none',
                  borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600, alignSelf: 'flex-end',
                  opacity: staffSending || !staffMsg.trim() ? 0.5 : 1,
                }}
              >
                {staffSending ? 'Sending…' : 'Send'}
              </button>
            </div>
            {staffMsgError && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{staffMsgError}</p>}
          </form>
        )}

        {/* Action buttons */}
        {!isTerminal && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(conv.state === 'escalated' || conv.state === 'awaiting_reply' || conv.state === 'awaiting_approval') && conv.state !== 'staff_active' && (
              <button onClick={() => doAction('takeover')} disabled={!!actionLoading} style={btnStyle('#6d28d9')}>
                {actionLoading === 'takeover' ? 'Taking over...' : 'Take Over'}
              </button>
            )}
            {conv.state === 'staff_active' && (
              <button onClick={() => doAction('return')} disabled={!!actionLoading} style={btnStyle('#0057ff')}>
                {actionLoading === 'return' ? 'Returning...' : 'Return to AI'}
              </button>
            )}
            {conv.state === 'awaiting_approval' && (
              <>
                <button onClick={() => doAction('approve')} disabled={!!actionLoading} style={btnStyle('#15803d')}>
                  {actionLoading === 'approve' ? 'Approving...' : 'Approve Booking'}
                </button>
                <button onClick={() => doAction('reject')} disabled={!!actionLoading} style={btnStyle('#dc2626')}>
                  {actionLoading === 'reject' ? 'Rejecting...' : 'Reject Booking'}
                </button>
              </>
            )}
            <button onClick={() => doAction('close')} disabled={!!actionLoading} style={btnStyle('#6b7280')}>
              {actionLoading === 'close' ? 'Closing...' : 'Close Conversation'}
            </button>
          </div>
        )}
        {actionError && <p style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{actionError}</p>}
      </div>

      {/* ── Right panel ───────────────────────────────────────────────── */}
      <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={panelStyle}>
          <div style={panelLabel}>Client</div>
          <div style={{ fontWeight: 600 }}>{conv.client_name}</div>
          <div
            style={{ color: '#0057ff', cursor: 'pointer', fontSize: 13, marginTop: 4 }}
            onClick={() => navigate(`/clients/${conv.client_id}`)}
          >
            View profile →
          </div>
        </div>

        <div style={panelStyle}>
          <div style={panelLabel}>Appointment</div>
          <div style={{ fontWeight: 600 }}>{conv.service_type ?? 'Service TBD'}</div>
          <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>{fmtAppt(conv.starts_at)}</div>
        </div>

        {conv.escalation_reason && (
          <div style={{ ...panelStyle, background: '#fff7f7', borderColor: '#fca5a5' }}>
            <div style={{ ...panelLabel, color: '#b91c1c' }}>Escalation Reason</div>
            <div style={{ fontSize: 13, color: '#b91c1c' }}>{conv.escalation_reason}</div>
          </div>
        )}

        {conv.context_summary && (
          <div style={panelStyle}>
            <div style={panelLabel}>AI Summary</div>
            <div style={{ fontSize: 13, color: '#374151' }}>{conv.context_summary}</div>
          </div>
        )}

        <div style={panelStyle}>
          <div style={panelLabel}>Details</div>
          <div style={{ fontSize: 13, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div>State: <strong style={{ color: stateCfg.color }}>{stateCfg.label}</strong></div>
            <div>Follow-ups sent: <strong>{conv.follow_up_count}</strong></div>
            {conv.taken_over_by && <div>Taken over by staff</div>}
          </div>
        </div>

        {/* Dev: Simulate Client Reply — only shown when AI is waiting for client */}
        {['awaiting_reply', 'confirming', 'rescheduling', 'slot_offered', 'awaiting_approval'].includes(conv.state) && (
          <div style={{ ...panelStyle, background: '#fffbeb', borderColor: '#fde68a' }}>
            <div style={{ ...panelLabel, color: '#92400e' }}>🧪 Simulate Client Reply</div>

            {/* Quick replies */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
              {['Yes', 'No', 'Can we reschedule?', 'I need to speak to someone', 'STOP'].map(q => (
                <button
                  key={q}
                  onClick={() => simulateReply(q)}
                  disabled={simLoading}
                  style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 12, cursor: 'pointer',
                    border: '1px solid #fcd34d', background: '#fff', color: '#92400e',
                    opacity: simLoading ? 0.5 : 1,
                  }}
                >
                  {q}
                </button>
              ))}
            </div>

            {/* Custom message */}
            <textarea
              id="sim-message" name="sim-message"
              value={simMsg}
              onChange={e => setSimMsg(e.target.value)}
              placeholder="Type a custom client message…"
              disabled={simLoading}
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                border: '1px solid #fcd34d', borderRadius: 6, fontSize: 13,
                resize: 'vertical', background: simLoading ? '#f9f9f9' : '#fff',
              }}
            />
            <button
              onClick={() => simulateReply(simMsg)}
              disabled={simLoading || !simMsg.trim()}
              style={{
                marginTop: 6, width: '100%', padding: '7px', background: '#d97706',
                color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
                fontSize: 13, fontWeight: 600, opacity: simLoading || !simMsg.trim() ? 0.5 : 1,
              }}
            >
              {simLoading ? simStatus : 'Send as Client'}
            </button>
            {!simLoading && simStatus && (
              <p style={{ fontSize: 11, color: '#92400e', margin: '6px 0 0', textAlign: 'center' }}>{simStatus}</p>
            )}
            <p style={{ fontSize: 10, color: '#b45309', margin: '8px 0 0', textAlign: 'center' }}>Dev mode only — not shown in production</p>
          </div>
        )}
      </div>
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: '8px 16px', background: bg, color: '#fff', border: 'none',
    borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
  };
}

const panelStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', background: '#fff',
};

const panelLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af',
  letterSpacing: '0.05em', marginBottom: 6,
};
