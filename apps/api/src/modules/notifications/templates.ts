import { z } from 'zod';
import type { MailMessage } from '../../platform/mailer.js';

/**
 * Each notification type declares the data it needs and how it renders. Features add entries here
 * (approval requested, registration confirmed, certificate ready, ...). Templates render plain text
 * only, so user-supplied values can never inject markup into a message.
 */
/** User-supplied text must never be able to add header lines to an email subject. */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

const templates = {
  'account.created': {
    data: z.object({ name: z.string(), loginUrl: z.string() }),
    render: (d: { name: string; loginUrl: string }): Omit<MailMessage, 'to'> => ({
      subject: 'Your College Events account',
      text: `Hello ${d.name},\n\nAn account has been created for you on the College Events platform.\nSign in at ${d.loginUrl} with the credentials your administrator gave you, and change your password after the first sign-in.\n`,
    }),
  },
  'event.approval_requested': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      level: z.enum(['faculty', 'hod', 'admin']),
      organizerName: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      level: string;
      organizerName: string;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Approval needed: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\n${d.organizerName} submitted the event "${d.eventTitle}" and it is waiting for your ${d.level} approval.\nReview it at ${d.url}\n`,
    }),
  },
  'event.decision': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      decision: z.enum(['approved', 'fully_approved', 'rejected']),
      level: z.enum(['faculty', 'hod', 'admin']),
      approverName: z.string(),
      comment: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      decision: string;
      level: string;
      approverName: string;
      comment: string;
      url: string;
    }): Omit<MailMessage, 'to'> => {
      const outcome =
        d.decision === 'fully_approved'
          ? `has been fully approved (final approval by ${d.approverName}). You can now publish it.`
          : d.decision === 'approved'
            ? `was approved at the ${d.level} level by ${d.approverName} and moves to the next level.`
            : `was rejected at the ${d.level} level by ${d.approverName}. It is back in draft: edit it and submit again.`;
      return {
        subject: oneLine(
          `${d.decision === 'rejected' ? 'Event rejected' : 'Event approval update'}: ${d.eventTitle}`,
        ),
        text: `Hello ${d.name},\n\nYour event "${d.eventTitle}" ${outcome}\n${d.comment ? `\nComment: ${d.comment}\n` : ''}\nDetails: ${d.url}\n`,
      };
    },
  },
  'event.cancelled': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      cancelledBy: z.string(),
      reason: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      cancelledBy: string;
      reason: string;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Event cancelled: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\nYour event "${d.eventTitle}" was cancelled by ${d.cancelledBy}.\nReason: ${d.reason}\n\nDetails: ${d.url}\n`,
    }),
  },
  'registration.confirmed': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      when: z.string(),
      teamName: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      when: string;
      teamName: string;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Registration confirmed: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\nYou are registered for "${d.eventTitle}" (${d.when}).${d.teamName ? `\nTeam: ${d.teamName}` : ''}\nDetails: ${d.url}\n`,
    }),
  },
  'registration.promoted': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      when: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      when: string;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`A seat opened up: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\nA seat became free and you are now registered for "${d.eventTitle}" (${d.when}), moving up from the waitlist.\nIf you can no longer come, please cancel so the next person can have the seat.\nDetails: ${d.url}\n`,
    }),
  },
  'gate_pass.ready': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      when: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      when: string;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Your gate pass: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\nYour gate pass for "${d.eventTitle}" (${d.when}) is ready. Sign in and open the event page to see your QR code or download the PDF:\n${d.url}\n\nShow the QR code at the gate when you arrive and again when you leave. Please do not share it.\n`,
    }),
  },
  'certificate.ready': {
    data: z.object({ name: z.string(), eventTitle: z.string(), url: z.string() }),
    render: (d: { name: string; eventTitle: string; url: string }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Your certificate: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\nYour certificate of participation for "${d.eventTitle}" is ready. Sign in to download it:\n${d.url}\n`,
    }),
  },
  'report.ready': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      version: z.number(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      version: number;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Post-event report ready: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\nVersion ${d.version} of the post-event report for "${d.eventTitle}" is ready. Sign in and open the event page to download it:\n${d.url}\n`,
    }),
  },
  'report.failed': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      version: z.number(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      version: number;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Post-event report could not be made: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\nVersion ${d.version} of the post-event report for "${d.eventTitle}" could not be made after several tries. An administrator has been told. You can ask for it again from the event page:\n${d.url}\n`,
    }),
  },
  'registration.event_cancelled': {
    data: z.object({ name: z.string(), eventTitle: z.string(), url: z.string() }),
    render: (d: { name: string; eventTitle: string; url: string }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Event cancelled: ${d.eventTitle}`),
      text: `Hello ${d.name},\n\nThe event "${d.eventTitle}" you registered for (or were waiting for) has been cancelled, so your registration is cancelled too.\nDetails: ${d.url}\n`,
    }),
  },
  'booking.approval_requested': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      hallName: z.string(),
      when: z.string(),
      level: z.enum(['faculty', 'hod_admin']),
      requesterName: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      hallName: string;
      when: string;
      level: string;
      requesterName: string;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Hall booking approval needed: ${d.hallName} for ${d.eventTitle}`),
      text: `Hello ${d.name},\n\n${d.requesterName} asked to book ${d.hallName} for "${d.eventTitle}" (${d.when}). It is waiting for your ${d.level === 'faculty' ? 'faculty' : 'HOD / admin'} approval.\nReview it at ${d.url}\n`,
    }),
  },
  'booking.decision': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      hallName: z.string(),
      when: z.string(),
      decision: z.enum(['approved', 'confirmed', 'rejected']),
      approverName: z.string(),
      comment: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      hallName: string;
      when: string;
      decision: string;
      approverName: string;
      comment: string;
      url: string;
    }): Omit<MailMessage, 'to'> => {
      const outcome =
        d.decision === 'confirmed'
          ? `is confirmed (final approval by ${d.approverName}).`
          : d.decision === 'approved'
            ? `was approved by ${d.approverName} and moves to the next step.`
            : `was rejected by ${d.approverName}. The hall is free again; you can request another slot.`;
      return {
        subject: oneLine(
          `${d.decision === 'rejected' ? 'Hall booking rejected' : d.decision === 'confirmed' ? 'Hall booking confirmed' : 'Hall booking update'}: ${d.hallName}`,
        ),
        text: `Hello ${d.name},\n\nYour booking of ${d.hallName} for "${d.eventTitle}" (${d.when}) ${outcome}\n${d.comment ? `\nComment: ${d.comment}\n` : ''}\nDetails: ${d.url}\n`,
      };
    },
  },
  'booking.cancelled': {
    data: z.object({
      name: z.string(),
      eventTitle: z.string(),
      hallName: z.string(),
      when: z.string(),
      cancelledBy: z.string(),
      reason: z.string(),
      url: z.string(),
    }),
    render: (d: {
      name: string;
      eventTitle: string;
      hallName: string;
      when: string;
      cancelledBy: string;
      reason: string;
      url: string;
    }): Omit<MailMessage, 'to'> => ({
      subject: oneLine(`Hall booking cancelled: ${d.hallName}`),
      text: `Hello ${d.name},\n\nYour booking of ${d.hallName} for "${d.eventTitle}" (${d.when}) was cancelled by ${d.cancelledBy}.\n${d.reason ? `Reason: ${d.reason}\n` : ''}\nDetails: ${d.url}\n`,
    }),
  },
} as const;

export type NotificationType = keyof typeof templates;
export const NOTIFICATION_TYPES = Object.keys(templates) as NotificationType[];

export function renderNotification(type: string, data: unknown): Omit<MailMessage, 'to'> {
  if (!(type in templates)) throw new Error(`Unknown notification type "${type}"`);
  const template = templates[type as NotificationType];
  return template.render(template.data.parse(data) as never);
}

export function validateNotificationData(type: NotificationType, data: unknown): void {
  templates[type].data.parse(data);
}
