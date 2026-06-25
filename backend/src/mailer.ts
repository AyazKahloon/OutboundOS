// SMTP sender (nodemailer). Works with any provider — Gmail (app password), Outlook,
// or your own domain — using host/port/user/pass supplied from the app's Settings.
import nodemailer, { type Transporter } from "nodemailer";

export interface MailboxConfig {
  host: string;
  port: number;
  secure: boolean; // true for 465, false for 587/STARTTLS
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  signatureAddress?: string; // optional physical address for the footer (CAN-SPAM)
}

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
}

export function isMailboxConfigured(c?: Partial<MailboxConfig> | null): c is MailboxConfig {
  return Boolean(c && c.host && c.port && c.user && c.pass && c.fromEmail);
}

// A simple, honest opt-out + identity footer appended to every email.
function footer(c: MailboxConfig): string {
  const lines = ["", "—", [c.fromName, c.fromEmail].filter(Boolean).join(" · ")];
  if (c.signatureAddress) lines.push(c.signatureAddress);
  lines.push('If you\'d rather not hear from me, just reply "unsubscribe".');
  return "\n\n" + lines.join("\n");
}

let cached: { key: string; t: Transporter } | null = null;
function transport(c: MailboxConfig): Transporter {
  const key = `${c.host}:${c.port}:${c.secure}:${c.user}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      t: nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.secure,
        auth: { user: c.user, pass: c.pass },
      }),
    };
  }
  return cached.t;
}

// Verify credentials / connectivity without sending (the "Test connection" button).
export async function verifyMailbox(c: MailboxConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    await transport(c).verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function sendEmail(c: MailboxConfig, msg: MailMessage): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  if (!msg.to) return { ok: false, error: "no recipient email address" };
  try {
    const info = await transport(c).sendMail({
      from: `"${c.fromName}" <${c.fromEmail}>`,
      to: msg.to,
      subject: msg.subject,
      text: msg.body + footer(c),
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
