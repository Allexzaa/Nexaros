import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Dev-only bypass — lets us explore the UI without a real auth backend.
// Removed or blocked in production builds.
export function DevLogin() {
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (import.meta.env.PROD) { navigate('/login'); return; }
    login(
      { id: 'dev-staff-1', email: 'admin@test.com', role: 'admin', canTriggerOutreach: true, canEditSchedule: true },
      'dev-token',
    );
    navigate('/');
  }, [login, navigate]);

  return <p>Logging in as dev admin…</p>;
}
