import { useEffect, useState, ReactNode } from 'react';

const BREAKPOINT = 768;

export function DesktopGuard({ children }: { children: ReactNode }) {
  const [isTooNarrow, setIsTooNarrow] = useState(window.innerWidth < BREAKPOINT);

  useEffect(() => {
    const handler = () => setIsTooNarrow(window.innerWidth < BREAKPOINT);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  if (isTooNarrow) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif' }}>
        <h2>Please use a desktop browser for the best experience.</h2>
        <p>The staff portal is optimised for screens wider than 768px.</p>
      </div>
    );
  }

  return <>{children}</>;
}
