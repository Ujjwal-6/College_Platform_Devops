import { z } from 'zod';

const isoInstant = z.string().datetime({
  offset: true,
  message: 'Use an ISO-8601 date-time with a UTC offset, e.g. 2026-11-20T10:00:00+05:30',
});

const speakerSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    designation: z.string().trim().max(100).nullish(),
    organization: z.string().trim().max(100).nullish(),
  })
  .strict();

const fields = {
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000),
  category: z.string().trim().min(2).max(50),
  departmentId: z.string().uuid(),
  startAt: isoInstant,
  endAt: isoInstant,
  expectedAttendance: z.number().int().min(1).max(100_000),
  capacity: z.number().int().min(1).max(100_000).nullable(),
  registrationMode: z.enum(['individual', 'team']),
  teamSizeMin: z.number().int().min(2).max(50).nullable(),
  teamSizeMax: z.number().int().min(2).max(50).nullable(),
  registrationDeadline: isoInstant.nullable(),
  speakers: z.array(speakerSchema).max(20),
};

export const createEventSchema = z
  .object({
    title: fields.title,
    description: fields.description.default(''),
    category: fields.category,
    departmentId: fields.departmentId.optional(), // defaults to the creator's department
    startAt: fields.startAt,
    endAt: fields.endAt,
    expectedAttendance: fields.expectedAttendance,
    capacity: fields.capacity.default(null),
    registrationMode: fields.registrationMode.default('individual'),
    teamSizeMin: fields.teamSizeMin.default(null),
    teamSizeMax: fields.teamSizeMax.default(null),
    registrationDeadline: fields.registrationDeadline.default(null),
    speakers: fields.speakers.default([]),
  })
  .strict();

export const updateEventSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const commentSchema = z.object({ comment: z.string().trim().min(1).max(1000) }).strict();
export const optionalNoteSchema = z
  .object({ comment: z.string().trim().max(1000).optional() })
  .strict();
export const decisionSchema = z
  .object({
    level: z.enum(['faculty', 'hod', 'admin']),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict();
export const rejectionSchema = z
  .object({
    level: z.enum(['faculty', 'hod', 'admin']),
    comment: z.string().trim().min(1, 'A comment is required when rejecting').max(1000),
  })
  .strict();

export const listQuerySchema = z
  .object({
    scope: z.enum(['published', 'mine', 'department', 'approvals']).default('published'),
    status: z
      .enum(['draft', 'pending_approval', 'approved', 'published', 'closed', 'cancelled'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export interface EventShape {
  startAt: Date;
  endAt: Date;
  registrationMode: 'individual' | 'team';
  teamSizeMin: number | null;
  teamSizeMax: number | null;
  registrationDeadline: Date | null;
}

/** Cross-field rules, checked on the merged event. The database repeats them as constraints. */
export function validateShape(e: EventShape): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (e.endAt <= e.startAt) issues.push({ path: 'endAt', message: 'End must be after start' });
  if (e.registrationMode === 'individual') {
    if (e.teamSizeMin !== null || e.teamSizeMax !== null) {
      issues.push({ path: 'teamSizeMin', message: 'Team sizes apply only to team events' });
    }
  } else if (e.teamSizeMin === null || e.teamSizeMax === null) {
    issues.push({
      path: 'teamSizeMin',
      message: 'Team events need a minimum and maximum team size',
    });
  } else if (e.teamSizeMax < e.teamSizeMin) {
    issues.push({
      path: 'teamSizeMax',
      message: 'Maximum team size must not be below the minimum',
    });
  }
  if (e.registrationDeadline && e.registrationDeadline > e.startAt) {
    issues.push({
      path: 'registrationDeadline',
      message: 'Registration must close before the event starts',
    });
  }
  return issues;
}
