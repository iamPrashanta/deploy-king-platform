/**
 * Cron schedules for scheduled jobs: checking, plain words, and the next run times.
 * Standard five fields (minute hour day-of-month month day-of-week), names allowed (MON, JAN),
 * and the @hourly/@daily/... shortcuts, which are stored expanded. When both day fields are
 * restricted a day matches either, as in cron itself. BullMQ runs the stored text in `timezone`.
 */

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAY_WORDS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day of the week", min: 0, max: 7, names: DAYS },
] as const;

export type Cron = { text: string; sets: Set<number>[]; star: boolean[] };

export class ScheduleError extends Error {}

function value(raw: string, f: (typeof FIELDS)[number]): number {
  const names = "names" in f ? (f.names as readonly string[]) : null;
  const up = raw.toUpperCase();
  const n = names && names.includes(up) ? names.indexOf(up) + (f.min === 1 ? 1 : 0) : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < f.min || n > f.max) throw new ScheduleError(`"${raw}" is not a valid ${f.name} (${f.min}-${f.max}).`);
  return n;
}

function field(text: string, f: (typeof FIELDS)[number]): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  let star = false;
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) && Number(stepText) > 0 ? Number(stepText) : NaN;
    if (!Number.isInteger(step)) throw new ScheduleError(`"${part}" has a step that is not a whole number above 0.`);
    let lo: number, hi: number;
    if (range === "*") {
      [lo, hi] = [f.min, f.max === 7 ? 6 : f.max];
      if (stepText === undefined) star = true;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      [lo, hi] = [value(a, f), value(b, f)];
      if (lo > hi) throw new ScheduleError(`"${range}" goes backwards.`);
    } else {
      lo = value(range, f);
      hi = stepText === undefined ? lo : f.max === 7 ? 6 : f.max;
    }
    for (let v = lo; v <= hi; v += step) set.add(f.max === 7 && v === 7 ? 0 : v);
  }
  return { set, star };
}

/** Reads cron text. Throws ScheduleError with a sentence a person can act on. */
export function parseCron(input: string): Cron {
  const raw = String(input ?? "").trim().replace(/\s+/g, " ");
  const text = MACROS[raw.toLowerCase()] ?? raw;
  const parts = text.split(" ");
  if (parts.length !== 5) throw new ScheduleError("A schedule has five parts: minute, hour, day of the month, month and day of the week.");
  const parsed = parts.map((p, i) => field(p, FIELDS[i]));
  return { text, sets: parsed.map((p) => p.set), star: parsed.map((p) => p.star) };
}

export function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(t: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), dow: DAYS.indexOf(p.weekday.toUpperCase().slice(0, 3)) };
}

function dayMatches(c: Cron, p: { d: number; dow: number }) {
  const [domStar, dowStar] = [c.star[2], c.star[4]];
  const dom = c.sets[2].has(p.d), dow = c.sets[4].has(p.dow);
  if (domStar && dowStar) return true;
  if (domStar) return dow;
  if (dowStar) return dom;
  return dom || dow;
}

/** The next `count` run times after `from`, in milliseconds. Empty when the schedule never fires (31 February). */
export function nextRuns(c: Cron, tz: string, from: number, count = 3): number[] {
  const out: number[] = [];
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const end = from + 4 * 366 * 86_400_000;
  for (let guard = 0; out.length < count && t < end && guard < 200_000; guard++) {
    const p = partsIn(t, tz);
    if (!c.sets[3].has(p.mo) || !dayMatches(c, p)) {
      t += ((23 - p.h) * 60 + (60 - p.mi)) * 60_000; // to the start of the next day there
      continue;
    }
    if (!c.sets[1].has(p.h)) {
      t += (60 - p.mi) * 60_000;
      continue;
    }
    if (!c.sets[0].has(p.mi)) {
      t += 60_000;
      continue;
    }
    out.push(t);
    t += 60_000;
  }
  return out;
}

const two = (n: number) => String(n).padStart(2, "0");
const only = (s: Set<number>) => (s.size === 1 ? [...s][0] : null);
const step = (text: string) => text.match(/^\*\/(\d+)$/)?.[1];

/** The schedule in words, for the common shapes; "Custom schedule" otherwise. */
export function describe(c: Cron): string {
  const [mi, h, dom, mo, dow] = c.text.split(" ");
  const m1 = only(c.sets[0]), h1 = only(c.sets[1]);
  const anyDay = c.star[2] && c.star[3] && c.star[4];
  if (c.text === "* * * * *") return "Every minute";
  if (step(mi) && h === "*" && anyDay) return `Every ${step(mi)} minutes`;
  if (m1 !== null && h === "*" && anyDay) return m1 === 0 ? "Every hour" : `Every hour at :${two(m1)}`;
  if (m1 !== null && step(h) && anyDay) return `Every ${step(h)} hours${m1 ? ` at :${two(m1)}` : ""}`;
  if (m1 === null || h1 === null || !c.star[3]) {
    if (m1 !== null && c.sets[1].size > 1 && c.sets[1].size <= 4 && !/[/-]/.test(h) && anyDay) return `Every day at ${[...c.sets[1]].sort((a, b) => a - b).map((x) => `${two(x)}:${two(m1)}`).join(" and ")}`;
    return "Custom schedule";
  }
  const at = `${two(h1)}:${two(m1)}`;
  if (anyDay) return `Every day at ${at}`;
  if (c.star[2] && !c.star[4]) {
    if (dow === "1-5") return `Every weekday at ${at}`;
    const d1 = only(c.sets[4]);
    if (d1 !== null) return `Every ${DAY_WORDS[d1]} at ${at}`;
  }
  if (!c.star[2] && c.star[4]) {
    const d1 = only(c.sets[2]);
    if (d1 !== null) return `Every month on day ${d1} at ${at}`;
  }
  return "Custom schedule";
}

/** For the panel and the API alike: is it valid, what does it mean, when does it run next. */
export function preview(schedule: string, tz = "UTC", from = Date.now()) {
  if (!validTimezone(tz)) return { valid: false as const, error: `"${tz}" is not a time zone this server knows.` };
  try {
    const c = parseCron(schedule);
    const next = nextRuns(c, tz, from, 3);
    if (!next.length) return { valid: false as const, error: "This schedule never runs (for example the 31st of a month that has 30 days)." };
    return { valid: true as const, cron: c.text, words: describe(c), next: next.map((t) => new Date(t).toISOString()) };
  } catch (e) {
    return { valid: false as const, error: e instanceof ScheduleError ? e.message : "Not a schedule." };
  }
}
