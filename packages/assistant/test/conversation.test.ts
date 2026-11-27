import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createConversation } from "../src/index";
import type { PlanInfo } from "../src/types";
import { FakeApi, FakeLlm, call, cfg, makeShopZip, recorder, turn } from "./helpers";

const apps = { count: 2, apps: [{ id: "a1", name: "shop-api.localhost", status: "active" }, { id: "a2", name: "blog.localhost", status: "crashing" }] };

test("read-only tools run without asking; the model gets their result", async () => {
  const llm = new FakeLlm([turn("Looking.", call("list_apps", {})), turn("You have 2 apps; blog keeps crashing.")]);
  const api = new FakeApi({ list_apps: () => apps });
  const c = createConversation(cfg(), { llm, api });
  const r = recorder();
  await c.send("what is running?", [], r.handler);
  assert.deepEqual(api.names(), ["list_apps"]);
  assert.equal(r.of("plan").length, 0);
  assert.deepEqual(r.of("tool_start").map((e) => e.name), ["list_apps"]);
  assert.deepEqual(r.of("tool_result").map((e) => [e.ok, e.summary]), [[true, "2 apps"]]);
  assert.equal(r.of("text").map((e) => e.delta).join(""), "Looking.You have 2 apps; blog keeps crashing.");
  assert.deepEqual(r.events.at(-1), { type: "done", stopReason: "end_turn" });
  const second = llm.requests[1]!.messages.at(-1)!;
  assert.equal(second.role, "user");
  assert.equal((second.content[0] as any).type, "tool_result");
  assert.match((second.content[0] as any).content, /blog\.localhost/);
});

test("deploying an attached ZIP: check, plan, approval, upload with secrets, deploy question, live", async () => {
  const { file, dir } = makeShopZip();
  const userSecret = "s3cr3t-Value-For-JWT-123456";
  const infos: PlanInfo[] = [];
  const llm = new FakeLlm([
    turn(call("check_project", { file: "shop-api.zip" })),
    (req) => {
      const r = JSON.parse((req.messages.at(-1)!.content[0] as any).content);
      assert.equal(r.framework?.toLowerCase().includes("express"), true, JSON.stringify(r));
      assert.ok(r.variables.some((v: any) => v.key === "DATABASE_URL"));
      return turn(
        call("propose_plan", {
          app: "shop-api",
          tools: ["create_database", "deploy_zip"],
          steps: ["Create database shop_api and set DATABASE_URL", "Use the JWT_SECRET you gave and a random SESSION_SECRET", "Build, start 1 copy with 512 MB, port 3000"],
        })
      );
    },
    turn(
      call("deploy_zip", { file: "shop-api.zip", name: "shop-api", port: 3000, variables: { JWT_SECRET: "{{secret:JWT_SECRET}}", SESSION_SECRET: "{{random}}" } }),
      call("create_database", { app: "shop-api", name: "shop_api" })
    ),
    turn(call("wait_for_deploy", { app: "shop-api" })),
    turn("shop-api is live at http://shop-api.localhost"),
  ]);
  const api = new FakeApi({
    create_database: (a) => ({ app: "shop-api.localhost", database: { name: a.name }, variable: "DATABASE_URL" }),
    wait_for_deploy: (_a, nth) =>
      nth === 1
        ? { app: "shop-api.localhost", url: "http://shop-api.localhost", done: false, result: "needs_answer", deployment: { id: "dep-1", status: "waiting_input", question: { question: "Which port does the app listen on?", answers: [{ answer: "3000", label: "3000 (found in server.js)" }, { answer: "8080", label: "8080" }] } } }
        : { app: "shop-api.localhost", url: "http://shop-api.localhost", done: true, result: "live", deployment: { id: "dep-1", status: "active" } },
    answer_deploy_question: (a) => ({ app: a.app, answered: a.answer }),
  });
  const conv = createConversation(cfg({ beforeChange: async (p: PlanInfo) => (infos.push(p), true) }), { llm, api });
  const r = recorder((e) => {
    if (e.type === "plan") {
      // Nothing may have changed before the user said yes.
      assert.equal(api.uploads.length, 0);
      assert.ok(!api.names().includes("create_database"));
      setTimeout(() => conv.approvePlan(e.id, true), 5);
    }
    if (e.type === "question") setTimeout(() => conv.answer(e.id, "1"), 5);
  });
  await conv.send(`deploy ./shop-api.zip as shop-api, JWT_SECRET=${userSecret}`, [{ path: file, name: "shop-api.zip" }], r.handler);

  const plans = r.of("plan");
  assert.equal(plans.length, 1, "one plan for the whole deploy");
  assert.equal(plans[0]!.app, "shop-api");
  assert.equal(plans[0]!.steps.length, 3);

  // Upload: the real secret goes to Deploy King, a random one is made here.
  assert.equal(api.uploads.length, 1);
  const up = api.uploads[0]!;
  assert.equal(up.name, "shop-api");
  assert.equal(up.port, 3000);
  assert.equal(up.variables!.JWT_SECRET, userSecret);
  const random = up.variables!.SESSION_SECRET!;
  assert.match(random, /^[0-9a-f]{32}$/);

  // The model never saw either value.
  const seen = llm.seen();
  assert.ok(!seen.includes(userSecret), "the user's secret was not sent to the model");
  assert.ok(!seen.includes(random), "the random secret was not sent to the model");
  assert.ok(seen.includes("{{secret:JWT_SECRET}}"));
  // Nor did the UI events.
  assert.ok(!JSON.stringify(r.events).includes(userSecret));
  assert.ok(!JSON.stringify(r.events).includes(random));

  // The deploy question became a question event; the answer went to the deploy engine.
  const q = r.of("question");
  assert.equal(q.length, 1);
  assert.match(q[0]!.prompt, /Which port/);
  assert.deepEqual(q[0]!.options.map((o) => o.id), ["3000", "8080"]);
  const ans = api.calls.find((c) => c.name === "answer_deploy_question")!;
  assert.deepEqual(ans.args, { app: "shop-api.localhost", answer: "3000" });
  assert.deepEqual(api.names().filter((n) => n === "wait_for_deploy").length, 2);

  // beforeChange saw the exact actions, with the file's hash and no secret values; then the deploy answer.
  assert.deepEqual(infos.map((p) => p.actions.map((a) => a.tool)), [["deploy_zip", "create_database"], ["answer_deploy_question"]]);
  const planInfo = infos[0]!;
  assert.equal(planInfo.id, plans[0]!.id);
  const zipAction = planInfo.actions.find((a) => a.tool === "deploy_zip")!;
  assert.equal(zipAction.action, "deploy");
  assert.equal(zipAction.file!.sha256, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  assert.ok(!JSON.stringify(infos).includes(userSecret));

  assert.deepEqual(r.of("tool_result").map((e) => e.summary), [
    "Checked shop-api.zip: Express · node · port 3000",
    "shop-api.localhost uploaded, deploy started",
    "database shop_api created, DATABASE_URL set",
    "live at http://shop-api.localhost",
  ]);
  assert.deepEqual(r.events.at(-1), { type: "done", stopReason: "end_turn" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a change without a plan gets a plan of its own; saying no changes nothing", async () => {
  const llm = new FakeLlm([turn(call("set_env", { app: "blog", set: { LOG_LEVEL: "debug" }, restart: true })), turn("OK, nothing changed. What should I do instead?")]);
  const api = new FakeApi({ set_env: () => ({ set: ["LOG_LEVEL"] }) });
  const conv = createConversation(cfg(), { llm, api });
  const r = recorder((e) => e.type === "plan" && conv.approvePlan(e.id, false));
  await conv.send("turn on debug logs for blog", [], r.handler);
  assert.equal(api.calls.length, 0);
  assert.deepEqual(r.of("plan")[0]!.steps, ["Set LOG_LEVEL on blog, then restart it"]);
  assert.equal(r.of("plan")[0]!.app, "blog");
  assert.equal(r.of("tool_start").length, 0, "a refused change is not started");
  const res = llm.requests[1]!.messages.at(-1)!.content[0] as any;
  assert.equal(res.is_error, true);
  assert.match(res.content, /did not approve/);
});

test("an approved plan covers only the tools and app it named", async () => {
  const llm = new FakeLlm([
    turn(call("propose_plan", { steps: ["Set LOG_LEVEL on blog"], tools: ["set_env"], app: "blog" })),
    turn(call("set_env", { app: "blog.localhost", set: { LOG_LEVEL: "debug" } })),
    turn(call("delete_app", { app: "blog", confirm: "blog.localhost" })),
    turn(call("set_env", { app: "shop-api", set: { LOG_LEVEL: "debug" } })),
    turn("done"),
  ]);
  const api = new FakeApi({ set_env: (a) => ({ app: a.app, set: Object.keys(a.set) }), delete_app: () => ({ deleted: "blog.localhost" }) });
  const conv = createConversation(cfg(), { llm, api });
  const r = recorder((e) => e.type === "plan" && conv.approvePlan(e.id, e.steps[0]!.startsWith("Set LOG_LEVEL on blog")));
  await conv.send("debug logs on blog", [], r.handler);
  // set_env on blog ran under the plan; delete_app and set_env on another app each needed their own.
  assert.deepEqual(r.of("plan").map((p) => p.steps[0]), ["Set LOG_LEVEL on blog", "Delete blog.localhost for good (containers, files and settings)", "Set LOG_LEVEL on shop-api"]);
  assert.deepEqual(api.names(), ["set_env"]);
});

test("approve: ask puts reads behind a plan too", async () => {
  const llm = new FakeLlm([turn(call("list_apps", {})), turn("2 apps")]);
  const api = new FakeApi({ list_apps: () => apps });
  const conv = createConversation(cfg({ approve: "ask" }), { llm, api });
  const r = recorder((e) => e.type === "plan" && conv.approvePlan(e.id, true));
  await conv.send("list my apps", [], r.handler);
  assert.deepEqual(r.of("plan").map((p) => p.steps), [["List the apps"]]);
  assert.deepEqual(api.names(), ["list_apps"]);
});

test("beforeChange (the Deploy King Cloud hook) can stop an approved change", async () => {
  const seen: PlanInfo[] = [];
  const llm = new FakeLlm([turn(call("deploy_app", { app: "blog" })), turn("It was refused.")]);
  const api = new FakeApi({ deploy_app: () => ({ app: "blog.localhost" }) });
  const conv = createConversation(cfg({ beforeChange: async (p: PlanInfo) => (seen.push(p), false) }), { llm, api });
  const r = recorder((e) => e.type === "plan" && conv.approvePlan(e.id, true));
  await conv.send("redeploy blog", [], r.handler);
  assert.equal(api.calls.length, 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.actions.map((a) => [a.tool, a.action, a.app]), [["deploy_app", "deploy", "blog"]]);
  assert.equal(seen[0]!.id, r.of("plan")[0]!.id);
});

test("secrets in tool results are hidden before the model sees them", async () => {
  const dsn = "postgres://shop:VeryS3cretPw@db:5432/shop";
  const gh = "ghp_" + "a".repeat(36);
  const llm = new FakeLlm([turn(call("get_app_logs", { app: "shop-api" })), turn("ok")]);
  const api = new FakeApi({ get_app_logs: () => ({ app: "shop-api", running: true, logs: `connecting to ${dsn}\nGITHUB_TOKEN=${gh}\nAPI_KEY=abcdef123456\nPORT=3000` }) });
  const conv = createConversation(cfg(), { llm, api });
  await conv.send("why does shop-api fail?", [], () => {});
  const seen = llm.seen();
  assert.ok(!seen.includes("VeryS3cretPw"));
  assert.ok(!seen.includes(gh));
  assert.ok(!seen.includes("abcdef123456"));
  assert.ok(seen.includes("PORT=3000"), "harmless values stay");
  assert.ok(seen.includes("postgres://shop:"), "the URL stays readable without its password");
});

test("a value the user gave is shown to the model as its reference, also when it comes back in output", async () => {
  const llm = new FakeLlm([turn(call("get_app_logs", { app: "x" })), turn("ok")]);
  const api = new FakeApi({ get_app_logs: () => ({ logs: "using key hunter22-long-value" }) });
  const conv = createConversation(cfg(), { llm, api });
  await conv.send("STRIPE_KEY=hunter22-long-value", [], () => {});
  assert.ok(!llm.seen().includes("hunter22-long-value"));
  assert.match(llm.seen(), /STRIPE_KEY=\{\{secret:STRIPE_KEY\}\}/);
  assert.match(llm.seen(), /using key \{\{secret:STRIPE_KEY\}\}/);
});

test("an unknown secret reference is refused before anything is sent", async () => {
  const llm = new FakeLlm([
    turn(call("propose_plan", { steps: ["Set API_TOKEN"], tools: ["set_env"] })),
    turn(call("set_env", { app: "blog", set: { API_TOKEN: "{{secret:NOPE}}" } })),
    turn("I need the token."),
  ]);
  const api = new FakeApi({ set_env: () => ({}) });
  const conv = createConversation(cfg(), { llm, api });
  const r = recorder((e) => e.type === "plan" && conv.approvePlan(e.id, true));
  await conv.send("set the api token", [], r.handler);
  assert.equal(api.calls.length, 0);
  assert.equal(r.of("tool_result")[0]!.ok, false);
  assert.match(r.of("tool_result")[0]!.summary, /no secret called NOPE/);
});

test("ask_user becomes a question; the typed answer goes back to the model", async () => {
  const llm = new FakeLlm([turn(call("ask_user", { question: "Which domain?", options: ["shop.example.com", "shop.localhost"] })), turn("thanks")]);
  const conv = createConversation(cfg(), { llm, api: new FakeApi() });
  const r = recorder((e) => e.type === "question" && conv.answer(e.id, "shop.example.com"));
  await conv.send("deploy it", [], r.handler);
  const q = r.of("question")[0]!;
  assert.deepEqual(q.options, [{ id: "1", label: "shop.example.com" }, { id: "2", label: "shop.localhost" }]);
  assert.match((llm.requests[1]!.messages.at(-1)!.content[0] as any).content, /shop\.example\.com/);
  assert.equal(r.of("tool_start").length, 0, "questions are not shown as tool calls");
});

test("answers and approvals for unknown ids are refused; a deploy question takes only its answers", async () => {
  const llm = new FakeLlm([turn(call("wait_for_deploy", { app: "a" })), turn("ok")]);
  const api = new FakeApi({
    wait_for_deploy: (_a, nth) => (nth === 1 ? { app: "a.localhost", result: "needs_answer", deployment: { question: { question: "Raise memory?", answers: [{ answer: "yes", label: "Yes, 1024 MB" }, { answer: "no", label: "No" }] } } } : { app: "a.localhost", result: "live", url: "http://a.localhost" }),
    answer_deploy_question: () => ({}),
  });
  const conv = createConversation(cfg(), { llm, api });
  let rejected = "";
  const r = recorder(async (e) => {
    if (e.type !== "question") return;
    await conv.answer(e.id, "maybe").catch((err) => (rejected = err.message));
    await conv.answer(e.id, "Yes, 1024 MB");
  });
  await assert.rejects(conv.approvePlan("plan_nope", true), /No plan/);
  await conv.send("follow the deploy", [], r.handler);
  assert.match(rejected, /Choose one of/);
  assert.deepEqual(api.calls.find((c) => c.name === "answer_deploy_question")!.args, { app: "a.localhost", answer: "yes" });
  await assert.rejects(conv.answer("q_nope", "x"), /No question/);
});

test("cancel while a plan waits: done is cancelled, and the next message still works", async () => {
  const llm = new FakeLlm([turn(call("deploy_app", { app: "blog" })), turn("Hello again")]);
  const api = new FakeApi({ deploy_app: () => ({}) });
  const conv = createConversation(cfg(), { llm, api });
  const r = recorder((e) => e.type === "plan" && setTimeout(() => conv.cancel(), 5));
  await conv.send("redeploy blog", [], r.handler);
  assert.deepEqual(r.events.at(-1), { type: "done", stopReason: "cancelled" });
  assert.equal(api.calls.length, 0);
  assert.equal(conv.busy, false);
  const r2 = recorder();
  await conv.send("hi", [], r2.handler);
  assert.deepEqual(r2.events.at(-1), { type: "done", stopReason: "end_turn" });
  // Every tool_use in the history has a result, so the API accepts the history.
  const msgs = llm.requests.at(-1)!.messages;
  const uses = msgs.flatMap((m) => m.content).filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
  const results = msgs.flatMap((m) => m.content).filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id);
  assert.deepEqual(results, uses);
  assert.equal(msgs.at(-1)!.role, "user");
});

test("a second send while busy is refused; model errors become an error event", async () => {
  const failing = { complete: async () => Promise.reject(Object.assign(new Error("bad key"), { status: 401 })) };
  const conv = createConversation(cfg(), { llm: failing, api: new FakeApi() });
  const r = recorder();
  const p = conv.send("hi", [], r.handler);
  await assert.rejects(conv.send("again", [], () => {}), /still working/);
  await p;
  assert.deepEqual(r.events.map((e) => e.type), ["error", "done"]);
  assert.match((r.events[0] as any).message, /Anthropic API key was refused/);
});

test("a stuck model is stopped after maxTurns", async () => {
  const llm = new FakeLlm(Array.from({ length: 10 }, () => turn(call("list_apps", {}))));
  const conv = createConversation(cfg({ maxTurns: 3 }), { llm, api: new FakeApi({ list_apps: () => apps }) });
  const r = recorder();
  await conv.send("loop", [], r.handler);
  assert.equal(llm.requests.length, 3);
  assert.deepEqual(r.events.at(-1), { type: "done", stopReason: "max_turns" });
});
