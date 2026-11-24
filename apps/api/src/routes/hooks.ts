import { Router } from "express";
import { db, automations } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { enqueueRun } from "../services/automations";

/**
 * Public trigger URLs for workflows: POST /hooks/automations/<token>.
 * The token is the secret (24 random bytes); it can be rotated from the editor.
 */
const router = Router();

router.post("/automations/:token", async (req, res) => {
  const token = String(req.params.token || "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).json({ error: "Not found" });
  const [a] = await db.select().from(automations).where(eq(automations.webhookToken, token)).limit(1);
  if (!a || a.triggerType !== "webhook") return res.status(404).json({ error: "Not found" });
  if (!a.enabled) return res.status(409).json({ error: "This workflow is not active" });
  const headers: Record<string, string> = {};
  for (const k of ["content-type", "user-agent", "x-github-event", "x-github-delivery"]) {
    const v = req.headers[k];
    if (typeof v === "string") headers[k] = v.slice(0, 300);
  }
  const run = await enqueueRun(a.id, "webhook", { body: req.body ?? {}, query: req.query ?? {}, headers });
  res.status(202).json({ runId: run.id });
});

export default router;
