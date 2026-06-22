import { notFound } from 'next/navigation';
import LandingClient from './LandingClient';

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

async function getBusiness(slug: string): Promise<BusinessInfo | null> {
  try {
    const res = await fetch(
      `http://localhost:3001/api/v1/public/business/${slug}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function SlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const biz = await getBusiness(slug);
  if (!biz) notFound();
  return <LandingClient biz={biz} />;
}
