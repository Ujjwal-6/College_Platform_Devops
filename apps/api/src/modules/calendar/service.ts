import type { Executor } from '../../platform/db.js';
import * as repo from './repository.js';
import type { CalendarEntry, CalendarType, Severity } from './repository.js';

/**
 * Default severity per entry type. An admin can still choose either severity per entry, so the
 * policy is data, not code (requirement FR-20.3).
 */
export const DEFAULT_SEVERITY: Record<CalendarType, Severity> = {
  exam_period: 'block',
  holiday: 'block',
  major_fest: 'warn',
  academic_date: 'warn',
  other: 'warn',
};

export interface CalendarCheck {
  /** Hard conflicts: the action must be refused. */
  blocks: CalendarEntry[];
  /** Soft conflicts: allowed, but shown to approvers and organizers. */
  warnings: CalendarEntry[];
}

/**
 * The academic calendar guard. Shared contract (I-7): the booking feature calls this same function
 * for hall bookings and may add its own scope (hall) later. Pass the transaction client when the
 * check must be consistent with a write.
 */
export async function checkRange(
  db: Executor,
  timezone: string,
  range: { startAt: Date; endAt: Date; departmentId: string | null },
): Promise<CalendarCheck> {
  const hits = await repo.findOverlapping(db, timezone, range);
  return {
    blocks: hits.filter((e) => e.severity === 'block'),
    warnings: hits.filter((e) => e.severity === 'warn'),
  };
}
