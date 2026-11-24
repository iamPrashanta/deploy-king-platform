// the fit rules on fixed numbers (no server needed):  cd /work/apps/api && npx tsx /t/fitunit.ts
import { evaluateFit, type Capacity } from "/work/apps/api/src/services/capacity";

let failed = 0;
const pass = (ok: boolean, label: string, extra = "") => {
  if (!ok) failed++;
  console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : ""));
};
const cap = (m: Partial<Capacity["memory"]>, d: Partial<NonNullable<Capacity["disk"]>> = {}): Capacity => ({
  memory: { totalMb: 4096, hostReserveMb: 614, promiseLimitMb: 5223, reservedMb: 2048, freeToPromiseMb: 3175, freeNowMb: 2400, ...m },
  disk: { totalMb: 40960, freeMb: 20000, reserveMb: 6144, usedPct: 51, ...d },
  apps: { count: 4, typicalMb: 512, roomFor: 4 },
  settings: { hostReservePct: 15, overcommitPct: 150, diskReserveGb: null },
});
const fresh = { memoryMb: 512, newApp: true, builds: true };
const kinds = (f: { reasons: { kind: string }[] }) => f.reasons.map((r) => r.kind).join(",");

let f = evaluateFit(cap({}), fresh);
pass(f.verdict === "fits" && f.after.freeToPromiseMb === 2663, "a 512 MB app fits on a half-used 4 GB server", f.note);

f = evaluateFit(cap({ freeToPromiseMb: 700, freeNowMb: 2400 }), fresh);
pass(f.verdict === "tight", "fits but leaves less than one more app: tight", f.note);

f = evaluateFit(cap({ reservedMb: 5000, freeToPromiseMb: 223 }), fresh);
pass(f.verdict === "blocked" && kinds(f) === "promised" && f.overridable, "limits would add up past the over-promise cap: blocked", f.reasons[0]?.text);
pass(f.suggestions.some((s) => s.includes("192 MB")), "suggests the limit that would fit", f.suggestions[0]);

f = evaluateFit(cap({ freeNowMb: 300 }), fresh);
pass(f.verdict === "blocked" && kinds(f) === "free-now", "enough promised room but the server is busy right now: blocked", f.reasons[0]?.text);

f = evaluateFit(cap({ freeToPromiseMb: 100, freeNowMb: -50 }), fresh);
pass(kinds(f) === "promised,free-now" && !f.suggestions.some((s) => s.includes("memory limit of")), "both reasons are given, and no impossible limit is suggested", String(f.suggestions.length));

f = evaluateFit(cap({}, { freeMb: 6500 }), fresh);
pass(f.verdict === "blocked" && kinds(f) === "disk" && f.overridable, "a new app may not eat into the disk reserve", f.reasons[0]?.text);

f = evaluateFit(cap({}, { freeMb: 6500 }), { memoryMb: 0, newApp: false, builds: true });
pass(f.verdict === "fits", "a redeploy of an existing app is not stopped by the disk reserve");

f = evaluateFit(cap({}, { freeMb: 1500, usedPct: 96 }), { memoryMb: 0, newApp: false, builds: true });
pass(f.verdict === "blocked" && kinds(f) === "disk-full" && !f.overridable, "nothing builds on a 96% full disk, and nobody can override it", f.reasons[0]?.text);

f = evaluateFit(cap({}, { freeMb: 1500, usedPct: 96 }), { memoryMb: 0, newApp: false, builds: false });
pass(f.verdict === "fits", "a restart or rollback (no build) still works on a full disk");

f = evaluateFit(cap({ reservedMb: 5000, freeToPromiseMb: 223 }), { memoryMb: 0, newApp: false, builds: true });
pass(f.verdict === "fits", "an app that already holds its memory can always redeploy");

f = evaluateFit({ ...cap({}), disk: null }, fresh);
pass(f.verdict === "fits", "when the disk cannot be measured, memory alone decides");

console.log(failed ? `${failed} FAILED` : "all fit rules hold");
process.exit(failed ? 1 : 0);
