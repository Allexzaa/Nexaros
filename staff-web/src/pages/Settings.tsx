import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';

interface BusinessSettings {
  outreach_response_window_hours?: number;
  outreach_hours_start?: string;
  outreach_hours_end?: string;
  auto_pickup_interval_minutes?: number;
  escalation_keywords?: string[];
  booking_approval_timeout_hours?: number;
  // Portal / branding
  logo_url?: string | null;
  tagline?: string | null;
  address?: string | null;
  booking_instructions?: string | null;
  client_cancel_window_hours?: number;
  bookings_paused?: boolean;
}

interface SettingsResponse {
  name: string;
  timezone: string;
  slug: string;
  settings: BusinessSettings;
}

const DEFAULTS: Required<BusinessSettings> = {
  outreach_response_window_hours: 24,
  outreach_hours_start: '09:00',
  outreach_hours_end: '18:00',
  auto_pickup_interval_minutes: 5,
  escalation_keywords: [],
  booking_approval_timeout_hours: 2,
};

export function Settings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Form state
  const [bizName, setBizName] = useState('');
  const [bizTimezone, setBizTimezone] = useState('America/Los_Angeles');
  const [responseWindow, setResponseWindow] = useState(DEFAULTS.outreach_response_window_hours);
  const [hoursStart, setHoursStart] = useState(DEFAULTS.outreach_hours_start);
  const [hoursEnd, setHoursEnd] = useState(DEFAULTS.outreach_hours_end);
  const [pickupInterval, setPickupInterval] = useState(DEFAULTS.auto_pickup_interval_minutes);
  const [approvalTimeout, setApprovalTimeout] = useState(DEFAULTS.booking_approval_timeout_hours);
  const [keywordsInput, setKeywordsInput] = useState('');  // comma-separated string
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');

  // Portal / branding state
  const [bizSlug, setBizSlug] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [tagline, setTagline] = useState('');
  const [address, setAddress] = useState('');
  const [bookingInstructions, setBookingInstructions] = useState('');
  const [cancelWindow, setCancelWindow] = useState(24);
  const [bookingsPaused, setBookingsPaused] = useState(false);

  useEffect(() => {
    api.get<SettingsResponse>('/business/settings')
      .then(data => {
        const s = data.settings ?? {};
        setBizName(data.name);
        setBizTimezone(data.timezone ?? 'America/Los_Angeles');
        setBizSlug(data.slug ?? '');
        setResponseWindow(s.outreach_response_window_hours ?? DEFAULTS.outreach_response_window_hours);
        setHoursStart(s.outreach_hours_start ?? DEFAULTS.outreach_hours_start);
        setHoursEnd(s.outreach_hours_end ?? DEFAULTS.outreach_hours_end);
        setPickupInterval(s.auto_pickup_interval_minutes ?? DEFAULTS.auto_pickup_interval_minutes);
        setApprovalTimeout(s.booking_approval_timeout_hours ?? DEFAULTS.booking_approval_timeout_hours);
        setKeywords(s.escalation_keywords ?? DEFAULTS.escalation_keywords);
        setLogoUrl(s.logo_url ?? '');
        setTagline(s.tagline ?? '');
        setAddress(s.address ?? '');
        setBookingInstructions(s.booking_instructions ?? '');
        setCancelWindow(s.client_cancel_window_hours ?? 24);
        setBookingsPaused(s.bookings_paused ?? false);
        setLoading(false);
      })
      .catch(() => { setError('Failed to load settings.'); setLoading(false); });
  }, []);

  function addKeyword() {
    const kw = newKeyword.trim();
    if (!kw || keywords.includes(kw)) return;
    setKeywords(kws => [...kws, kw]);
    setNewKeyword('');
  }

  function removeKeyword(kw: string) {
    setKeywords(kws => kws.filter(k => k !== kw));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccessMsg('');
    try {
      await api.patch('/business/settings', {
        name: bizName.trim(),
        timezone: bizTimezone.trim(),
        slug: bizSlug.trim() || undefined,
        outreach_response_window_hours: responseWindow,
        outreach_hours_start: hoursStart,
        outreach_hours_end: hoursEnd,
        auto_pickup_interval_minutes: pickupInterval,
        booking_approval_timeout_hours: approvalTimeout,
        escalation_keywords: keywords,
        logo_url: logoUrl.trim() || null,
        tagline: tagline.trim() || null,
        address: address.trim() || null,
        booking_instructions: bookingInstructions.trim() || null,
        client_cancel_window_hours: cancelWindow,
        bookings_paused: bookingsPaused,
      });
      setSuccessMsg('Settings saved.');
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Failed to save settings.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p style={{ color: '#666' }}>Loading...</p>;

  return (
    <div style={{ maxWidth: 620 }}>
      <h1 style={{ marginBottom: 4 }}>Settings</h1>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 28 }}>Business-wide configuration for the AI scheduling engine.</p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

        {/* Business Name */}
        <Section title="Business">
          <Field label="Business name" hint="Displayed to clients in messages.">
            <input
              id="biz-name" name="biz-name"
              type="text" value={bizName} onChange={e => setBizName(e.target.value)}
              required maxLength={100} style={inputStyle}
            />
          </Field>
          <Field label="Timezone" hint="All appointment times are displayed to clients in this timezone.">
            <select
              id="biz-timezone" name="biz-timezone"
              value={bizTimezone} onChange={e => setBizTimezone(e.target.value)}
              style={inputStyle}
            >
              <option value="America/Los_Angeles">Pacific Time (PT)</option>
              <option value="America/Denver">Mountain Time (MT)</option>
              <option value="America/Chicago">Central Time (CT)</option>
              <option value="America/New_York">Eastern Time (ET)</option>
              <option value="America/Phoenix">Arizona (no DST)</option>
              <option value="America/Anchorage">Alaska Time (AKT)</option>
              <option value="Pacific/Honolulu">Hawaii Time (HT)</option>
              <option value="UTC">UTC</option>
            </select>
          </Field>
        </Section>

        {/* Client Booking Portal */}
        <Section title="Client Booking Portal">
          <Field label="Public URL slug" hint={`Clients book at: localhost:3002/${bizSlug || '…'}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#9ca3af', fontSize: 13 }}>localhost:3002/</span>
              <input
                id="biz-slug" name="biz-slug"
                type="text" value={bizSlug} onChange={e => setBizSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="my-salon" style={{ ...inputStyle, width: 180 }}
              />
            </div>
          </Field>
          <Field label="Pause bookings" hint="When on, clients see a 'not accepting bookings' message and cannot book.">
            <button
              id="pause-bookings" name="pause-bookings"
              type="button"
              onClick={() => setBookingsPaused(p => !p)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', borderRadius: 8, border: '1px solid',
                cursor: 'pointer', fontSize: 13, fontWeight: 600,
                background: bookingsPaused ? '#fee2e2' : '#f0fdf4',
                color: bookingsPaused ? '#b91c1c' : '#15803d',
                borderColor: bookingsPaused ? '#fca5a5' : '#86efac',
              }}
            >
              <span style={{ fontSize: 16 }}>{bookingsPaused ? '⏸' : '▶'}</span>
              {bookingsPaused ? 'Bookings paused — click to resume' : 'Bookings open — click to pause'}
            </button>
          </Field>
          <Field label="Cancel window" hint="How many hours before an appointment clients can cancel or reschedule. (1–168)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="cancel-window" name="cancel-window"
                type="number" value={cancelWindow} min={1} max={168}
                onChange={e => setCancelWindow(parseInt(e.target.value))}
                style={{ ...inputStyle, width: 100 }}
              />
              <span style={{ color: '#6b7280', fontSize: 14 }}>hours</span>
            </div>
          </Field>
          <Field label="Tagline" hint="Short description shown under business name on the booking page.">
            <input id="tagline" name="tagline" type="text" placeholder="e.g. Expert cuts, warm welcome" value={tagline} onChange={e => setTagline(e.target.value)} maxLength={200} style={inputStyle} />
          </Field>
          <Field label="Address" hint="Shown on the booking portal landing page.">
            <input id="address" name="address" type="text" placeholder="123 Main St, City, State" value={address} onChange={e => setAddress(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Logo URL" hint="Publicly accessible image URL for your logo (optional).">
            <input id="logo-url" name="logo-url" type="url" placeholder="https://…" value={logoUrl} onChange={e => setLogoUrl(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Booking instructions" hint="Message shown at the top of the booking page (optional).">
            <textarea
              id="booking-instructions" name="booking-instructions"
              value={bookingInstructions} onChange={e => setBookingInstructions(e.target.value)}
              placeholder="e.g. Please arrive 5 minutes early." rows={3} maxLength={500}
              style={{ ...inputStyle, resize: 'vertical' as const }}
            />
          </Field>
        </Section>

        {/* Outreach */}
        <Section title="Outreach">
          <Field label="Response window" hint="Hours the AI waits for a client reply before sending the next follow-up. (1–168 hours)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="response-window" name="response-window"
                type="number" value={responseWindow} min={1} max={168}
                onChange={e => setResponseWindow(parseInt(e.target.value))}
                style={{ ...inputStyle, width: 100 }}
              />
              <span style={{ color: '#6b7280', fontSize: 14 }}>hours</span>
            </div>
          </Field>

          <Field label="Outreach hours" hint="Window during which the AI is allowed to send messages to clients.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input id="hours-start" name="hours-start" type="time" value={hoursStart} onChange={e => setHoursStart(e.target.value)} style={{ ...inputStyle, width: 130 }} />
              <span style={{ color: '#6b7280' }}>to</span>
              <input id="hours-end" name="hours-end" type="time" value={hoursEnd} onChange={e => setHoursEnd(e.target.value)} style={{ ...inputStyle, width: 130 }} />
            </div>
          </Field>

          <Field label="Auto-pickup interval" hint="How often (in minutes) the system checks for conversations to resume. (1–60 min)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="pickup-interval" name="pickup-interval"
                type="number" value={pickupInterval} min={1} max={60}
                onChange={e => setPickupInterval(parseInt(e.target.value))}
                style={{ ...inputStyle, width: 100 }}
              />
              <span style={{ color: '#6b7280', fontSize: 14 }}>minutes</span>
            </div>
          </Field>
        </Section>

        {/* Booking Approval */}
        <Section title="Booking Approval">
          <Field label="Approval timeout" hint="Hours before an unanswered booking approval request is auto-cancelled. (1–48 hours)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="approval-timeout" name="approval-timeout"
                type="number" value={approvalTimeout} min={1} max={48}
                onChange={e => setApprovalTimeout(parseInt(e.target.value))}
                style={{ ...inputStyle, width: 100 }}
              />
              <span style={{ color: '#6b7280', fontSize: 14 }}>hours</span>
            </div>
          </Field>
        </Section>

        {/* Escalation Keywords */}
        <Section title="Escalation Keywords">
          <Field
            label="Keywords"
            hint="If a client message contains any of these words, the conversation is immediately escalated to staff."
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {keywords.length === 0 && (
                <span style={{ fontSize: 13, color: '#9ca3af' }}>No keywords set.</span>
              )}
              {keywords.map(kw => (
                <span key={kw} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '3px 10px', background: '#ede9fe', color: '#6d28d9',
                  borderRadius: 14, fontSize: 13, fontWeight: 500,
                }}>
                  {kw}
                  <button
                    type="button" onClick={() => removeKeyword(kw)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6d28d9', fontSize: 14, lineHeight: 1, padding: 0 }}
                  >×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="new-keyword" name="new-keyword"
                type="text"
                placeholder="Add keyword..."
                value={newKeyword}
                onChange={e => setNewKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
                style={{ ...inputStyle, width: 200 }}
              />
              <button type="button" onClick={addKeyword} style={secondaryBtn}>Add</button>
            </div>
          </Field>
        </Section>

        {/* Save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingTop: 8, borderTop: '1px solid #e5e7eb' }}>
          <button type="submit" disabled={saving} style={primaryBtn}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {successMsg && <span style={{ color: '#15803d', fontSize: 14, fontWeight: 500 }}>{successMsg}</span>}
          {error      && <span style={{ color: '#dc2626', fontSize: 14 }}>{error}</span>}
        </div>
      </form>
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb', padding: '10px 18px', fontWeight: 700, fontSize: 13, color: '#374151' }}>
        {title}
      </div>
      <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 3 }}>{label}</div>
        <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>{hint}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}

// ── shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 14, width: '100%', boxSizing: 'border-box',
};

const primaryBtn: React.CSSProperties = {
  padding: '9px 20px', background: '#0057ff', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600,
};

const secondaryBtn: React.CSSProperties = {
  padding: '8px 14px', background: '#f3f4f6', color: '#374151',
  border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 13,
};
