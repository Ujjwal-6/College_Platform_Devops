export const ROLES = ['student', 'organizer', 'faculty', 'hod', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  departmentId: string | null;
}

export interface ManagedUser extends User {
  isActive: boolean;
  createdAt: string;
}

export interface Department {
  id: string;
  name: string;
}
