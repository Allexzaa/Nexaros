import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV_ITEMS = [
  { to: '/',                  label: 'Dashboard',        adminOnly: false },
  { to: '/schedules',         label: 'Schedules',        adminOnly: false },
  { to: '/conversations',     label: 'Conversations',    adminOnly: false },
  { to: '/clients',           label: 'Clients',          adminOnly: false },
  { to: '/bookings/pending',  label: 'Approve Bookings', adminOnly: false },
  { to: '/settings',          label: 'Settings',         adminOnly: true  },
  { to: '/staff',             label: 'Staff',            adminOnly: true  },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      <nav style={{ width: 200, borderRight: '1px solid #ddd', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <strong style={{ marginBottom: '1rem' }}>AI Scheduler</strong>
        {NAV_ITEMS.filter(item => !item.adminOnly || user?.role === 'admin').map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            style={({ isActive }) => ({
              padding: '0.4rem 0.6rem',
              borderRadius: 4,
              textDecoration: 'none',
              color: isActive ? '#fff' : '#333',
              background: isActive ? '#0057ff' : 'transparent',
            })}
          >
            {item.label}
          </NavLink>
        ))}
        <div style={{ marginTop: 'auto', fontSize: 12, color: '#666' }}>
          <div>{user?.email}</div>
          <div style={{ textTransform: 'capitalize' }}>{user?.role}</div>
          <button onClick={handleLogout} style={{ marginTop: 8, cursor: 'pointer' }}>Log out</button>
        </div>
      </nav>
      <main style={{ flex: 1, padding: '2rem', overflowY: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}
