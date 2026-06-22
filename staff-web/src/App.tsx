import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { DesktopGuard } from './components/DesktopGuard';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { DevLogin } from './pages/DevLogin';
import { AuthCallback } from './pages/AuthCallback';
import { AcceptInvite } from './pages/AcceptInvite';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { Dashboard } from './pages/Dashboard';
import { ScheduleCalendar } from './pages/ScheduleCalendar';
import { ScheduleDetail } from './pages/ScheduleDetail';
import { ConversationView } from './pages/ConversationView';
import { Clients } from './pages/Clients';
import { ClientDetail } from './pages/ClientDetail';
import { Settings } from './pages/Settings';
import { StaffManagement } from './pages/StaffManagement';
import { ApproveBooking } from './pages/ApproveBooking';

export default function App() {
  return (
    <AuthProvider>
      <DesktopGuard>
        <BrowserRouter>
          <Routes>
            {/* Public */}
            <Route path="/login" element={<Login />} />
            <Route path="/dev-login" element={<DevLogin />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />

            {/* Protected — all under Layout */}
            <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
              <Route index element={<Dashboard />} />
              <Route path="schedules" element={<ScheduleCalendar />} />
              <Route path="schedules/:id" element={<ScheduleDetail />} />
              <Route path="conversations/:id" element={<ConversationView />} />
              <Route path="clients" element={<Clients />} />
              <Route path="clients/:id" element={<ClientDetail />} />
              <Route path="bookings/pending" element={<ApproveBooking />} />

              {/* Admin-only */}
              <Route path="settings" element={<ProtectedRoute requireAdmin><Settings /></ProtectedRoute>} />
              <Route path="staff" element={<ProtectedRoute requireAdmin><StaffManagement /></ProtectedRoute>} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </DesktopGuard>
    </AuthProvider>
  );
}
