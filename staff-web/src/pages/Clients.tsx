import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

interface Client {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  app_registered: boolean;
  opted_out: boolean;
  created_at: string;
}

export function Clients() {
  const navigate = useNavigate();
  const [clients, setClients] = useState<Client[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const url = query ? `/clients?search=${encodeURIComponent(query)}&limit=50` : '/clients?limit=50';
    api.get<{ data: Client[] }>(url)
      .then(r => setClients(r.data))
      .catch(() => setError('Failed to load clients.'))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => { load(); }, [load]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setQuery(search.trim());
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Clients</h1>
        <span style={{ color: '#9ca3af', fontSize: 14 }}>{clients.length} shown</span>
      </div>

      <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          id="client-search" name="client-search"
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 360, padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 }}
        />
        <button type="submit" style={{ padding: '7px 16px', background: '#0057ff', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}>
          Search
        </button>
        {query && (
          <button type="button" onClick={() => { setSearch(''); setQuery(''); }} style={{ padding: '7px 12px', background: '#f3f4f6', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}>
            Clear
          </button>
        )}
      </form>

      {loading && <p style={{ color: '#666' }}>Loading...</p>}
      {error   && <p style={{ color: '#dc2626' }}>{error}</p>}

      {!loading && !error && clients.length === 0 && (
        <p style={{ color: '#666' }}>No clients found.</p>
      )}

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        {clients.map((client, i) => (
          <div
            key={client.id}
            onClick={() => navigate(`/clients/${client.id}`)}
            style={{
              display: 'flex', alignItems: 'center', gap: 16,
              padding: '13px 18px', cursor: 'pointer', background: '#fff',
              borderTop: i > 0 ? '1px solid #f3f4f6' : 'none',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
            onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
          >
            <div style={{
              width: 36, height: 36, borderRadius: '50%', background: '#e0e7ff',
              color: '#4f46e5', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: 15, flexShrink: 0,
            }}>
              {client.name.charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{client.name}</div>
              <div style={{ color: '#6b7280', fontSize: 13, marginTop: 1 }}>
                {[client.phone, client.email].filter(Boolean).join(' · ') || 'No contact info'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {client.opted_out && (
                <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: '#fee2e2', color: '#b91c1c' }}>
                  Opted Out
                </span>
              )}
              {client.app_registered && (
                <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: '#dcfce7', color: '#15803d' }}>
                  App
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
