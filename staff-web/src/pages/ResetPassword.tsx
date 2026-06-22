import { useState, FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_TOKEN: 'This reset link is invalid.',
  TOKEN_EXPIRED: 'This reset link has expired. Please request a new one.',
};

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token   = params.get('token') ?? '';
  const staffId = params.get('id')    ?? '';

  const [password, setPassword]   = useState('');
  const [confirm, setConfirm]     = useState('');
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);
  const [done, setDone]           = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8)  { setError('Password must be at least 8 characters.'); return; }
    setError(''); setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, staffId, password });
      setDone(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      if (err instanceof ApiError) setError(ERROR_MESSAGES[err.code] ?? err.message);
      else setError('Something went wrong.');
    } finally { setLoading(false); }
  }

  if (!token || !staffId) return <p style={{ padding: '2rem' }}>Invalid reset link.</p>;

  return (
    <div style={{ maxWidth: 360, margin: '8rem auto', fontFamily: 'sans-serif' }}>
      <h2>Set new password</h2>
      {done
        ? <p style={{ color: 'green' }}>Password updated! Redirecting to login…</p>
        : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <input type="password" placeholder="New password (min 8 chars)" value={password} onChange={e => setPassword(e.target.value)} required disabled={loading} />
            <input type="password" placeholder="Confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} required disabled={loading} />
            {error && <p style={{ color: 'red', margin: 0 }}>{error}</p>}
            <button type="submit" disabled={loading}>{loading ? 'Saving…' : 'Set new password'}</button>
          </form>
        )
      }
    </div>
  );
}
