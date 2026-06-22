'use client';

import { useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';

export default function LoginPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const { login } = useAuth();

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function sendOTP(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.post('/client-auth/send-otp', { phone, businessSlug: slug });
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send code. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function verifyOTP(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await api.post<{ clientId: string; name: string }>(
        '/client-auth/verify-otp',
        { phone, businessSlug: slug, otp },
      );
      login(res.clientId, res.name);
      router.push(`/${slug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid code. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl border border-gray-200 p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          {step === 'phone' ? 'Enter your phone number' : 'Enter your code'}
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          {step === 'phone'
            ? "We'll send you a 6-digit code to verify your number."
            : `We sent a code to ${phone}. Enter it below.`}
        </p>

        {step === 'phone' ? (
          <form onSubmit={sendOTP} className="flex flex-col gap-4">
            <input
              id="phone"
              name="phone"
              type="tel"
              placeholder="(555) 000-0000"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              required
              disabled={loading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={loading || !phone.trim()}
              className="w-full bg-blue-600 text-white font-semibold py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Sending…' : 'Send Code'}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyOTP} className="flex flex-col gap-4">
            <input
              id="otp"
              name="otp"
              type="text"
              inputMode="numeric"
              placeholder="6-digit code"
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
              maxLength={6}
              disabled={loading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-base text-center tracking-widest text-2xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={loading || otp.length !== 6}
              className="w-full bg-blue-600 text-white font-semibold py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Verifying…' : 'Verify Code'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('phone'); setOtp(''); setError(''); }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Use a different number
            </button>
          </form>
        )}

        <div className="mt-6 pt-4 border-t border-gray-100 text-center">
          <a href={`/${slug}`} className="text-sm text-blue-600 hover:underline">
            ← Back to {slug}
          </a>
        </div>
      </div>
    </div>
  );
}
