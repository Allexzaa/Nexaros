import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../lib/api';

interface StaffMember {
  id: string;
  email: string;
  role: string;
  can_trigger_outreach: boolean;
  can_edit_schedule: boolean;
}

const ROLE_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  admin:       { label: 'Admin',       bg: '#ede9fe', color: '#6d28d9' },
  staff:       { label: 'Staff',       bg: '#dbeafe', color: '#1d4ed8' },
  viewer:      { label: 'Viewer',      bg: '#f3f4f6', color: '#4b5563' },
  deactivated: { label: 'Deactivated', bg: '#fee2e2', color: '#b91c1c' },
};

function RoleBadge({ role }: { role: string }) {
  const cfg = ROLE_BADGE[role] ?? { label: role, bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}

export function StaffManagement() {
  const { user } = useAuth();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Per-row action state
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const [rowLoading, setRowLoading] = useState<Record<string, boolean>>({});

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'staff' | 'viewer'>('staff');
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState('');
  const [inviteError, setInviteError] = useState('');

  function load() {
    api.get<{ data: StaffMember[] }>('/staff')
      .then(r => { setStaff(r.data); setLoading(false); })
      .catch(() => { setError('Failed to load staff.'); setLoading(false); });
  }

  useEffect(() => { load(); }, []);

  function setMsg(id: string, msg: string) {
    setRowMsg(m => ({ ...m, [id]: msg }));
  }
  function setBusy(id: string, busy: boolean) {
    setRowLoading(r => ({ ...r, [id]: busy }));
  }

  async function changeRole(member: StaffMember, role: string) {
    setBusy(member.id, true);
    setMsg(member.id, '');
    try {
      await api.patch(`/staff/${member.id}/role`, { role });
      setStaff(s => s.map(m => m.id === member.id ? { ...m, role } : m));
      setMsg(member.id, 'Role updated.');
    } catch (err) {
      setMsg(member.id, err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(member.id, false);
    }
  }

  async function togglePermission(member: StaffMember, flag: 'can_trigger_outreach' | 'can_edit_schedule') {
    const newVal = !member[flag];
    setBusy(member.id, true);
    setMsg(member.id, '');
    try {
      await api.patch(`/staff/${member.id}/permissions`, { [flag]: newVal });
      setStaff(s => s.map(m => m.id === member.id ? { ...m, [flag]: newVal } : m));
    } catch (err) {
      setMsg(member.id, err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(member.id, false);
    }
  }

  async function deactivate(member: StaffMember) {
    if (!window.confirm(`Deactivate ${member.email}? Their sessions will be immediately invalidated.`)) return;
    setBusy(member.id, true);
    setMsg(member.id, '');
    try {
      await api.delete(`/staff/${member.id}`);
      setStaff(s => s.map(m => m.id === member.id ? { ...m, role: 'deactivated' } : m));
      setMsg(member.id, 'Account deactivated.');
    } catch (err) {
      setMsg(member.id, err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(member.id, false);
    }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteMsg('');
    setInviteError('');
    try {
      await api.post('/staff/invite', { email: inviteEmail.trim().toLowerCase(), role: inviteRole });
      setInviteMsg(`Invite sent to ${inviteEmail.trim()}.`);
      setInviteEmail('');
      setInviteRole('staff');
      load();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : 'Failed to send invite.');
    } finally {
      setInviting(false);
    }
  }

  const active = staff.filter(m => m.role !== 'deactivated');
  const deactivated = staff.filter(m => m.role === 'deactivated');

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 4 }}>Staff</h1>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 28 }}>Manage roles, permissions, and team access.</p>

      {loading && <p style={{ color: '#666' }}>Loading...</p>}
      {error   && <p style={{ color: '#dc2626' }}>{error}</p>}

      {/* Invite form */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '18px 20px', background: '#fff', marginBottom: 28 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Invite New Staff Member</div>
        <form onSubmit={sendInvite} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={labelStyle}>
            Email address
            <input
              id="invite-email" name="invite-email"
              type="email" value={inviteEmail} required
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="jane@example.com"
              style={{ ...inputStyle, width: 240 }}
            />
          </label>
          <label style={labelStyle}>
            Role
            <select id="invite-role" name="invite-role" value={inviteRole} onChange={e => setInviteRole(e.target.value as typeof inviteRole)} style={inputStyle}>
              <option value="admin">Admin</option>
              <option value="staff">Staff</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <button type="submit" disabled={inviting} style={primaryBtn}>
            {inviting ? 'Sending...' : 'Send Invite'}
          </button>
        </form>
        {inviteMsg   && <p style={{ color: '#15803d', fontSize: 13, marginTop: 10, marginBottom: 0 }}>{inviteMsg}</p>}
        {inviteError && <p style={{ color: '#dc2626', fontSize: 13, marginTop: 10, marginBottom: 0 }}>{inviteError}</p>}
        <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 10, marginBottom: 0 }}>
          An invite link will be sent by email (console-logged in dev). Staff must accept to set their password.
        </p>
      </div>

      {/* Active staff */}
      {active.length > 0 && (
        <>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Active — {active.length}
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 24 }}>
            {active.map((member, i) => {
              const isMe = member.id === user?.id;
              const busy = rowLoading[member.id];
              const msg  = rowMsg[member.id];
              const isViewer = member.role === 'viewer';
              return (
                <div key={member.id} style={{ borderTop: i > 0 ? '1px solid #f3f4f6' : 'none', padding: '16px 18px', background: '#fff' }}>
                  {/* Top row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#ede9fe', color: '#6d28d9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, flexShrink: 0 }}>
                      {member.email.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {member.email}
                        {isMe && <span style={{ marginLeft: 8, fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>you</span>}
                      </div>
                    </div>
                    <RoleBadge role={member.role} />
                  </div>

                  {/* Controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    {/* Role change */}
                    {!isMe && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                        Role:
                        <select
                          id={`role-${member.id}`}
                          name={`role-${member.id}`}
                          value={member.role}
                          onChange={e => changeRole(member, e.target.value)}
                          disabled={busy}
                          style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                        >
                          <option value="admin">Admin</option>
                          <option value="staff">Staff</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      </label>
                    )}

                    {/* Permissions */}
                    <ToggleChip
                      label="Trigger Outreach"
                      value={member.can_trigger_outreach}
                      disabled={busy || isViewer || isMe}
                      title={isViewer ? 'Viewers cannot have permissions' : isMe ? 'Cannot edit own permissions' : ''}
                      onChange={() => togglePermission(member, 'can_trigger_outreach')}
                    />
                    <ToggleChip
                      label="Edit Schedule"
                      value={member.can_edit_schedule}
                      disabled={busy || isViewer || isMe}
                      title={isViewer ? 'Viewers cannot have permissions' : isMe ? 'Cannot edit own permissions' : ''}
                      onChange={() => togglePermission(member, 'can_edit_schedule')}
                    />

                    {/* Deactivate */}
                    {!isMe && (
                      <button
                        onClick={() => deactivate(member)}
                        disabled={busy}
                        style={{ marginLeft: 'auto', padding: '5px 12px', background: '#fff', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                      >
                        Deactivate
                      </button>
                    )}
                  </div>

                  {msg && (
                    <p style={{ fontSize: 12, color: msg.includes('fail') || msg.includes('Cannot') ? '#dc2626' : '#15803d', margin: '8px 0 0' }}>
                      {msg}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Deactivated staff */}
      {deactivated.length > 0 && (
        <>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Deactivated — {deactivated.length}
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', opacity: 0.7 }}>
            {deactivated.map((member, i) => (
              <div key={member.id} style={{ borderTop: i > 0 ? '1px solid #f3f4f6' : 'none', padding: '12px 18px', background: '#fafafa', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#f3f4f6', color: '#9ca3af', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>
                  {member.email.charAt(0).toUpperCase()}
                </div>
                <span style={{ fontSize: 14, color: '#6b7280', flex: 1 }}>{member.email}</span>
                <RoleBadge role="deactivated" />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── toggle chip ───────────────────────────────────────────────────────────────

function ToggleChip({ label, value, disabled, title, onChange }: {
  label: string; value: boolean; disabled: boolean; title?: string; onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${value ? '#86efac' : '#e5e7eb'}`,
        background: value ? '#dcfce7' : '#f9fafb',
        color: value ? '#15803d' : '#9ca3af',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s',
      }}
    >
      <span style={{ fontSize: 10 }}>{value ? '●' : '○'}</span>
      {label}
    </button>
  );
}

// ── shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14,
};

const primaryBtn: React.CSSProperties = {
  padding: '8px 18px', background: '#0057ff', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600,
  alignSelf: 'flex-end',
};

const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  fontSize: 12, fontWeight: 600, color: '#374151',
};
