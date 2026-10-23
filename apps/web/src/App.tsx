import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminUsers } from './pages/AdminUsers';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';

export function App() {
  const { status, user, signOut, hasRole } = useAuth();
  return (
    <>
      {status === 'authenticated' && (
        <header className="topbar">
          <nav aria-label="Main">
            <Link to="/">Dashboard</Link>
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
