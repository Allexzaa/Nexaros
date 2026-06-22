'use client';

import { AuthProvider } from '../lib/auth';
import { use } from 'react';

export default function SlugLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  return <AuthProvider slug={slug}>{children}</AuthProvider>;
}
