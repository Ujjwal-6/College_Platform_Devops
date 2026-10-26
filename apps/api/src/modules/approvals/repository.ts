import type { Executor } from '../../platform/db.js';
import type { ApprovalLevel } from '../events/types.js';

export interface ApprovalDecision {
  id: string;
  round: number;
  level: ApprovalLevel;
  decision: 'approved' | 'rejected';
  approverId: string;
  comment: string | null;
  decidedAt: Date;
}

export async function insertDecision(
  db: Executor,
  d: {
    eventId: string;
    round: number;
    level: ApprovalLevel;
    decision: 'approved' | 'rejected';
    approverId: string;
    comment: string | null;
  },
): Promise<void> {
  await db.query(
    'INSERT INTO event_approvals (event_id, round, level, decision, approver_id, comment) VALUES ($1, $2, $3, $4, $5, $6)',
    [d.eventId, d.round, d.level, d.decision, d.approverId, d.comment],
  );
}

export async function listForEvent(db: Executor, eventId: string): Promise<ApprovalDecision[]> {
  const { rows } = await db.query(
    'SELECT * FROM event_approvals WHERE event_id = $1 ORDER BY round, decided_at, id',
    [eventId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    round: r.round as number,
    level: r.level as ApprovalLevel,
    decision: r.decision as 'approved' | 'rejected',
    approverId: r.approver_id as string,
    comment: (r.comment as string | null) ?? null,
    decidedAt: r.decided_at as Date,
  }));
}

export async function decidersInRound(
  db: Executor,
  eventId: string,
  round: number,
): Promise<Set<string>> {
  const { rows } = await db.query(
    'SELECT approver_id FROM event_approvals WHERE event_id = $1 AND round = $2',
    [eventId, round],
  );
  return new Set(rows.map((r) => r.approver_id as string));
}
