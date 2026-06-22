'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';

interface Appointment {
  id: string;
  starts_at: string;
  service_type: string | null;
  status: string;
}

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  confirmed:  { label: 'Confirmed',  className: 'bg-green-100 text-green-700' },
  cancelled:  { label: 'Cancelled',  className: 'bg-red-100 text-red-600' },
  'no-response': { label: 'No Response', className: 'bg-gray-100 text-gray-500' },
  'ai-active':   { label: 'Pending',     className: 'bg-blue-100 text-blue-600' },
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default function AppointmentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const { client, loading: authLoading } = useAuth();

  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState('');

  useEffect(() => {
    if (authLoading) return;
    if (!client) { router.push(`/${slug}/login`); return; }
    setLoading(true);
    api.get<{ data: Appointment[] }>(`/client/appointments?status=${tab}`)
      .then(r => { setAppointments(r.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [tab, client, authLoading, slug, router]);

  async function cancel(id: string) {
    if (!window.confirm('Cancel this appointment?')) return;
    setCancelling(id);
    try {
      await api.patch(`/client/appointments/${id}/cancel`, {});
      setAppointments(prev => prev.filter(a => a.id !== id));
      setActionMsg(m => ({ ...m, [id]: 'Appointment cancelled.' }));
    } catch (err) {
      setActionMsg(m => ({
        ...m, [id]: err instanceof ApiError ? err.message : 'Could not cancel.',
      }));
    } finally { setCancelling(''); }
  }

  const now = new Date();

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push(`/${slug}`)} className="text-gray-400 hover:text-gray-600 text-xl">←</button>
            <h1 className="font-bold text-gray-900">My Appointments</h1>
          </div>
          <a href={`/${slug}/book`} className="text-sm text-blue-600 hover:underline font-medium">+ Book new</a>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex border-b border-gray-200 mb-6">
          {(['upcoming', 'past'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-2.5 text-sm font-semibold capitalize transition-colors
                ${tab === t ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-gray-400 text-center py-10">Loading…</p>
        ) : appointments.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p className="text-4xl mb-3">{tab === 'upcoming' ? '📅' : '🕐'}</p>
            <p className="font-semibold">No {tab} appointments</p>
            {tab === 'upcoming' && (
              <a href={`/${slug}/book`} className="mt-3 inline-block text-blue-600 text-sm hover:underline">
                Book one now →
              </a>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {appointments.map(appt => {
              const apptDate = new Date(appt.starts_at);
              const hoursUntil = (apptDate.getTime() - now.getTime()) / 3600000;
              const canCancel = appt.status === 'confirmed' && hoursUntil > 24;
              const s = STATUS_STYLE[appt.status] ?? { label: appt.status, className: 'bg-gray-100 text-gray-500' };

              return (
                <div key={appt.id} className="bg-white border border-gray-200 rounded-xl p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="font-semibold text-gray-900">
                        {appt.service_type ?? 'Appointment'}
                      </p>
                      <p className="text-sm text-gray-500 mt-0.5">{fmtDateTime(appt.starts_at)}</p>
                    </div>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${s.className}`}>
                      {s.label}
                    </span>
                  </div>

                  {actionMsg[appt.id] && (
                    <p className="text-sm text-gray-500 mb-2">{actionMsg[appt.id]}</p>
                  )}

                  {canCancel && (
                    <div className="flex gap-2 pt-3 border-t border-gray-100">
                      <a href={`/${slug}/book`}
                        className="flex-1 text-center text-sm font-semibold py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
                        Reschedule
                      </a>
                      <button onClick={() => cancel(appt.id)} disabled={cancelling === appt.id}
                        className="flex-1 text-sm font-semibold py-2 border border-red-200 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-50">
                        {cancelling === appt.id ? 'Cancelling…' : 'Cancel'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
