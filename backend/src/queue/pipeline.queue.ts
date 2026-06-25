// BullMQ queue definition backed by Upstash Redis.
import { Queue } from "bullmq";
import IORedis from "ioredis";

export const PIPELINE_QUEUE = "pipeline";

export interface PipelineJobData {
  leadId: string;
}

// Upstash requires TLS; BullMQ needs maxRetriesPerRequest: null.
export const connection = new IORedis(process.env.UPSTASH_REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const pipelineQueue = new Queue<PipelineJobData>(PIPELINE_QUEUE, { connection });

export async function enqueueLead(leadId: string) {
  return pipelineQueue.add("process-lead", { leadId }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
}
