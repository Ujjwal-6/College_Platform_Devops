import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminAudit } from './pages/AdminAudit';
import { AdminJobs } from './pages/AdminJobs';
import { AdminUsers } from './pages/AdminUsers';
import { BookingDetailPage } from './pages/BookingDetail';
import { BookingForm } from './pages/BookingForm';
import { Bookings } from './pages/Bookings';
import { Calendar } from './pages/Calendar';
import { Dashboard } from './pages/Dashboard';
import { EventDetailPage } from './pages/EventDetail';
import { EventForm } from './pages/EventForm';
import { Events } from './pages/Events';
import { Halls } from './pages/Halls';
import { Resources } from './pages/Resources';
import { Login } from './pages/Login';
import { MyRegistrations } from './pages/MyRegistrations';

export function App() {
  const { status, user, signOut, hasRole } = useAuth();
  return (
    <>
      {status === 'authenticated' && (
        <header className="topbar">
          <nav aria-label="Main">
            <Link to="/">Dashboard</Link>
            <Link to="/events">Events</Link>
            {hasRole('faculty', 'hod', 'admin') && <Link to="/approvals">Approvals</Link>}
            <Link to="/halls">Halls</Link>
            <Link to="/resources">Resources</Link>
            {hasRole('organizer', 'faculty', 'hod', 'admin') && (
              <Link to="/bookings">Bookings</Link>
            )}
            <Link to="/my-registrations">My registrations</Link>
            <Link to="/calendar">Calendar</Link>
            {hasRole('admin', 'hod') && <Link to="/users">Users</Link>}
            {hasRole('admin') && <Link to="/admin/audit">Audit log</Link>}
            {hasRole('admin') && <Link to="/admin/jobs">Jobs</Link>}
          </nav>
          <span>
            {user?.name} <button onClick={() => void signOut()}>Sign out</button>
          </span>
        </header>
      )}
      <Routes>
        <Route path="/login" element={<Login />} />
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
          path="/admin/audit"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminAudit />
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
