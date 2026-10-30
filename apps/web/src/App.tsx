import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { useDocumentTitle } from './lib/useDocumentTitle';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminAudit } from './pages/AdminAudit';
import { AdminCertificateDesign } from './pages/AdminCertificateDesign';
import { AdminJobs } from './pages/AdminJobs';
import { AdminUsers } from './pages/AdminUsers';
import { Analytics } from './pages/Analytics';
import { BookingDetailPage } from './pages/BookingDetail';
import { BookingForm } from './pages/BookingForm';
import { Bookings } from './pages/Bookings';
import { Calendar } from './pages/Calendar';
import { CheckIn } from './pages/CheckIn';
import { CheckInEvents } from './pages/CheckInEvents';
import { Dashboard } from './pages/Dashboard';
import { EventDetailPage } from './pages/EventDetail';
import { EventForm } from './pages/EventForm';
import { Events } from './pages/Events';
import { Halls } from './pages/Halls';
import { Resources } from './pages/Resources';
import { ForgotPassword } from './pages/ForgotPassword';
import { Login } from './pages/Login';
import { ResetPassword } from './pages/ResetPassword';
import { MyCertificates } from './pages/MyCertificates';
import { VerifyCertificate } from './pages/VerifyCertificate';
import { MyRegistrations } from './pages/MyRegistrations';

export function App() {
  const { status, user, signOut, hasRole } = useAuth();
  useDocumentTitle();
  return (
    <>
      {status === 'authenticated' && (
        <header className="topbar">
          <Link to="/" className="brand" aria-label="College Events home">
            <span className="brand-mark" aria-hidden="true">
              CE
            </span>
            College Events
          </Link>
          <nav aria-label="Main">
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/events">Events</NavLink>
            {hasRole('faculty', 'hod', 'admin') && <NavLink to="/approvals">Approvals</NavLink>}
            <NavLink to="/halls">Halls</NavLink>
            <NavLink to="/resources">Resources</NavLink>
            {hasRole('organizer', 'faculty', 'hod', 'admin') && (
              <NavLink to="/bookings">Bookings</NavLink>
            )}
            <NavLink to="/my-registrations">My registrations</NavLink>
            <NavLink to="/check-in">Check-in</NavLink>
            <NavLink to="/certificates">Certificates</NavLink>
            <NavLink to="/calendar">Calendar</NavLink>
            {hasRole('admin', 'hod') && <NavLink to="/analytics">Analytics</NavLink>}
            {hasRole('admin', 'hod') && <NavLink to="/users">Users</NavLink>}
            {hasRole('admin') && <NavLink to="/admin/audit">Audit log</NavLink>}
            {hasRole('admin') && <NavLink to="/admin/jobs">Jobs</NavLink>}
            {hasRole('admin') && (
              <NavLink to="/admin/certificate-design">Certificate design</NavLink>
            )}
          </nav>
          <span className="topbar-user">
            {user?.name} <button onClick={() => void signOut()}>Sign out</button>
          </span>
        </header>
      )}
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/users"
          element={
            <ProtectedRoute roles={['admin', 'hod']}>
              <AdminUsers />
            </ProtectedRoute>
          }
        />
        <Route
          path="/analytics"
          element={
            <ProtectedRoute roles={['admin', 'hod']}>
              <Analytics />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminAudit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/certificate-design"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminCertificateDesign />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/jobs"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminJobs />
            </ProtectedRoute>
          }
        />
        <Route path="/verify" element={<VerifyCertificate />} />
        <Route path="/verify/:code" element={<VerifyCertificate />} />
        <Route
          path="/certificates"
          element={
            <ProtectedRoute>
              <MyCertificates />
            </ProtectedRoute>
          }
        />
        <Route
          path="/check-in"
          element={
            <ProtectedRoute>
              <CheckInEvents />
            </ProtectedRoute>
          }
        />
        <Route
          path="/events/:id/check-in"
          element={
            <ProtectedRoute>
              <CheckIn />
            </ProtectedRoute>
          }
        />
        <Route
          path="/my-registrations"
          element={
            <ProtectedRoute>
              <MyRegistrations />
            </ProtectedRoute>
          }
        />
        <Route
          path="/events"
          element={
            <ProtectedRoute>
              <Events />
            </ProtectedRoute>
          }
        />
        <Route
          path="/events/new"
          element={
            <ProtectedRoute roles={['organizer', 'faculty', 'hod', 'admin']}>
              <EventForm />
            </ProtectedRoute>
          }
        />
        <Route
          path="/events/:id"
          element={
            <ProtectedRoute>
              <EventDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/events/:id/edit"
          element={
            <ProtectedRoute roles={['organizer', 'faculty', 'hod', 'admin']}>
              <EventForm />
            </ProtectedRoute>
          }
        />
        <Route
          path="/approvals"
          element={
            <ProtectedRoute roles={['faculty', 'hod', 'admin']}>
              <Events initialScope="approvals" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/calendar"
          element={
            <ProtectedRoute>
              <Calendar />
            </ProtectedRoute>
          }
        />
        <Route
          path="/halls"
          element={
            <ProtectedRoute>
              <Halls />
            </ProtectedRoute>
          }
        />
        <Route
          path="/resources"
          element={
            <ProtectedRoute>
              <Resources />
            </ProtectedRoute>
          }
        />
        <Route
          path="/bookings"
          element={
            <ProtectedRoute roles={['organizer', 'faculty', 'hod', 'admin']}>
              <Bookings />
            </ProtectedRoute>
          }
        />
        <Route
          path="/bookings/:id"
          element={
            <ProtectedRoute roles={['organizer', 'faculty', 'hod', 'admin']}>
              <BookingDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/bookings/:id/edit"
          element={
            <ProtectedRoute roles={['organizer', 'admin']}>
              <BookingForm />
            </ProtectedRoute>
          }
        />
        <Route
          path="/events/:eventId/book"
          element={
            <ProtectedRoute roles={['organizer', 'admin']}>
              <BookingForm />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
