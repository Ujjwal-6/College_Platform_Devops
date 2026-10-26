import type { BookingLevel, BookingStatus } from '../api/types';

const LABEL: Record<BookingStatus, string> = {
  pending: 'Pending approval',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
export const bookingLevelLabel = (l: BookingLevel) =>
  l === 'faculty' ? 'Faculty' : 'HOD or Admin';

export function BookingBadge({
  status,
  level,
}: {
  status: BookingStatus;
  level?: BookingLevel | null;
}) {
  return (
    <span className={`badge badge-b-${status}`}>
      {LABEL[status]}
      {status === 'pending' && level ? `: awaiting ${bookingLevelLabel(level)}` : ''}
    </span>
  );
}
