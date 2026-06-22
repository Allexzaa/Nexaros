import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../lib/api';

// Handles the Google SSO redirect — token arrives in the URL fragment (#token=...)
export function AuthCallback() {
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    const params = new URLSearchParams(fragment);
    const token = params.get('token');

    if (!token) { navigate('/login?error=google_failed'); return; }

    api.getWithToken<{ id: string; email: string; role: 'admin' | 'staff' | 'viewer'; canTriggerOutreach: boolean; canEditSchedule: boolean }>('/auth/me', token)
      .then(me => {
        login({ id: me.id, email: me.email, role: me.role, canTriggerOutreach: me.canTriggerOutreach, canEditSchedule: me.canEditSchedule }, token);
        navigate('/');
      })
      .catch(() => navigate('/login?error=google_failed'));
  }, [login, navigate]);

  return <p style={{ padding: '2rem' }}>Completing sign-in…</p>;
}
