// SMTP sender (nodemailer) + IMAP reply detection (imapflow). Works with any provider —
// Gmail (app password), Outlook, or your own domain — using host/port/user/pass from Settings.
import nodemailer, { type Transporter } from "nodemailer";
import { ImapFlow } from "imapflow";

export interface MailboxConfig {
  host: string;
  port: number;
  secure: boolean; // true for 465, false for 587/STARTTLS
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  imapHost?: string; // for reply detection (993/SSL). Skipped if absent.
  signatureAddress?: string; // optional physical address for the footer (CAN-SPAM)
}

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string; // Message-ID of the email this replies to (threads follow-ups)
  references?: string;
}

export function isMailboxConfigured(c?: Partial<MailboxConfig> | null): c is MailboxConfig {
  return Boolean(c && c.host && c.port && c.user && c.pass && c.fromEmail);
}

// No auto signature, separator, or unsubscribe line — the email body already signs off, and
// a templated footer makes it look automated. Only append a physical address if one is set.
function footer(c: MailboxConfig): string {
  return c.signatureAddress ? `\n\n${c.signatureAddress}` : "";
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
      ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo, references: msg.references || msg.inReplyTo } : {}),
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---- IMAP reply detection --------------------------------------------------
export interface ThreadRef {
  leadId: string;
  messageId?: string; // Message-ID of the initial email we sent
  to: string; // recipient address
}

// Scans the inbox for replies to the given threads. Returns the leadIds that have replied.
// Best-effort: if IMAP isn't configured or fails, returns an empty list (never throws fatally).
export async function checkReplies(c: MailboxConfig, threads: ThreadRef[], sinceISO?: string): Promise<{ repliedLeadIds: string[]; error?: string }> {
  if (!c.imapHost || !c.user || !c.pass || threads.length === 0) {
    return { repliedLeadIds: [], error: c.imapHost ? undefined : "no IMAP host configured" };
  }
  const byMessageId = new Map<string, string>();
  const byFrom = new Map<string, string>();
  for (const t of threads) {
    if (t.messageId) byMessageId.set(t.messageId.replace(/[<>]/g, "").toLowerCase(), t.leadId);
    if (t.to) byFrom.set(t.to.toLowerCase(), t.leadId);
  }

  const client = new ImapFlow({
    host: c.imapHost,
    port: 993,
    secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
  });

  const replied = new Set<string>();
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = sinceISO ? new Date(sinceISO) : new Date(Date.now() - 30 * 864e5);
      for await (const msg of client.fetch({ since }, { envelope: true, headers: ["in-reply-to", "references"] })) {
        const from = msg.envelope?.from?.[0]?.address?.toLowerCase();
        if (from && byFrom.has(from)) replied.add(byFrom.get(from)!);
        const headerText = (msg.headers ? msg.headers.toString() : "").toLowerCase();
        for (const [mid, leadId] of byMessageId) if (headerText.includes(mid)) replied.add(leadId);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    return { repliedLeadIds: [...replied], error: (err as Error).message };
  }
  return { repliedLeadIds: [...replied] };
}
