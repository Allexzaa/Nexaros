'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '../lib/auth';

interface BusinessInfo {
  name: string;
  slug: string;
  bookingsPaused: boolean;
  pauseMessage?: string;
  timezone: string;
  tagline?: string | null;
  address?: string | null;
  bookingInstructions?: string | null;
  logoUrl?: string | null;
}

export default function LandingClient({ biz }: { biz: BusinessInfo }) {
  const { slug } = useParams<{ slug: string }>();
  const { client, logout, loading } = useAuth();

  if (biz.bookingsPaused) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-gray-900 mb-3">{biz.name}</h1>
          <p className="text-gray-600">{biz.pauseMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{biz.name}</h1>
            {biz.tagline && <p className="text-sm text-gray-500">{biz.tagline}</p>}
          </div>
          {!loading && (
            client ? (
              <div className="flex items-center gap-3">
                <Link href={`/${slug}/appointments`} className="text-sm text-blue-600 hover:underline">
                  My Appointments
                </Link>
                <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">
                  Log out
                </button>
              </div>
            ) : (
              <Link
                href={`/${slug}/login`}
                className="text-sm text-blue-600 hover:underline"
              >
                Log in
              </Link>
            )
          )}
        </div>
      </header>

      {/* Main */}
      <main className="max-w-2xl mx-auto px-4 py-10">
        {biz.address && (
          <p className="text-sm text-gray-500 mb-6">📍 {biz.address}</p>
        )}

        {biz.bookingInstructions && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 mb-8 text-sm text-blue-800">
            {biz.bookingInstructions}
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Book an Appointment</h2>
          <p className="text-gray-500 mb-8">Choose a time that works for you.</p>
          <Link
            href={`/${slug}/book`}
            className="inline-block bg-blue-600 text-white text-base font-semibold px-8 py-3 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Book Now →
          </Link>
        </div>
      </main>
    </div>
  );
}
