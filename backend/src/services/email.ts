import sgMail from '@sendgrid/mail';
import { env } from '../config/env';

// Only use SendGrid when a real key is configured (not the placeholder)
const isRealKey = Boolean(env.SENDGRID_API_KEY && !env.SENDGRID_API_KEY.startsWith('SG.xxxx'));
if (isRealKey) sgMail.setApiKey(env.SENDGRID_API_KEY);

const FROM = `AI Scheduler <noreply@${env.APP_DOMAIN}>`;

async function send(to: string, subject: string, html: string): Promise<void> {
  if (!isRealKey) {
    console.log(`[EMAIL DEV] To: ${to}\nSubject: ${subject}\n${html}\n`);
    return;
  }
  await sgMail.send({ to, from: FROM, subject, html });
}

export async function sendStaffInvite(to: string, inviteUrl: string): Promise<void> {
  await send(
    to,
    'You have been invited to AI Scheduler',
    `<p>You have been invited to join your office on AI Scheduler.</p>
     <p><a href="${inviteUrl}">Accept invitation</a> (expires in 48 hours)</p>`,
  );
}

export async function sendPasswordReset(to: string, resetUrl: string): Promise<void> {
  await send(
    to,
    'Reset your AI Scheduler password',
    `<p>You requested a password reset.</p>
     <p><a href="${resetUrl}">Reset password</a> (expires in 1 hour)</p>
     <p>If you did not request this, you can safely ignore this email.</p>`,
  );
}

export async function sendClientInvite(to: string, inviteUrl: string): Promise<void> {
  await send(
    to,
    'Your appointment is ready — download the app',
    `<p>Your office has set up an appointment for you.</p>
     <p><a href="${inviteUrl}">Open your invite</a></p>`,
  );
}
