import { useState, FormEvent } from 'react';
import { api, ApiError } from '../lib/api';

export function ForgotPassword() {
  const [email, setEmail]   = useState('');
  const [sent, setSent]     = useState(false);
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Something went wrong.');
    } finally { setLoading(false); }
  }

  return (
    <div style={{ maxWidth: 360, margin: '8rem auto', fontFamily: 'sans-serif' }}>
      <h2>Forgot password</h2>
      {sent
        ? <p>If an account exists for that email, a reset link has been sent.</p>
        : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <input type="email" placeholder="Your email" value={email} onChange={e => setEmail(e.target.value)} required disabled={loading} />
            {error && <p style={{ color: 'red', margin: 0 }}>{error}</p>}
            <button type="submit" disabled={loading}>{loading ? 'Sending…' : 'Send reset link'}</button>
          </form>
        )
      }
    </div>
  );
}
