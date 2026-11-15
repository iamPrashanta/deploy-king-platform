import { Router } from "express";
import { backupQueue } from "../queues";

const router = Router();

router.post("/pgsql", async (req, res) => {
  try {
    // Basic validation
    if (!req.body.DB_NAME || !req.body.DB_USER) {
      return res.status(400).json({ error: "Missing DB_NAME or DB_USER" });
    }

    // Producer adding the job to BullMQ
    const job = await backupQueue.add("pgsql-backup", {
      db: req.body,
    });

    res.json({
      success: true,
      message: "Backup job queued successfully",
      jobId: job.id
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/seed/pgsql", async (req, res) => {
  try {
    const job = await backupQueue.add("pgsql-seed", {
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      message: "Database seed job queued successfully",
      jobId: job.id
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get("/jobs", async (req, res) => {
  try {
    const jobs = await backupQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
    const formattedJobs = jobs.map(j => ({
      id: j.id,
      name: j.name,
      data: j.data,
      state: j.finishedOn ? (j.failedReason ? 'failed' : 'completed') : (j.processedOn ? 'active' : 'waiting'),
      failedReason: j.failedReason,
      timestamp: j.timestamp,
      finishedOn: j.finishedOn,
    })).sort((a, b) => b.timestamp - a.timestamp);
    
    res.json(formattedJobs);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
