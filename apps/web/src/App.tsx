import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminUsers } from './pages/AdminUsers';
import { Calendar } from './pages/Calendar';
import { Dashboard } from './pages/Dashboard';
import { EventDetailPage } from './pages/EventDetail';
import { EventForm } from './pages/EventForm';
import { Events } from './pages/Events';
import { Login } from './pages/Login';

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
            <Link to="/calendar">Calendar</Link>
            {hasRole('admin', 'hod') && <Link to="/users">Users</Link>}
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
