import { redirect } from 'next/navigation';

export default async function Home() {
  try {
    const res = await fetch('http://localhost:3001/api/v1/public/business-slug', {
      cache: 'no-store',
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.slug) redirect(`/${data.slug}`);
    }
  } catch {}

  return (
    <div className="flex items-center justify-center min-h-screen text-zinc-500">
      No business found. Please check the backend is running.
    </div>
  );
}
