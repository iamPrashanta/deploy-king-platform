// what does this container engine accept for log limits and out-of-memory priority?
import { createRequire } from "node:module";
const require = createRequire("/work/apps/worker/package.json");
const Docker = require("dockerode");
const docker = new Docker();
const images = (await docker.listImages()).flatMap((i) => i.RepoTags ?? []);
const image = images.find((t) => /whoami|nginx|alpine|busybox/.test(t)) || images[0];
console.log("engine:", (await docker.version()).Components?.[0]?.Name ?? "?", "| image:", image);
const tries = {
  "json-file max-size+max-file": { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
  "json-file max-size": { Type: "json-file", Config: { "max-size": "10m" } },
  "k8s-file max-size": { Type: "k8s-file", Config: { "max-size": "10m" } },
};
for (const [label, LogConfig] of Object.entries(tries)) {
  const name = "dk-logopt-" + Math.random().toString(36).slice(2, 8);
  try {
    const c = await docker.createContainer({ name, Image: image, HostConfig: { LogConfig, OomScoreAdj: 500, Memory: 64 * 1024 * 1024 } });
    await c.start();
    const i = await c.inspect();
    console.log("OK   ", label, "->", JSON.stringify(i.HostConfig.LogConfig), "oom:", i.HostConfig.OomScoreAdj, "running:", i.State.Running);
    await c.remove({ force: true });
  } catch (e) {
    console.log("FAIL ", label, "->", String(e.message).slice(0, 200));
    try { await docker.getContainer(name).remove({ force: true }); } catch {}
  }
}
