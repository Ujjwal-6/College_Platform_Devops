import type { ApprovalLevel, EventStatus } from '../api/types';

const LABEL: Record<EventStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  published: 'Published',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
const LEVEL: Record<ApprovalLevel, string> = { faculty: 'Faculty', hod: 'HOD', admin: 'Admin' };

export function StatusBadge({
  status,
  level,
}: {
  status: EventStatus;
  level?: ApprovalLevel | null;
}) {
  return (
    <span className={`badge badge-${status}`}>
      {LABEL[status]}
      {status === 'pending_approval' && level ? `: awaiting ${LEVEL[level]}` : ''}
    </span>
  );
}

export const levelLabel = (l: ApprovalLevel) => LEVEL[l];
