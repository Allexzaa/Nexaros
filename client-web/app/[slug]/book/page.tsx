'use client';

import { useState, use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';

// ── types ─────────────────────────────────────────────────────────────────────

interface Slot {
  id: string;
  starts_at: string;
  service_type: string | null;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function generateICS(slot: Slot, businessName: string): string {
  const start = new Date(slot.starts_at);
  const end   = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour
  const fmt   = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AI Scheduler//EN',
    'BEGIN:VEVENT',
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${slot.service_type ?? 'Appointment'} at ${businessName}`,
    `DESCRIPTION:Your appointment at ${businessName}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function googleCalendarUrl(slot: Slot, businessName: string): string {
  const start = new Date(slot.starts_at);
  const end   = new Date(start.getTime() + 60 * 60 * 1000);
  const fmt   = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text:   `${slot.service_type ?? 'Appointment'} at ${businessName}`,
    dates:  `${fmt(start)}/${fmt(end)}`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

// ── step components ───────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: number }) {
  const steps = ['Date', 'Time', 'Confirm', 'Done'];
  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((label, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
            ${i + 1 === step ? 'bg-blue-600 text-white' :
              i + 1 < step  ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
            {i + 1 < step ? '✓' : i + 1}
          </div>
          <span className={`text-sm ${i + 1 === step ? 'font-semibold text-gray-900' : 'text-gray-400'}`}>
            {label}
          </span>
          {i < steps.length - 1 && <div className="w-6 h-px bg-gray-200" />}
        </div>
      ))}
    </div>
  );
}

// ── OTP inline modal ──────────────────────────────────────────────────────────

function OTPModal({ slug, onSuccess }: { slug: string; onSuccess: () => void }) {
  const { login } = useAuth();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function sendOTP(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.post('/client-auth/send-otp', { phone, businessSlug: slug });
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send code.');
    } finally { setLoading(false); }
  }

  async function verifyOTP(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await api.post<{ clientId: string; name: string }>(
        '/client-auth/verify-otp', { phone, businessSlug: slug, otp },
      );
      login(res.clientId, res.name);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid code.');
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
        <h2 className="text-lg font-bold text-gray-900 mb-1">Verify your number</h2>
        <p className="text-sm text-gray-500 mb-5">
          {step === 'phone' ? "We'll confirm your booking once we verify your phone." : `Enter the code sent to ${phone}.`}
        </p>
        {step === 'phone' ? (
          <form onSubmit={sendOTP} className="flex flex-col gap-3">
            <input id="otp-phone" name="otp-phone" type="tel" placeholder="(555) 000-0000"
              value={phone} onChange={e => setPhone(e.target.value)} required disabled={loading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <button type="submit" disabled={loading || !phone.trim()}
              className="w-full bg-blue-600 text-white font-semibold py-3 rounded-lg disabled:opacity-50">
              {loading ? 'Sending…' : 'Send Code'}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyOTP} className="flex flex-col gap-3">
            <input id="otp-code" name="otp-code" type="text" inputMode="numeric"
              placeholder="6-digit code" value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required maxLength={6} disabled={loading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-center text-2xl tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <button type="submit" disabled={loading || otp.length !== 6}
              className="w-full bg-blue-600 text-white font-semibold py-3 rounded-lg disabled:opacity-50">
              {loading ? 'Verifying…' : 'Confirm Booking'}
            </button>
            <button type="button" onClick={() => { setStep('phone'); setOtp(''); setError(''); }}
              className="text-sm text-gray-500">Use a different number</button>
          </form>
        )}
      </div>
    </div>
  );
}

// ── main booking page ─────────────────────────────────────────────────────────

export default function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const { client } = useAuth();

  // Step 1 — pick a date
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [datesLoading, setDatesLoading] = useState(true);

  // Step 2 — pick a time slot
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);

  // Waitlist
  const [waitlisted, setWaitlisted] = useState(false);
  const [waitlisting, setWaitlisting] = useState(false);

  // Step 3 — confirm
  const [showOTP, setShowOTP] = useState(false);
  const [booking, setBooking] = useState(false);
  const [bookingError, setBookingError] = useState('');

  // Step 4 — done
  const [bookedSlot, setBookedSlot] = useState<Slot | null>(null);
  const [businessName, setBusinessName] = useState('');

  const step = bookedSlot ? 4 : selectedSlot ? 3 : selectedDate ? 2 : 1;

  // Load business name + available dates on mount
  useEffect(() => {
    async function load() {
      const [biz, datesRes] = await Promise.all([
        fetch(`/api/v1/public/business/${slug}`, { cache: 'no-store' }).then(r => r.json()),
        api.get<{ dates: string[] }>(`/public/available-dates?businessSlug=${slug}`),
      ]);
      setBusinessName(biz.name ?? slug);
      setAvailableDates(datesRes.dates);
      setDatesLoading(false);
    }
    load().catch(() => setDatesLoading(false));
  }, [slug]);

  // Load slots when date is selected
  useEffect(() => {
    if (!selectedDate) return;
    setSlotsLoading(true);
    api.get<{ slots: Slot[] }>(`/public/slots?businessSlug=${slug}&date=${selectedDate}`)
      .then(r => { setSlots(r.slots); setSlotsLoading(false); })
      .catch(() => setSlotsLoading(false));
  }, [selectedDate, slug]);

  async function confirmBooking() {
    if (!selectedSlot) return;
    if (!client) { setShowOTP(true); return; }
    await doBook();
  }

  async function doBook() {
    if (!selectedSlot) return;
    setBooking(true); setBookingError('');
    try {
      await api.post('/client/appointments', { slotId: selectedSlot.id });
      setBookedSlot(selectedSlot);
    } catch (err) {
      setBookingError(err instanceof ApiError ? err.message : 'Booking failed. Try again.');
    } finally {
      setBooking(false);
    }
  }

  function downloadICS() {
    if (!bookedSlot) return;
    const blob = new Blob([generateICS(bookedSlot, businessName)], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'appointment.ics';
    a.click();
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          <button onClick={() => router.push(`/${slug}`)} className="text-gray-400 hover:text-gray-600 text-xl">←</button>
          <h1 className="font-bold text-gray-900">{businessName || 'Book an Appointment'}</h1>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-8">
        <StepIndicator step={step} />

        {/* ── STEP 1: Pick a date ── */}
        {step === 1 && (
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-1">Choose a date</h2>
            <p className="text-sm text-gray-500 mb-6">Only dates with available slots are shown.</p>
            {datesLoading ? (
              <p className="text-gray-400">Loading available dates…</p>
            ) : availableDates.length === 0 ? (
              <div className="text-center py-10 text-gray-500">
                <p className="text-4xl mb-3">📅</p>
                <p className="font-semibold">No available dates</p>
                <p className="text-sm mt-1">Check back soon or contact us directly.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {availableDates.map(d => (
                  <button key={d} onClick={() => setSelectedDate(d)}
                    className="w-full text-left px-5 py-4 bg-white border border-gray-200 rounded-xl hover:border-blue-400 hover:bg-blue-50 transition-colors font-medium text-gray-900">
                    {fmtDate(d)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── STEP 2: Pick a time ── */}
        {step === 2 && (
          <div>
            <button onClick={() => { setSelectedDate(''); setSlots([]); }}
              className="text-sm text-blue-600 mb-4 hover:underline">← Back to dates</button>
            <h2 className="text-xl font-bold text-gray-900 mb-1">Choose a time</h2>
            <p className="text-sm text-gray-500 mb-6">{fmtDate(selectedDate)}</p>
            {slotsLoading ? (
              <p className="text-gray-400">Loading times…</p>
            ) : slots.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-4xl mb-3">😕</p>
                <p className="font-semibold text-gray-900 mb-1">No times available for this date</p>
                <p className="text-sm text-gray-500 mb-5">You can join the waitlist and we'll reach out when something opens up.</p>
                {waitlisted ? (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-green-700 text-sm font-medium">
                    ✓ You're on the waitlist! We'll text you when a slot opens.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={async () => {
                        if (!client) { setShowOTP(true); return; }
                        setWaitlisting(true);
                        try {
                          await api.post('/client/waitlist', { preferences: selectedDate });
                          setWaitlisted(true);
                        } catch { /* ignore */ } finally { setWaitlisting(false); }
                      }}
                      disabled={waitlisting}
                      className="w-full bg-blue-600 text-white font-semibold py-3 rounded-xl disabled:opacity-50 hover:bg-blue-700">
                      {waitlisting ? 'Joining…' : 'Join Waitlist for This Date'}
                    </button>
                    <button onClick={() => { setSelectedDate(''); setSlots([]); }}
                      className="text-sm text-blue-600 hover:underline">Choose another date</button>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {slots.map(slot => (
                  <button key={slot.id} onClick={() => setSelectedSlot(slot)}
                    className="px-4 py-4 bg-white border border-gray-200 rounded-xl hover:border-blue-400 hover:bg-blue-50 transition-colors text-center">
                    <div className="font-bold text-gray-900 text-lg">{fmtTime(slot.starts_at)}</div>
                    {slot.service_type && (
                      <div className="text-xs text-gray-500 mt-0.5">{slot.service_type}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── STEP 3: Confirm ── */}
        {step === 3 && selectedSlot && (
          <div>
            <button onClick={() => setSelectedSlot(null)}
              className="text-sm text-blue-600 mb-4 hover:underline">← Back to times</button>
            <h2 className="text-xl font-bold text-gray-900 mb-6">Confirm your booking</h2>

            <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
              <div className="flex flex-col gap-3">
                <Row label="Date"    value={fmtDate(selectedDate)} />
                <Row label="Time"    value={fmtTime(selectedSlot.starts_at)} />
                {selectedSlot.service_type && <Row label="Service" value={selectedSlot.service_type} />}
                <Row label="Location" value={businessName} />
              </div>
            </div>

            {bookingError && (
              <p className="text-red-600 text-sm mb-4">{bookingError}</p>
            )}

            <button onClick={confirmBooking} disabled={booking}
              className="w-full bg-blue-600 text-white font-semibold py-4 rounded-xl text-base hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {booking ? 'Booking…' : client ? 'Confirm Booking' : 'Verify & Confirm'}
            </button>

            {!client && (
              <p className="text-center text-xs text-gray-400 mt-3">
                We'll ask you to verify your phone number to complete the booking.
              </p>
            )}
          </div>
        )}

        {/* ── STEP 4: Confirmation ── */}
        {step === 4 && bookedSlot && (
          <div className="text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">You're booked!</h2>
            <p className="text-gray-500 mb-6">
              {bookedSlot.service_type ?? 'Your appointment'} on {fmtDate(selectedDate)} at {fmtTime(bookedSlot.starts_at)}
            </p>

            <div className="flex flex-col gap-3 mb-8">
              <button onClick={downloadICS}
                className="w-full bg-white border border-gray-300 text-gray-700 font-semibold py-3 rounded-xl hover:bg-gray-50 transition-colors">
                📥 Download .ics (Any Calendar)
              </button>
              <a href={googleCalendarUrl(bookedSlot, businessName)} target="_blank" rel="noopener noreferrer"
                className="w-full bg-white border border-gray-300 text-gray-700 font-semibold py-3 rounded-xl hover:bg-gray-50 transition-colors flex items-center justify-center gap-2">
                <span>📅</span> Add to Google Calendar
              </a>
            </div>

            <button onClick={() => router.push(`/${slug}/appointments`)}
              className="text-blue-600 text-sm hover:underline">
              View My Appointments →
            </button>
          </div>
        )}
      </main>

      {/* OTP modal */}
      {showOTP && (
        <OTPModal slug={slug} onSuccess={() => { setShowOTP(false); doBook(); }} />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value}</span>
    </div>
  );
}
