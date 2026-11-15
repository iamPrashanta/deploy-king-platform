import { Queue } from "bullmq";
import { redisConnection } from "./config";

const connection = redisConnection();

export const backupQueue = new Queue("backup", { connection });
export const infraQueue  = new Queue("infra",  { connection });
export const pipelineQueue = new Queue("pipeline", { connection });
export const hostingQueue = new Queue("hosting", { connection });
export const databaseQueue = new Queue("database", { connection });
export const cronQueue = new Queue("cron", { connection });
export const automationQueue = new Queue("automation", { connection });
