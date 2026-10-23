import { z } from 'zod';
import type { MailMessage } from '../../platform/mailer.js';

/**
 * Each notification type declares the data it needs and how it renders. Features add entries here
 * (approval requested, registration confirmed, certificate ready, ...). Templates render plain text
 * only, so user-supplied values can never inject markup into a message.
 */
const templates = {
  'account.created': {
    data: z.object({ name: z.string(), loginUrl: z.string() }),
    render: (d: { name: string; loginUrl: string }): Omit<MailMessage, 'to'> => ({
      subject: 'Your College Events account',
      text: `Hello ${d.name},\n\nAn account has been created for you on the College Events platform.\nSign in at ${d.loginUrl} with the credentials your administrator gave you, and change your password after the first sign-in.\n`,
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
