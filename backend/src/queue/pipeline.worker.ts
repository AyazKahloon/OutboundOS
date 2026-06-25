// BullMQ worker: pulls a leadId off the queue and runs the LangGraph pipeline.
import { Worker } from "bullmq";
import { PIPELINE_QUEUE, connection, type PipelineJobData } from "./pipeline.queue.js";
import { pipeline } from "../pipeline/pipeline.js";
import { prisma } from "../db/client.js";

export function startPipelineWorker() {
  const worker = new Worker<PipelineJobData>(
    PIPELINE_QUEUE,
    async (job) => {
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: job.data.leadId } });

      await prisma.lead.update({ where: { id: lead.id }, data: { status: "researching" } });

      await pipeline.invoke({
        leadId: lead.id,
        companyName: lead.companyName,
        companyWebsite: lead.companyWebsite ?? "",
        address: lead.location ?? "",
        decisionMakerName: lead.fullName ?? "",
        siteMarkdown: "",
        reviews: [],
        reviewsMeta: null,
        researchJson: null,
        reviewsJson: null,
        emailSubject: null,
        emailDraft: null,
        error: null,
      });
    },
    { connection, concurrency: 3 }
  );

  worker.on("completed", (job) => console.log(`[pipeline] lead ${job.data.leadId} done`));
  worker.on("failed", (job, err) => console.error(`[pipeline] lead ${job?.data.leadId} failed:`, err));

  return worker;
}
