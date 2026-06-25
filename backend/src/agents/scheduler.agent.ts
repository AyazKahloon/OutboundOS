// Agent 3 — Scheduler: send an approved email via Resend (runs AFTER human approval).
import { Resend } from "resend";
import { prisma } from "../db/client.js";
import { sender } from "../config.js";

export interface SchedulerInput {
  leadId: string;
}

export async function schedulerAgent({ leadId }: SchedulerInput): Promise<void> {
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });

  if (lead.status !== "approved") {
    throw new Error(`lead ${leadId} is not approved (status=${lead.status})`);
  }
  if (!lead.emailDraft || !lead.emailSubject) {
    throw new Error(`lead ${leadId} has no draft to send`);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  if (!from) throw new Error("RESEND_FROM_EMAIL is not set");

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: `${sender.name} <${from}>`,
    to: lead.email,
    subject: lead.emailSubject,
    text: lead.emailDraft,
  });
  if (error) throw new Error(`Resend: ${error.message}`);

  await prisma.lead.update({
    where: { id: leadId },
    data: { status: "sent", sentAt: new Date() },
  });
}
