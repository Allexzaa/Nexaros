import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../lib/api';

interface LoginResponse {
  accessToken: string;
}

interface MeResponse {
  id: string;
  email: string;
  role: 'admin' | 'staff' | 'viewer';
  canTriggerOutreach: boolean;
  canEditSchedule: boolean;
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { accessToken } = await api.post<LoginResponse>('/auth/login', { email, password });
      // Fetch full user profile with the new token
      const me = await api.getWithToken<MeResponse>('/auth/me', accessToken);
      login({ id: me.id, email: me.email, role: me.role, canTriggerOutreach: me.canTriggerOutreach, canEditSchedule: me.canEditSchedule }, accessToken);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.code === 'INVALID_CREDENTIALS' ? 'Invalid email or password.' : err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '8rem auto', fontFamily: 'sans-serif' }}>
      <h2>Staff Login</h2>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required disabled={loading} />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required disabled={loading} />
        {error && <p style={{ color: 'red', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <button
        type="button"
        style={{ marginTop: '1rem', width: '100%' }}
        onClick={() => { window.location.href = '/api/v1/auth/google'; }}
      >
        Sign in with Google
      </button>
      <p style={{ textAlign: 'center', marginTop: '1rem' }}>
        <a href="/forgot-password">Forgot password?</a>
      </p>
    </div>
  );
}
