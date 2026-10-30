import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import type { Role } from '../api/types';
import { useAuth } from './AuthContext';

/**
 * Keeps signed-out visitors out and hides pages the user's roles do not cover.
 * This is a convenience only: the API enforces every permission on the server.
 */
export function ProtectedRoute({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { status, hasRole } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <p role="status">Loading…</p>;
  if (status === 'anonymous')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !hasRole(...roles)) {
    return (
      <section className="card">
        <h1>No access</h1>
        <p role="alert">You do not have access to this page.</p>
        <p>
          <Link className="button" to="/">
            Go to the dashboard
          </Link>
        </p>
      </section>
    );
  }
  return <>{children}</>;
}
