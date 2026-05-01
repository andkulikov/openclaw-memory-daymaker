import os from "node:os";
import path from "node:path";
import { resolveRuntimeTimezone, runDaymaker } from "./daymaker.js";

const PLUGIN_ID = "memory-daymaker";
const PLUGIN_NAME = "Memory Daymaker";
const CRON_NAME = "Memory Daymaker Daily";
const CRON_TAG = "[managed-by=memory-daymaker]";
const CRON_TRIGGER_TOKEN = "__memory_daymaker_daily_run__";
const DAYMAKER_TOOL_NAME = "memory-daymaker-run";
const CRON_TOOL_NAME = "cron";
const LEGACY_CRON_JOB_ID = "memory-daymaker-daily";
const LEGACY_CRON_NAMES = new Set(["Daily Memory Log"]);
const DAYMAKER_TIMEOUT_SECONDS = 3600;
const CRON_TURN_TIMEOUT_SECONDS = DAYMAKER_TIMEOUT_SECONDS + 120;
const HOOK_TIMEOUT_MS = (DAYMAKER_TIMEOUT_SECONDS + 180) * 1000;
const NATIVE_CRON_HOOK_MIN_VERSION = "2026.4.24";
const STALE_CRON_PAYLOAD_KEYS = [
  "thinking",
  "fallbacks",
  "allowUnsafeExternalContent",
];

const DEFAULTS = {
  schedule: {
    enabled: true,
    time: "00:05",
    mode: "auto",
  },
};

const DEFAULT_DELIVERY = {
  mode: "none",
};

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeRuntimeString(fn) {
  try {
    return normalizeText(fn?.());
  } catch {
    return "";
  }
}

function resolveStateDir(api, appConfig) {
  return (
    safeRuntimeString(() => api?.runtime?.state?.resolveStateDir?.()) ||
    normalizeText(api?.config?.stateDir) ||
    normalizeText(appConfig?.stateDir) ||
    path.join(os.homedir(), ".openclaw")
  );
}

function resolveAgentId(ctx = {}) {
  return normalizeText(ctx.agentId) || "main";
}

function resolveWorkspaceDir(api, appConfig, ctx = {}, stateDir = resolveStateDir(api, appConfig)) {
  const agentId = resolveAgentId(ctx);
  const cfg = appConfig ?? api?.config;
  return (
    safeRuntimeString(() => api?.runtime?.agent?.resolveAgentWorkspaceDir?.(cfg, agentId)) ||
    normalizeText(api?.config?.agents?.defaults?.workspace) ||
    normalizeText(appConfig?.agents?.defaults?.workspace) ||
    path.join(stateDir, "workspace")
  );
}

function resolveSessionsDir(api, appConfig, ctx = {}, stateDir = resolveStateDir(api, appConfig)) {
  const agentId = resolveAgentId(ctx);
  const cfg = appConfig ?? api?.config;
  const agentDir = safeRuntimeString(() => api?.runtime?.agent?.resolveAgentDir?.(cfg, agentId));
  if (agentDir) return path.join(path.dirname(agentDir), "sessions");
  return path.join(stateDir, "agents", agentId, "sessions");
}

function resolveRuntimeDefaults(api, appConfig, ctx = {}) {
  const stateDir = resolveStateDir(api, appConfig);
  const workspaceDir = resolveWorkspaceDir(api, appConfig, ctx, stateDir);
  return {
    sessionsDir: resolveSessionsDir(api, appConfig, ctx, stateDir),
    memoryDir: path.join(workspaceDir, "memory"),
    backupDir: path.join(workspaceDir, "backups", "memory-daymaker"),
    timezone: resolveRuntimeTimezone(),
  };
}

function isDaymakerCronTrigger(value) {
  return parseDaymakerCronTrigger(value).matched;
}

function isDaymakerCronContext(ctx = {}) {
  const trigger = normalizeText(ctx.trigger).toLowerCase();
  if (trigger === "cron") return true;

  const sessionKey = normalizeText(ctx.sessionKey).toLowerCase();
  if (sessionKey.includes("cron:")) return true;

  const messageProvider = normalizeText(ctx.messageProvider).toLowerCase();
  const channelId = normalizeText(ctx.channelId).toLowerCase();
  return messageProvider === "cron-event" || channelId === "cron-event";
}

function shouldHandleDaymakerCronTrigger(value, ctx = {}) {
  const trigger = parseDaymakerCronTrigger(value);
  if (!trigger.matched) return false;
  return trigger.wrapped || isDaymakerCronContext(ctx);
}

function parseDaymakerCronTrigger(value) {
  const body = normalizeText(value);
  if (body === CRON_TRIGGER_TOKEN) return { matched: true, wrapped: false };

  const [firstLine = ""] = body.split(/\r?\n/, 1);
  const hasCronPrefix = /^\[cron:[^\]]+\]\s*/.test(firstLine);
  const withoutCronPrefix = firstLine.replace(/^\[cron:[^\]]+\]\s*/, "").trim();
  if (!hasCronPrefix && firstLine.trim() === CRON_TRIGGER_TOKEN) {
    return { matched: true, wrapped: false };
  }
  return {
    matched: hasCronPrefix && withoutCronPrefix === CRON_TRIGGER_TOKEN,
    wrapped: hasCronPrefix,
  };
}

function resolvePluginConfig(api, appConfig, ctx = {}) {
  const fromApi = api?.pluginConfig ?? api?.config?.plugins?.entries?.[PLUGIN_ID]?.config;
  const fromCli = appConfig?.plugins?.entries?.[PLUGIN_ID]?.config;
  const configured = {
    ...(isRecord(fromCli) ? fromCli : {}),
    ...(isRecord(fromApi) ? fromApi : {}),
  };
  const configuredSchedule = isRecord(configured.schedule) ? configured.schedule : {};
  const runtimeDefaults = resolveRuntimeDefaults(api, appConfig ?? api?.config, ctx);

  const resolved = {
    ...runtimeDefaults,
    ...configured,
    schedule: {
      ...DEFAULTS.schedule,
      ...configuredSchedule,
    },
  };
  if (!normalizeText(resolved.timezone)) resolved.timezone = runtimeDefaults.timezone;
  if (!normalizeText(resolved.sessionsDir)) resolved.sessionsDir = runtimeDefaults.sessionsDir;
  if (!normalizeText(resolved.memoryDir)) resolved.memoryDir = runtimeDefaults.memoryDir;
  if (!hasOwn(configured, "backupDir") || configured.backupDir === undefined || configured.backupDir === null) {
    resolved.backupDir = runtimeDefaults.backupDir;
  }
  return resolved;
}

function parseScheduleTime(time) {
  const raw = String(time || DEFAULTS.schedule.time).trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) throw new Error(`Invalid daymaker schedule time '${raw}', expected HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid daymaker schedule time '${raw}', expected HH:MM`);
  }
  return { hour, minute };
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(normalizeText(version));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

function hostSupportsNativeCronHook(api) {
  const version = parseVersion(api?.runtime?.version);
  if (!version) return true;
  return compareVersions(version, NATIVE_CRON_HOOK_MIN_VERSION) >= 0;
}

function pluginAllowsConversationAccess(api, appConfig = api?.config) {
  return appConfig?.plugins?.entries?.[PLUGIN_ID]?.hooks?.allowConversationAccess === true;
}

function pluginEntryIsDisabled(appConfig) {
  return appConfig?.plugins?.entries?.[PLUGIN_ID]?.enabled === false;
}

function resolveScheduleExecutionMode(api, config = {}, appConfig = api?.config) {
  const raw = normalizeText(config.schedule?.mode).toLowerCase();
  if (raw === "native" || raw === "hook" || raw === "direct" || raw === "openclaw-cron") {
    return "native";
  }
  if (raw === "tool" || raw === "agent-tool" || raw === "llm-tool") {
    return "tool";
  }
  return hostSupportsNativeCronHook(api) && pluginAllowsConversationAccess(api, appConfig) ? "native" : "tool";
}

function pickFailureAlertDestination(value) {
  if (!isRecord(value)) return {};
  const destination = {};
  for (const key of ["channel", "to", "accountId"]) {
    if (typeof value[key] === "string" && value[key].trim()) destination[key] = value[key];
  }
  if (value.mode === "announce" || value.mode === "webhook") destination.mode = value.mode;
  return destination;
}

function buildDelivery(_config = {}) {
  return { ...DEFAULT_DELIVERY };
}

function buildFailureAlert(config = {}) {
  if (config.schedule?.failureAlert === false) return false;
  const legacyDeliveryFallback = pickFailureAlertDestination(config.schedule?.delivery);
  return {
    ...legacyDeliveryFallback,
    ...(isRecord(config.schedule?.failureAlert) ? config.schedule.failureAlert : {}),
  };
}

function resolveCronSchedule(config = {}) {
  const schedule = {
    ...DEFAULTS.schedule,
    ...(isRecord(config.schedule) ? config.schedule : {}),
  };
  const { hour, minute } = parseScheduleTime(schedule.time);
  return {
    enabled: schedule.enabled !== false,
    time: schedule.time ?? DEFAULTS.schedule.time,
    cron: `${minute} ${hour} * * *`,
    timezone: normalizeText(config.timezone) || resolveRuntimeTimezone(),
  };
}

function resolveCronPayloadModel(config = {}) {
  return normalizeText(config.schedule?.model) || normalizeText(config.model);
}

function buildToolCronMessage() {
  return [
    "Run the Memory Daymaker daily maintenance now.",
    `Call the ${DAYMAKER_TOOL_NAME} tool exactly once with no arguments.`,
    `If the ${DAYMAKER_TOOL_NAME} tool is unavailable, the plugin is disabled or unavailable. In that case, use the ${CRON_TOOL_NAME} tool with action "update", the jobId from the [cron:<jobId> ...] prefix, and patch {"enabled":false}.`,
    "Do not use any other tool. After the tool returns, report only whether the daily memory update completed. If you disabled the job instead, report only that Memory Daymaker cron was disabled because the plugin is unavailable.",
  ].join("\n");
}

function buildNativeCronMessage() {
  return [
    CRON_TRIGGER_TOKEN,
    "",
    `If you are reading this prompt, the ${PLUGIN_NAME} plugin did not claim its private cron trigger.`,
    `Use the ${CRON_TOOL_NAME} tool with action "update", the jobId from the [cron:<jobId> ...] prefix, and patch {"enabled":false}.`,
    "Then report only that Memory Daymaker cron was disabled because the plugin is unavailable.",
  ].join("\n");
}

function buildCronPayload(config, executionMode = "native") {
  const model = resolveCronPayloadModel(config);
  if (executionMode === "tool") {
    return {
      kind: "agentTurn",
      message: buildToolCronMessage(),
      timeoutSeconds: CRON_TURN_TIMEOUT_SECONDS,
      lightContext: true,
      toolsAllow: [DAYMAKER_TOOL_NAME, CRON_TOOL_NAME],
      ...(model ? { model } : {}),
    };
  }
  return {
    kind: "agentTurn",
    message: buildNativeCronMessage(),
    timeoutSeconds: CRON_TURN_TIMEOUT_SECONDS,
    lightContext: true,
    toolsAllow: [CRON_TOOL_NAME],
    ...(model ? { model } : {}),
  };
}

function buildCronJob(config, options = {}) {
  const schedule = resolveCronSchedule(config);
  const executionMode = options.executionMode === "tool" ? "tool" : "native";
  return {
    name: CRON_NAME,
    description: `${CRON_TAG} Regenerate daily OpenClaw memory files from session transcripts.`,
    enabled: true,
    schedule: {
      kind: "cron",
      expr: schedule.cron,
      tz: schedule.timezone,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: buildCronPayload(config, executionMode),
    delivery: buildDelivery(config),
    failureAlert: buildFailureAlert(config),
    state: {},
  };
}

function isManagedCronJob(job) {
  if (!isRecord(job)) return false;
  const description = normalizeText(job.description);
  if (description.includes(CRON_TAG)) return true;
  if (description.includes("managed by the memory-daymaker plugin")) return true;
  if (job.id === LEGACY_CRON_JOB_ID || job.managedBy === PLUGIN_ID) return true;

  const name = normalizeText(job.name);
  const payloadMessage = normalizeText(job.payload?.message);
  if (LEGACY_CRON_NAMES.has(name) && payloadMessage.includes("collect_memory.py")) return true;
  if (name !== CRON_NAME) return false;
  return (
    isDaymakerCronTrigger(payloadMessage) ||
    payloadMessage.includes("daymaker-run") ||
    payloadMessage.includes("collect_memory.py")
  );
}

function sortManagedCronJobs(jobs) {
  return [...jobs].sort((a, b) => {
    const aCreated = Number.isFinite(a?.createdAtMs) ? a.createdAtMs : Number.MAX_SAFE_INTEGER;
    const bCreated = Number.isFinite(b?.createdAtMs) ? b.createdAtMs : Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
}

function jsonEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function payloadMatches(existing, desired) {
  if (!isRecord(existing)) return false;
  if (normalizeText(existing.kind).toLowerCase() !== desired.kind.toLowerCase()) return false;
  if (normalizeText(existing.message) !== desired.message) return false;
  if (existing.timeoutSeconds !== desired.timeoutSeconds) return false;
  if (existing.lightContext !== desired.lightContext) return false;
  if (normalizeText(existing.model) !== normalizeText(desired.model)) return false;
  if (!jsonEqual(existing.toolsAllow, desired.toolsAllow)) return false;
  if (existing.thinking !== undefined) return false;
  if (existing.fallbacks !== undefined) return false;
  if (existing.allowUnsafeExternalContent !== undefined) return false;
  return true;
}

function payloadNeedsReplacement(payload, desiredPayload) {
  if (!isRecord(payload)) return false;
  if (payload.model !== undefined && desiredPayload?.model === undefined) return true;
  if (payload.toolsAllow !== undefined && desiredPayload?.toolsAllow === undefined) return true;
  return STALE_CRON_PAYLOAD_KEYS.some((key) => payload[key] !== undefined);
}

function failureAlertNeedsReplacement(existing, desired) {
  if (!isRecord(existing) || !isRecord(desired)) return false;
  return Object.keys(existing).some((key) => !hasOwn(desired, key));
}

function buildCronPatch(job, desired) {
  const patch = {};
  if (normalizeText(job.name) !== desired.name) patch.name = desired.name;
  if (normalizeText(job.description) !== desired.description) patch.description = desired.description;
  if (job.enabled !== true) patch.enabled = true;

  const currentSchedule = job.schedule ?? {};
  if (
    normalizeText(currentSchedule.kind).toLowerCase() !== "cron" ||
    normalizeText(currentSchedule.expr) !== desired.schedule.expr ||
    normalizeText(currentSchedule.tz) !== desired.schedule.tz
  ) {
    patch.schedule = desired.schedule;
  }

  if (normalizeText(job.sessionTarget).toLowerCase() !== "isolated") patch.sessionTarget = "isolated";
  if (normalizeText(job.wakeMode).toLowerCase() !== "now") patch.wakeMode = "now";

  if (!payloadMatches(job.payload, desired.payload)) {
    patch.payload = { ...desired.payload };
    if (job.payload?.model !== undefined && desired.payload.model === undefined) patch.payload.model = null;
    if (job.payload?.toolsAllow !== undefined && desired.payload.toolsAllow === undefined) patch.payload.toolsAllow = null;
    for (const key of STALE_CRON_PAYLOAD_KEYS) {
      if (job.payload?.[key] !== undefined) patch.payload[key] = null;
    }
  }

  if (!jsonEqual(job.delivery, desired.delivery)) patch.delivery = desired.delivery;
  if (!jsonEqual(job.failureAlert, desired.failureAlert)) patch.failureAlert = desired.failureAlert;

  return Object.keys(patch).length > 0 ? patch : null;
}

function resolveCronService(candidate) {
  if (!isRecord(candidate)) return null;
  if (
    typeof candidate.list === "function" &&
    typeof candidate.add === "function" &&
    typeof candidate.update === "function" &&
    typeof candidate.remove === "function"
  ) {
    return candidate;
  }
  return null;
}

async function disableManagedCronJobs(api, cron, managed) {
  let disabled = 0;
  for (const job of managed) {
    if (job.enabled === false) continue;
    try {
      await cron.update(job.id, { enabled: false });
      disabled += 1;
    } catch (error) {
      api.logger?.warn?.(`memory-daymaker: failed to disable managed cron job ${job.id}: ${error.message ?? error}`);
    }
  }
  if (disabled > 0) api.logger?.info?.(`memory-daymaker: disabled ${disabled} managed cron job(s)`);
  return { status: "plugin-disabled", disabled, removed: 0 };
}

async function reconcileManagedCron(api, ctx = {}) {
  const cron = resolveCronService(ctx.getCron?.() ?? ctx.cron);
  if (!cron) {
    api.logger?.warn?.("memory-daymaker: cron service unavailable; daily schedule not reconciled");
    return { status: "unavailable", removed: 0 };
  }

  const appConfig = ctx.config ?? api.config;
  const config = resolvePluginConfig(api, appConfig, ctx);
  const schedule = resolveCronSchedule(config);
  const executionMode = resolveScheduleExecutionMode(api, config, appConfig);
  const allJobs = await cron.list({ includeDisabled: true });
  const managed = sortManagedCronJobs((Array.isArray(allJobs) ? allJobs : []).filter(isManagedCronJob));

  if (pluginEntryIsDisabled(appConfig)) {
    return await disableManagedCronJobs(api, cron, managed);
  }

  if (!schedule.enabled) {
    let removed = 0;
    for (const job of managed) {
      try {
        if ((await cron.remove(job.id))?.removed === true) removed += 1;
      } catch (error) {
        api.logger?.warn?.(`memory-daymaker: failed to remove managed cron job ${job.id}: ${error.message ?? error}`);
      }
    }
    if (removed > 0) api.logger?.info?.(`memory-daymaker: removed ${removed} managed cron job(s)`);
    return { status: "disabled", removed };
  }

  const desired = buildCronJob(config, { executionMode });
  if (managed.length === 0) {
    await cron.add(desired);
    api.logger?.info?.(
      `memory-daymaker: created daily cron job at ${schedule.time} ${schedule.timezone} (${executionMode} mode)`,
    );
    return { status: "added", removed: 0 };
  }

  const [primary, ...duplicates] = managed;
  let removed = 0;
  for (const duplicate of duplicates) {
    try {
      if ((await cron.remove(duplicate.id))?.removed === true) removed += 1;
    } catch (error) {
      api.logger?.warn?.(`memory-daymaker: failed to remove duplicate cron job ${duplicate.id}: ${error.message ?? error}`);
    }
  }

  const patch = buildCronPatch(primary, desired);
  if (!patch) {
    if (removed > 0) api.logger?.info?.("memory-daymaker: pruned duplicate daily cron jobs");
    return { status: "noop", removed };
  }

  if (
    payloadNeedsReplacement(primary.payload, desired.payload) ||
    failureAlertNeedsReplacement(primary.failureAlert, desired.failureAlert)
  ) {
    await cron.add(desired);
    try {
      if ((await cron.remove(primary.id))?.removed === true) removed += 1;
    } catch (error) {
      api.logger?.warn?.(`memory-daymaker: failed to remove stale cron job ${primary.id}: ${error.message ?? error}`);
    }
    api.logger?.info?.(
      `memory-daymaker: replaced daily cron job at ${schedule.time} ${schedule.timezone} (${executionMode} mode)`,
    );
    return { status: "replaced", removed };
  }

  await cron.update(primary.id, patch);
  api.logger?.info?.(
    `memory-daymaker: updated daily cron job at ${schedule.time} ${schedule.timezone} (${executionMode} mode)`,
  );
  return { status: "updated", removed };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reconcileManagedCronWithRetry(api, ctx) {
  let lastResult = { status: "unavailable", removed: 0 };
  for (const pauseMs of [0, 1000, 3000, 10000]) {
    if (pauseMs > 0) await delay(pauseMs);
    lastResult = await reconcileManagedCron(api, ctx);
    if (lastResult.status !== "unavailable") return lastResult;
  }
  return lastResult;
}

function truncateForReply(text, maxChars = 4000) {
  const value = normalizeText(text);
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 32).trimEnd()}\n... [truncated]`;
}

function formatDaymakerFailure(error) {
  const output = truncateForReply(error?.log ?? error?.text ?? "");
  if (output && output !== "OK") return output;
  return `Daymaker error: ${error?.message ?? String(error)}`;
}

function buildDaymakerFailureReply(error) {
  return {
    text: formatDaymakerFailure(error),
    isError: true,
  };
}

async function runScheduledDaymaker(api, ctx = {}) {
  const config = resolvePluginConfig(api, ctx.config ?? api.config, ctx);
  const stdout = {
    write(chunk) {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trimEnd();
        if (trimmed) api.logger?.info?.(`memory-daymaker: ${trimmed}`);
      }
    },
  };
  return await runDaymaker(["--verbose"], config, { api, ctx, stdout, verbose: true });
}

function createDaymakerRunTool(api) {
  return (ctx = {}) => ({
    name: DAYMAKER_TOOL_NAME,
    label: "Memory Daymaker run",
    description: "Generate or update the OpenClaw daily memory file from session transcripts.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Optional target date as YYYY-MM-DD. Defaults to yesterday in the configured timezone.",
        },
      },
    },
    execute: async (_toolCallId, params = {}) => {
      const toolParams = isRecord(params) ? params : {};
      const date = normalizeText(toolParams.date);
      const config = resolvePluginConfig(api, ctx.config ?? api.config, ctx);
      const stdout = {
        write(chunk) {
          for (const line of String(chunk).split(/\r?\n/)) {
            const trimmed = line.trimEnd();
            if (trimmed) api.logger?.info?.(`memory-daymaker: ${trimmed}`);
          }
        },
      };
      const args = ["--verbose"];
      if (date) args.push("--date", date);
      const result = await runDaymaker(args, config, { api, ctx, stdout, verbose: true });
      const text = result?.text === "OK" ? "Memory Daymaker completed successfully." : String(result?.text ?? "OK");
      return {
        content: [{ type: "text", text }],
        details: { status: "ok", date: date || undefined },
      };
    },
  });
}

function dateOption(command) {
  return command.option("--date <yyyy-mm-dd>", "Target date (defaults to yesterday in the resolved timezone)");
}

function registerDaymakerCli(program, config, api) {
  const root = program
    .command("daymaker")
    .description("Generate and inspect daily memory logs");

  dateOption(root.command("coverage").description("Report session/memory coverage for a date"))
    .action(async (opts) => {
      const args = ["--coverage"];
      if (opts.date) args.push("--date", opts.date);
      await runDaymaker(args, config, { api, stdout: process.stdout, coverage: true });
    });

  dateOption(root.command("run").description("Generate/update the daily memory markdown for a date"))
    .option("--verbose", "Show collector diagnostic output")
    .action(async (opts) => {
      const args = [];
      if (opts.date) args.push("--date", opts.date);
      if (opts.verbose) args.push("--verbose");
      await runDaymaker(args, config, { api, stdout: process.stdout, verbose: Boolean(opts.verbose) });
    });
}

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: "Generate daily OpenClaw memory files from session transcripts.",
  register(api) {
    if (api.registrationMode === "full") {
      api.registerTool?.(createDaymakerRunTool(api));

      api.on?.("gateway_start", async (_event, ctx) => {
        try {
          await reconcileManagedCronWithRetry(api, ctx);
        } catch (error) {
          api.logger?.error?.(`memory-daymaker: cron reconciliation failed: ${error.message ?? error}`);
        }
      });

      api.on?.(
        "before_agent_reply",
        async (event, ctx) => {
          if (!shouldHandleDaymakerCronTrigger(event.cleanedBody, ctx)) return;

          try {
            api.logger?.info?.("memory-daymaker: claimed daily cron trigger");
            await runScheduledDaymaker(api, ctx);
            return { handled: true, reason: "memory-daymaker: daily run completed" };
          } catch (error) {
            const reply = buildDaymakerFailureReply(error);
            api.logger?.error?.(`memory-daymaker: daily run failed: ${error.message ?? error}`);
            return {
              handled: true,
              reply,
            };
          }
        },
        { timeoutMs: HOOK_TIMEOUT_MS },
      );
    }

    api.registerCli(({ program, config: appConfig }) => {
      registerDaymakerCli(program, resolvePluginConfig(api, appConfig), api);
    }, {
      descriptors: [{
        name: "daymaker",
        description: "Generate and inspect daily memory logs",
        hasSubcommands: true,
      }],
    });
  },
};

export {
  CRON_TAG,
  CRON_TRIGGER_TOKEN,
  DAYMAKER_TOOL_NAME,
  buildCronJob,
  buildCronPatch,
  buildDaymakerFailureReply,
  buildNativeCronMessage,
  buildDelivery,
  buildFailureAlert,
  buildToolCronMessage,
  CRON_TOOL_NAME,
  createDaymakerRunTool,
  formatDaymakerFailure,
  hostSupportsNativeCronHook,
  isDaymakerCronContext,
  isDaymakerCronTrigger,
  isManagedCronJob,
  parseVersion,
  parseScheduleTime,
  parseDaymakerCronTrigger,
  pluginEntryIsDisabled,
  pluginAllowsConversationAccess,
  reconcileManagedCron,
  registerDaymakerCli,
  resolvePluginConfig,
  resolveScheduleExecutionMode,
  resolveRuntimeDefaults,
  runDaymaker,
  runScheduledDaymaker,
  shouldHandleDaymakerCronTrigger,
};
