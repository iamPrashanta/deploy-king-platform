// cron text, words and next runs on fixed inputs:  cd apps/api && npx tsx <this file>
async function main() {
  const { preview, parseCron, describe } = await import(process.cwd() + "/src/services/schedule");
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };
  const from = Date.parse("2026-11-21T14:41:30Z"); // a Saturday
  const p = (s: string, tz = "UTC") => preview(s, tz, from) as any;
  const words = (s: string) => describe(parseCron(s));
  pass(words("*/15 * * * *") === "Every 15 minutes" && words("15 * * * *") === "Every hour at :15" && words("0 * * * *") === "Every hour", "minutes and hours in words");
  pass(words("0 6 * * *") === "Every day at 06:00" && words("30 2 * * 1") === "Every Monday at 02:30" && words("0 9 * * 1-5") === "Every weekday at 09:00" && words("0 4 1 * *") === "Every month on day 1 at 04:00", "days, weekdays and months in words");
  pass(words("0 9,17 * * *") === "Every day at 09:00 and 17:00" && words("0 */6 * * *") === "Every 6 hours" && words("5 4 * 2 *") === "Custom schedule", "two times a day, every few hours, and anything else as custom");
  pass(words("@daily") === "Every day at 00:00" && parseCron("@weekly").text === "0 0 * * 0", "shortcuts are stored as five fields");
  pass(words("30 2 * * MON") === "Every Monday at 02:30" && parseCron("0 0 * * 7").sets[4].has(0), "day names, and 7 as Sunday");
  let r = p("*/15 * * * *");
  pass(r.valid && r.next.join() === "2026-11-21T14:45:00.000Z,2026-11-21T15:00:00.000Z,2026-11-21T15:15:00.000Z", "the next three runs every 15 minutes", r.next?.join());
  r = p("0 6 * * *");
  pass(r.next[0] === "2026-11-22T06:00:00.000Z", "every day at 06:00 next runs tomorrow", r.next?.[0]);
  r = p("30 2 * * 1");
  pass(r.next[0] === "2026-11-23T02:30:00.000Z", "every Monday at 02:30 is next Monday", r.next?.[0]);
  r = p("0 6 * * *", "Asia/Kolkata");
  pass(r.next[0] === "2026-11-22T00:30:00.000Z", "06:00 in Kolkata is 00:30 UTC", r.next?.[0]);
  r = p("0 2 * * *", "Europe/Berlin");
  pass(r.next[0] === "2026-11-22T01:00:00.000Z", "02:00 in Berlin in winter is 01:00 UTC", r.next?.[0]);
  r = p("0 0 13 * 5");
  pass(r.next[0] === "2026-11-27T00:00:00.000Z", "with both day fields set, either one matches (as cron does)", r.next?.[0]);
  r = p("0 0 31 2 *");
  pass(!r.valid && r.error.includes("never runs"), "a schedule that never fires is refused");
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "a b c d e", ""]) {
    r = p(bad);
    if (r.valid) { pass(false, `refused: "${bad}"`); }
  }
  pass(true, "five parts, ranges, steps and names are checked");
  pass(!p("0 6 * * *", "Mars/Olympus").valid, "an unknown time zone is refused");
  const t0 = Date.now(); for (let i = 0; i < 200; i++) preview("0 0 29 2 *", "UTC", from); const ms = Date.now() - t0;
  pass(ms < 3000, "even a leap-day schedule is worked out quickly", `${ms} ms for 200`);
  console.log(failed ? `${failed} FAILED` : "schedules hold");
  process.exit(failed ? 1 : 0);
}
main();
