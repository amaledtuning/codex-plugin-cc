import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireCapacityFallbackClaim,
  evaluateCapacityFallbackEligibility,
  hasZeroExecutionEvidence,
  isCapacityFailure,
  normalizeCapacityFallbackMode,
  normalizeCapacityMessage,
  persistCapacityFallbackMetadata,
  resolveExternalCapacityFallback,
  runWithCapacityFallback,
  STOP_REVIEW_TASK_MARKER
} from "../plugins/codex/scripts/lib/capacity-fallback.mjs";
import { runAppServerTurnWithClient } from "../plugins/codex/scripts/lib/codex.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_SCRIPT = path.join(REPO_ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capacity-fallback-test-"));
}

const ZERO_EVIDENCE = {
  itemEvents: 0,
  agentMessageSeen: false,
  finalAnswerSeen: false,
  collaborationSeen: false,
  commandExecutions: [],
  fileChanges: [],
  messages: []
};

test("capacity classifier matches only the two exact normalized messages", () => {
  assert.equal(normalizeCapacityMessage(" ERROR: Selected  model is at capacity. "), "selected model is at capacity");
  assert.equal(isCapacityFailure({ error: new Error("Selected model is at capacity") }), true);
  assert.equal(isCapacityFailure({ error: new Error("Selected model is at capacity. Please try a different model.") }), true);
  assert.equal(isCapacityFailure({ error: new Error("Capacity planning failed") }), false);
  assert.equal(isCapacityFailure({ error: new Error("Selected model is at capacity for this tenant") }), false);
});

test("stderr is eligible only for the direct transport", () => {
  const result = { stderr: "ERROR: Selected model is at capacity. Please try a different model." };
  assert.equal(isCapacityFailure({ result, transport: "direct" }), true);
  assert.equal(isCapacityFailure({ result, transport: "broker" }), false);
});

test("external matrix is fail-closed for xhigh, non-5.6, and unlisted combinations", () => {
  assert.deepEqual(resolveExternalCapacityFallback("gpt-5.6-sol", "high"), { model: "gpt-5.5", effort: "high" });
  assert.deepEqual(resolveExternalCapacityFallback("gpt-5.6-sol", "medium"), { model: "gpt-5.5", effort: "medium" });
  assert.deepEqual(resolveExternalCapacityFallback("gpt-5.6-terra", "high"), { model: "gpt-5.5", effort: "high" });
  assert.deepEqual(resolveExternalCapacityFallback("gpt-5.6-terra", "medium"), { model: "gpt-5.4", effort: "medium" });
  assert.deepEqual(resolveExternalCapacityFallback("gpt-5.6-luna", "medium"), { model: "gpt-5.4-mini", effort: "medium" });
  assert.equal(resolveExternalCapacityFallback("gpt-5.6-sol", "xhigh"), null);
  assert.equal(resolveExternalCapacityFallback("gpt-5.5", "high"), null);
  assert.equal(resolveExternalCapacityFallback("gpt-5.6-luna", "high"), null);
});

test("zero evidence rejects every observed activity class", () => {
  assert.equal(hasZeroExecutionEvidence(ZERO_EVIDENCE), true);
  for (const evidence of [
    { itemEvents: 1 },
    { agentMessageSeen: true },
    { finalAnswerSeen: true },
    { collaborationSeen: true },
    { commandExecutions: [{}] },
    { fileChanges: [{}] },
    { messages: [{}] }
  ]) {
    assert.equal(hasZeroExecutionEvidence(evidence), false);
  }
});

test("eligibility blocks write, xhigh, critical markers, stop review, and disabled mode", () => {
  const base = {
    mode: "noncritical",
    jobClass: "task",
    write: false,
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: "read-only investigation",
    evidence: ZERO_EVIDENCE
  };
  assert.equal(evaluateCapacityFallbackEligibility(base).eligible, true);
  for (const override of [
    { mode: "off" },
    { jobClass: "review" },
    { write: true },
    { effort: "xhigh" },
    { prompt: "route OPS-H80" },
    { prompt: "route CRIT-X90" },
    { prompt: "route ops-h80" },
    { prompt: "route crit-x90" },
    { prompt: STOP_REVIEW_TASK_MARKER },
    { evidence: { agentMessageSeen: true } }
  ]) {
    assert.equal(evaluateCapacityFallbackEligibility({ ...base, ...override }).eligible, false);
  }
});

test("capacity fallback defaults off and the task CLI exposes the explicit flag", () => {
  assert.equal(normalizeCapacityFallbackMode(), "off");
  assert.equal(normalizeCapacityFallbackMode("noncritical"), "noncritical");
  assert.throws(() => normalizeCapacityFallbackMode("always"), /Unsupported capacity fallback mode/);
  const help = spawnSync(process.execPath, [COMPANION_SCRIPT, "--help"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--capacity-fallback <off\|noncritical>/);
});

test("exclusive per-job claim allows exactly one concurrent winner", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobFile = path.join(dir, "task-1.json");
  fs.writeFileSync(jobFile, JSON.stringify({ id: "task-1", status: "running", attemptCount: 1 }), "utf8");
  const claim = () =>
    acquireCapacityFallbackClaim({
      jobFile,
      jobId: "task-1",
      readStoredJob: () => JSON.parse(fs.readFileSync(jobFile, "utf8"))
    });
  const results = await Promise.all([
    new Promise((resolve) => setImmediate(() => resolve(claim()))),
    new Promise((resolve) => setImmediate(() => resolve(claim())))
  ]);
  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.filter((result) => result.reason === "already-claimed").length, 1);
});

test("cancellation re-read after exclusive claim blocks attempt two", (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobFile = path.join(dir, "task-2.json");
  fs.writeFileSync(jobFile, JSON.stringify({ id: "task-2", status: "running" }), "utf8");
  const result = acquireCapacityFallbackClaim({
    jobFile,
    jobId: "task-2",
    readStoredJob: () => {
      const cancelled = { id: "task-2", status: "cancelled" };
      fs.writeFileSync(jobFile, JSON.stringify(cancelled), "utf8");
      return cancelled;
    }
  });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, "cancelled");
});

test("fallback metadata is persisted to the job record and index", (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobFile = path.join(dir, "task-3.json");
  fs.writeFileSync(jobFile, JSON.stringify({ id: "task-3", status: "running" }), "utf8");
  let indexPatch = null;
  const persisted = persistCapacityFallbackMetadata({
    workspaceRoot: dir,
    jobId: "task-3",
    fallback: { fromModel: "gpt-5.6-sol", toModel: "gpt-5.5", effort: "high", attemptCount: 2 },
    readStoredJob: () => JSON.parse(fs.readFileSync(jobFile, "utf8")),
    writeJobFile: (_workspaceRoot, _jobId, payload) => fs.writeFileSync(jobFile, JSON.stringify(payload), "utf8"),
    upsertJob: (_workspaceRoot, patch) => {
      indexPatch = patch;
    },
    fallbackAt: "2026-07-11T00:00:00.000Z"
  });
  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(persisted, true);
  assert.equal(stored.fallbackAttempted, true);
  assert.equal(stored.attemptCount, 2);
  assert.equal(stored.capacityFallbackFrom, "gpt-5.6-sol");
  assert.equal(stored.capacityFallbackTo, "gpt-5.5");
  assert.equal(stored.mandatoryReview, true);
  assert.equal(indexPatch.capacityFallbackUsed, true);
});

test("state machine retries once on the same thread with unchanged prompt context", async () => {
  const attempts = [];
  const prompt = "inspect the repository";
  const result = await runWithCapacityFallback({
    mode: "noncritical",
    jobClass: "task",
    model: "gpt-5.6-sol",
    effort: "high",
    prompt,
    runAttempt: async (request) => {
      attempts.push({ ...request, prompt });
      if (request.attempt === 1) {
        return {
          status: 1,
          threadId: "thr_1",
          effectiveModel: "gpt-5.6-sol",
          effectiveEffort: "high",
          error: { message: "Selected model is at capacity. Please try a different model." },
          executionEvidence: ZERO_EVIDENCE,
          transport: "broker"
        };
      }
      return { status: 0, threadId: "thr_1", finalMessage: "ok" };
    }
  });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], {
    attempt: 2,
    fromModel: "gpt-5.6-sol",
    fromEffort: "high",
    model: "gpt-5.5",
    effort: "high",
    resumeThreadId: "thr_1",
    prompt
  });
  assert.equal(result.capacityFallback.attemptCount, 2);
});

test("state machine does not retry after activity or cancellation reread", async () => {
  let attempts = 0;
  const firstFailure = {
    status: 1,
    threadId: "thr_1",
    effectiveModel: "gpt-5.6-sol",
    effectiveEffort: "high",
    error: { message: "Selected model is at capacity" },
    executionEvidence: { ...ZERO_EVIDENCE, itemEvents: 1 }
  };
  const activityResult = await runWithCapacityFallback({
    mode: "noncritical",
    jobClass: "task",
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: "inspect",
    runAttempt: async () => {
      attempts += 1;
      return firstFailure;
    }
  });
  assert.equal(attempts, 1);
  assert.equal(activityResult, firstFailure);

  attempts = 0;
  const cancelledResult = await runWithCapacityFallback({
    mode: "noncritical",
    jobClass: "task",
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: "inspect",
    runAttempt: async () => {
      attempts += 1;
      return { ...firstFailure, executionEvidence: ZERO_EVIDENCE };
    },
    beforeRetry: async () => false
  });
  assert.equal(attempts, 1);
  assert.equal(cancelledResult.status, 1);
});

test("state machine preserves a thrown capacity error when cancellation blocks retry", async () => {
  const error = new Error("Selected model is at capacity. Please try a different model.");
  error.threadId = "thr_2";
  error.effectiveModel = "gpt-5.6-terra";
  error.effectiveEffort = "medium";
  error.codexExecutionEvidence = ZERO_EVIDENCE;
  await assert.rejects(
    runWithCapacityFallback({
      mode: "noncritical",
      jobClass: "task",
      model: "gpt-5.6-terra",
      effort: "medium",
      prompt: "inspect",
      runAttempt: async () => {
        throw error;
      },
      beforeRetry: async () => false
    }),
    error
  );
});

test("thrown capacity error reuses its thread id for the single retry", async () => {
  const attempts = [];
  const error = new Error("Selected model is at capacity");
  error.threadId = "thr_thrown";
  error.effectiveModel = "gpt-5.6-terra";
  error.effectiveEffort = "medium";
  error.codexExecutionEvidence = ZERO_EVIDENCE;
  const result = await runWithCapacityFallback({
    mode: "noncritical",
    jobClass: "task",
    model: "gpt-5.6-terra",
    effort: "medium",
    prompt: "inspect",
    runAttempt: async (request) => {
      attempts.push(request);
      if (request.attempt === 1) {
        throw error;
      }
      return { status: 0, threadId: request.resumeThreadId };
    }
  });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].resumeThreadId, "thr_thrown");
  assert.equal(result.threadId, "thr_thrown");
});

test("rejected app-server turn/start enriches the real error and retries by resuming the same thread", async () => {
  class StubClient {
    constructor({ rejectTurn = false } = {}) {
      this.rejectTurn = rejectTurn;
      this.transport = "broker";
      this.stderr = "";
      this.notificationHandler = null;
      this.requests = [];
    }

    setNotificationHandler(handler) {
      this.notificationHandler = handler;
    }

    async request(method, params) {
      this.requests.push({ method, params });
      if (method === "thread/start" || method === "thread/resume") {
        return {
          thread: { id: "thr_real_path" },
          model: "gpt-5.6-sol",
          reasoningEffort: "high"
        };
      }
      if (method === "turn/start" && this.rejectTurn) {
        throw new Error("Selected model is at capacity. Please try a different model.");
      }
      if (method === "turn/start") {
        const turn = { id: "turn_2", status: "inProgress" };
        queueMicrotask(() => {
          this.notificationHandler?.({ method: "turn/started", params: { threadId: params.threadId, turn } });
          this.notificationHandler?.({
            method: "item/completed",
            params: {
              threadId: params.threadId,
              turnId: turn.id,
              item: { type: "agentMessage", id: "message_2", text: "fallback ok", phase: "final_answer" }
            }
          });
          this.notificationHandler?.({
            method: "turn/completed",
            params: { threadId: params.threadId, turn: { ...turn, status: "completed" } }
          });
        });
        return { turn };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  }

  const firstClient = new StubClient({ rejectTurn: true });
  const secondClient = new StubClient();
  let enrichedError = null;
  const result = await runWithCapacityFallback({
    mode: "noncritical",
    jobClass: "task",
    model: null,
    effort: null,
    prompt: "inspect",
    runAttempt: async ({ attempt, model, effort, resumeThreadId }) => {
      try {
        return await runAppServerTurnWithClient(attempt === 1 ? firstClient : secondClient, REPO_ROOT, {
          resumeThreadId,
          prompt: "inspect",
          model,
          effort,
          sandbox: "read-only",
          persistThread: true
        });
      } catch (error) {
        enrichedError = error;
        throw error;
      }
    }
  });

  assert.equal(enrichedError.threadId, "thr_real_path");
  assert.equal(enrichedError.effectiveModel, "gpt-5.6-sol");
  assert.equal(enrichedError.effectiveEffort, "high");
  assert.equal(enrichedError.codexExecutionEvidence.itemEvents, 0);
  assert.equal(enrichedError.codexExecutionEvidence.agentMessageSeen, false);
  assert.deepEqual(firstClient.requests.map((request) => request.method), ["thread/start", "turn/start"]);
  assert.equal(secondClient.requests[0].method, "thread/resume");
  assert.equal(secondClient.requests[0].params.threadId, "thr_real_path");
  assert.equal(secondClient.requests[1].method, "turn/start");
  assert.equal(secondClient.requests[1].params.model, "gpt-5.5");
  assert.equal(secondClient.requests[1].params.effort, "high");
  assert.equal(result.threadId, "thr_real_path");
  assert.equal(result.capacityFallback.attemptCount, 2);
});

test("a second capacity result is terminal after exactly two attempts", async () => {
  let attempts = 0;
  const result = await runWithCapacityFallback({
    mode: "noncritical",
    jobClass: "task",
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: "inspect",
    runAttempt: async ({ attempt }) => {
      attempts += 1;
      return {
        status: 1,
        threadId: "thr_terminal",
        effectiveModel: attempt === 1 ? "gpt-5.6-sol" : "gpt-5.5",
        effectiveEffort: "high",
        error: { message: "Selected model is at capacity. Please try a different model." },
        executionEvidence: ZERO_EVIDENCE
      };
    }
  });
  assert.equal(attempts, 2);
  assert.equal(result.status, 1);
  assert.equal(result.capacityFallback.attemptCount, 2);
});

test("default-off state machine never performs a capacity retry", async () => {
  let attempts = 0;
  const result = await runWithCapacityFallback({
    jobClass: "task",
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: "inspect",
    runAttempt: async () => {
      attempts += 1;
      return {
        status: 1,
        error: { message: "Selected model is at capacity" },
        executionEvidence: ZERO_EVIDENCE
      };
    }
  });
  assert.equal(attempts, 1);
  assert.equal(result.status, 1);
});
