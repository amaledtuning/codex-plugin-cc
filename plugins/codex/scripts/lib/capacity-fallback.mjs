import fs from "node:fs";

const CAPACITY_MESSAGES = new Set([
  "selected model is at capacity",
  "selected model is at capacity. please try a different model"
]);

const FALLBACK_MATRIX = new Map([
  ["gpt-5.6-sol|high", { model: "gpt-5.5", effort: "high" }],
  ["gpt-5.6-sol|medium", { model: "gpt-5.5", effort: "medium" }],
  ["gpt-5.6-terra|high", { model: "gpt-5.5", effort: "high" }],
  ["gpt-5.6-terra|medium", { model: "gpt-5.4", effort: "medium" }],
  ["gpt-5.6-luna|medium", { model: "gpt-5.4-mini", effort: "medium" }]
]);

const BLOCKED_PROMPT_MARKERS = ["OPS-H80", "CRIT-X90"];
export const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

export function normalizeCapacityFallbackMode(value) {
  const normalized = String(value ?? "off").trim().toLowerCase();
  if (normalized !== "off" && normalized !== "noncritical") {
    throw new Error('Unsupported capacity fallback mode. Use "off" or "noncritical".');
  }
  return normalized;
}

export function capacityFallbackClaimFile(jobFile) {
  return `${jobFile}.capacity-fallback.claim`;
}

export function acquireCapacityFallbackClaim({ jobFile, jobId, readStoredJob, now = () => new Date().toISOString() }) {
  const claimFile = capacityFallbackClaimFile(jobFile);
  let descriptor;
  try {
    descriptor = fs.openSync(claimFile, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify({ jobId, claimedAt: now() })}\n`, "utf8");
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (error?.code === "EEXIST") {
      return { acquired: false, reason: "already-claimed", claimFile };
    }
    throw error;
  }
  fs.closeSync(descriptor);

  // The claim is intentionally retained. A crash after claiming therefore fails
  // closed and requires explicit operator inspection instead of a duplicate retry.
  const storedJob = readStoredJob();
  if (!storedJob) {
    return { acquired: false, reason: "job-missing", claimFile };
  }
  if (storedJob.status === "cancelled") {
    return { acquired: false, reason: "cancelled", claimFile };
  }
  if (storedJob.fallbackAttempted || Number(storedJob.attemptCount ?? 1) >= 2) {
    return { acquired: false, reason: "already-attempted", claimFile };
  }
  return { acquired: true, reason: null, claimFile, storedJob };
}

export function persistCapacityFallbackMetadata({
  workspaceRoot,
  jobId,
  fallback,
  readStoredJob,
  writeJobFile,
  upsertJob,
  fallbackAt = null,
  attemptStarting = false
}) {
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (!storedJob || storedJob.status === "cancelled") {
    return false;
  }
  const patch = {
    id: jobId,
    fallbackAttempted: true,
    attemptCount: fallback.attemptCount ?? 2,
    capacityFallbackUsed: true,
    capacityFallbackFrom: fallback.fromModel,
    capacityFallbackTo: fallback.toModel ?? fallback.model,
    effectiveEffort: fallback.effort,
    mandatoryReview: fallback.effort === "high",
    ...(attemptStarting ? { status: "running", phase: "starting" } : {}),
    ...(fallbackAt ? { fallbackAt } : {})
  };
  writeJobFile(workspaceRoot, jobId, { ...storedJob, ...patch });
  upsertJob(workspaceRoot, patch);
  return true;
}

export function normalizeCapacityMessage(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^error:\s*/i, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function collectErrorMessages(error, result, transport) {
  const values = [
    error?.message,
    error?.data?.message,
    error?.error?.message,
    result?.error?.message,
    result?.turn?.error?.message
  ];
  if (transport === "direct" && typeof result?.stderr === "string") {
    values.push(...result.stderr.split(/\r?\n/));
  }
  if (transport === "direct" && typeof error?.stderr === "string") {
    values.push(...error.stderr.split(/\r?\n/));
  }
  return values.filter((value) => typeof value === "string" && value.trim());
}

export function isCapacityFailure({ error = null, result = null, transport = null } = {}) {
  const actualTransport = transport ?? result?.transport ?? error?.transport ?? null;
  return collectErrorMessages(error, result, actualTransport).some((message) =>
    CAPACITY_MESSAGES.has(normalizeCapacityMessage(message))
  );
}

export function resolveExternalCapacityFallback(model, effort) {
  const normalizedModel = String(model ?? "").trim().toLowerCase();
  const normalizedEffort = String(effort ?? "").trim().toLowerCase();
  if (!normalizedModel.startsWith("gpt-5.6-") || normalizedEffort === "xhigh") {
    return null;
  }
  const fallback = FALLBACK_MATRIX.get(`${normalizedModel}|${normalizedEffort}`);
  return fallback ? { ...fallback } : null;
}

export function hasZeroExecutionEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return false;
  }

  const booleanFields = ["agentMessageSeen", "finalAnswerSeen", "collaborationSeen", "subagentActivity"];
  const arrayFields = ["commandExecutions", "fileChanges", "messages"];
  if (booleanFields.some((field) => evidence[field] !== false)) {
    return false;
  }
  if (arrayFields.some((field) => !Array.isArray(evidence[field]) || evidence[field].length !== 0)) {
    return false;
  }
  if (typeof evidence.itemEvents !== "number" || !Number.isFinite(evidence.itemEvents) || evidence.itemEvents !== 0) {
    return false;
  }

  return ["commandExecutionCount", "fileChangeCount"].every(
    (field) => !(field in evidence) || (typeof evidence[field] === "number" && Number.isFinite(evidence[field]) && evidence[field] === 0)
  );
}

export function evaluateCapacityFallbackEligibility({
  mode,
  jobClass,
  write,
  model,
  effort,
  prompt,
  evidence
} = {}) {
  if (mode !== "noncritical") {
    return { eligible: false, reason: "fallback-disabled", fallback: null };
  }
  if (jobClass !== "task") {
    return { eligible: false, reason: "unsupported-job-class", fallback: null };
  }
  if (write) {
    return { eligible: false, reason: "write-capable", fallback: null };
  }
  if (String(effort ?? "").toLowerCase() === "xhigh") {
    return { eligible: false, reason: "xhigh", fallback: null };
  }
  const promptText = String(prompt ?? "");
  if (promptText.includes(STOP_REVIEW_TASK_MARKER)) {
    return { eligible: false, reason: "stop-review-task", fallback: null };
  }
  const upperPromptText = promptText.toUpperCase();
  if (BLOCKED_PROMPT_MARKERS.some((marker) => upperPromptText.includes(marker))) {
    return { eligible: false, reason: "critical-or-live-marker", fallback: null };
  }
  if (!hasZeroExecutionEvidence(evidence)) {
    return { eligible: false, reason: "execution-evidence", fallback: null };
  }
  const fallback = resolveExternalCapacityFallback(model, effort);
  if (!fallback) {
    return { eligible: false, reason: "no-matrix-entry", fallback: null };
  }
  return { eligible: true, reason: null, fallback };
}

function evidenceFor(error, result) {
  return result?.executionEvidence ?? error?.codexExecutionEvidence ?? {};
}

export async function runWithCapacityFallback({
  mode = "off",
  jobClass = "task",
  write = false,
  model = null,
  effort = null,
  prompt = "",
  resumeThreadId = null,
  runAttempt,
  beforeRetry = async () => true,
  beforeAttempt = async () => true,
  onFallback = null
}) {
  let firstResult = null;
  let firstError = null;
  try {
    firstResult = await runAttempt({ attempt: 1, model, effort, resumeThreadId });
  } catch (error) {
    firstError = error;
  }

  if (!isCapacityFailure({
    error: firstError,
    result: firstResult,
    transport: firstResult?.transport ?? firstError?.transport ?? null
  })) {
    if (firstError) {
      throw firstError;
    }
    return firstResult;
  }

  const effectiveModel = firstResult?.effectiveModel ?? firstError?.effectiveModel ?? model;
  const effectiveEffort = firstResult?.effectiveEffort ?? firstError?.effectiveEffort ?? effort;
  const eligibility = evaluateCapacityFallbackEligibility({
    mode,
    jobClass,
    write,
    model: effectiveModel,
    effort: effectiveEffort,
    prompt,
    evidence: evidenceFor(firstError, firstResult)
  });
  if (!eligibility.eligible) {
    if (firstError) {
      throw firstError;
    }
    return firstResult;
  }

  const nextThreadId = firstResult?.threadId ?? firstError?.threadId ?? resumeThreadId ?? null;
  const retry = {
    attempt: 2,
    fromModel: effectiveModel,
    fromEffort: effectiveEffort,
    model: eligibility.fallback.model,
    effort: eligibility.fallback.effort,
    resumeThreadId: nextThreadId
  };
  if (!(await beforeRetry(retry))) {
    if (firstError) {
      throw firstError;
    }
    return firstResult;
  }

  onFallback?.(retry);
  // This is the final awaited cancellation barrier before attempt #2 starts.
  // A cancellation that wins after it resolves is handled by the tracked-job
  // cancellation path; no later async work is introduced before runAttempt.
  if (!(await beforeAttempt(retry))) {
    if (firstError) {
      throw firstError;
    }
    return firstResult;
  }
  const secondResult = await runAttempt(retry);
  return {
    ...secondResult,
    capacityFallback: {
      used: true,
      fromModel: retry.fromModel,
      toModel: retry.model,
      effort: retry.effort,
      attemptCount: 2
    }
  };
}
