import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(private readonly config: Config) {
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    });
  }
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.MAIL_FROM, ...message });
  }
}

/** Collects messages in memory. Used by tests; never used in production wiring. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failNext = 0;
  async send(message: MailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('SMTP connection refused');
    }
    this.sent.push(message);
  }
}
