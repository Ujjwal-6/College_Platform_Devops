import { useAuth } from '../auth/AuthContext';

export function Dashboard() {
  const { user } = useAuth();
  return (
    <section className="card">
      <h1>Welcome, {user?.name}</h1>
      <p>Signed in as {user?.email}</p>
      <p>Roles: {user?.roles.join(', ')}</p>
      <p className="muted">Event features will appear here as they are built.</p>
    </section>
  );
}
