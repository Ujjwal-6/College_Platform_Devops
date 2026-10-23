export const ROLES = ['student', 'organizer', 'faculty', 'hod', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** The authenticated caller, loaded fresh from the database on every request. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  departmentId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
