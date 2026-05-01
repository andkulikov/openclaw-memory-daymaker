import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BATCH_PROMPT = `\
You are a personal memory assistant. Below are conversations from several chat topics for one local day.
Write a useful summary for EVERY real conversation so it can become a daily memory note.

Return clean Markdown only, with no preamble:
- For each topic, start with "## A meaningful topic title", then bullet points.
- Include concrete facts: names, prices, models, parameters, links, and details that may be useful later.
- If a decision was made, mark it as: **Decision: ...**
- If a question remains open, mark it as: *Open question: ...*
- Write in the same language as the conversation.
- Write in third person, as a memory note, not as "the user asked".
- Each bullet must be a complete thought.
- Merge duplicate topics that are about the same thing.
- Skip topics that only contain technical startup/reset chatter and no real conversation.
- Still summarize short operational/meta threads when they contain useful information.
- Return ONLY the final Markdown.

`;

const SINGLE_PROMPT = `\
You are a personal memory assistant. Summarize this conversation for a daily memory note.

Return clean Markdown only, with no preamble:
- Start with: ## A meaningful topic title
- Then use bullet points
- Include concrete facts, decisions, and open questions
- Write in the same language as the conversation, in third person
- Each bullet must be a complete thought
- Return ONLY Markdown

`;

const FORMAT_REMINDER = `\

IMPORTANT: the previous response failed format validation.
Return STRICT Markdown with no preamble and no explanation:
## Topic title
- complete bullet
- complete bullet
*Open question: ...*
or
**Decision: ...**
`;

const MERGE_PROMPT = `\
You are a personal memory assistant rebuilding the canonical daily memory log.

There are two inputs:
1. EXISTING_MEMORY - the current memory file body. It is already a compressed version of the day, and its topics and facts must not be lost.
2. GENERATED_FROM_TRANSCRIPTS - a new summary generated from session transcripts. It is the main source of fresh detail.

Task: build the final body for memory/YYYY-MM-DD.md.

Rules:
- Return ONLY Markdown sections beginning with \`## ...\`; no H1, no day-topics wrapper, and no footer.
- Preserve all important topics, facts, decisions, open questions, and links from EXISTING_MEMORY unless GENERATED_FROM_TRANSCRIPTS clearly contradicts them.
- If a topic exists only in EXISTING_MEMORY, still carry it into the final output; existing memory is a safety net for transcript misses.
- If a topic exists in both inputs, merge them without duplicate sections while preserving the more specific details.
- If GENERATED_FROM_TRANSCRIPTS clarifies or corrects EXISTING_MEMORY, use the clarified version.
- Write as a third-person memory note in the source conversation language.
- Every bullet must be a complete thought.
- Mark decisions as \`**Decision: ...**\` and open questions as \`*Open question: ...*\`.

`;

const SESSION_FILE_RE = /\.jsonl(?:\.(?:reset|deleted)\..+)?$/;
const TOPIC_ID_RE = /-topic-([^./]+)/;
const MAX_CHARS_PER_TOPIC = 20_000;
const MAX_CHARS_TOTAL = 80_000;
const MAX_EXISTING_MEMORY_CHARS = 120_000;
const INTER_REQUEST_DELAY_MS = 2_000;
const LEGACY_LOCK_STALE_MS = 15 * 60_000;
const LEGACY_DAY_TOPICS_MARKER = "## \u0422\u0435\u043c\u044b \u0434\u043d\u044f";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

export function resolveRuntimeTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timezone === "string" && timezone.trim()) return timezone.trim();
  } catch {
    // Fall back below when the host runtime cannot report a timezone.
  }
  return "UTC";
}

function resolveTimezone(value) {
  const timezone = asString(value).trim();
  return timezone || resolveRuntimeTimezone();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function dayString(date) {
  if (typeof date === "string") return date;
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function parseDay(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new Error(`Invalid date '${raw}', expected YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date '${raw}', expected a real calendar date`);
  }
  return raw;
}

export function parseTs(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function localDate(ts, timezone = resolveRuntimeTimezone()) {
  if (!ts) return null;
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  const resolvedTimezone = resolveTimezone(timezone);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: resolvedTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function defaultTargetDate(timezone = resolveRuntimeTimezone(), now = new Date()) {
  const local = localDate(now, resolveTimezone(timezone));
  const prev = new Date(`${local}T00:00:00.000Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  return dayString(prev);
}

function pathMtimeLocalDate(filePath, timezone) {
  const stat = fs.statSync(filePath);
  return localDate(stat.mtime, timezone);
}

function readSessionDirEntries(config) {
  try {
    return fs.readdirSync(config.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      config.log?.(`Sessions directory not found: ${config.sessionsDir}`);
      return [];
    }
    throw error;
  }
}

export function isSessionFragment(filePath) {
  const name = typeof filePath === "string" ? path.basename(filePath) : filePath.name;
  if (name.endsWith(".trajectory.jsonl")) return false;
  return SESSION_FILE_RE.test(name);
}

export function getSessionRoot(name) {
  return name.replace(SESSION_FILE_RE, "");
}

export function extractTopicKey(name) {
  const match = TOPIC_ID_RE.exec(name);
  return match ? match[1] : `session:${getSessionRoot(name)}`;
}

export function getFiles(config, targetDate = null) {
  const day = targetDate ?? defaultTargetDate(config.timezone);
  const files = [];
  for (const entry of readSessionDirEntries(config)) {
    if (!entry.isFile()) continue;
    if (!isSessionFragment(entry.name)) continue;
    const filePath = path.join(config.sessionsDir, entry.name);
    try {
      if (pathMtimeLocalDate(filePath, config.timezone) >= day) files.push(filePath);
    } catch {
      // Ignore files that disappear while scanning.
    }
  }
  files.sort();
  return { files, day };
}

export function iterSessionFileEntries(config, targetDate) {
  const entries = [];
  for (const entry of readSessionDirEntries(config)) {
    const filePath = path.join(config.sessionsDir, entry.name);
    const item = {
      name: entry.name,
      path: filePath,
      is_file: false,
      is_session_fragment: false,
      mtime_date: null,
      included_by_mtime: false,
      skip_reason: null,
    };

    if (!entry.isFile()) {
      item.skip_reason = "not_file";
      entries.push(item);
      continue;
    }
    item.is_file = true;
    item.is_session_fragment = isSessionFragment(entry.name);
    if (!item.is_session_fragment) {
      item.skip_reason = "not_session_fragment";
      entries.push(item);
      continue;
    }

    try {
      const mtime = pathMtimeLocalDate(filePath, config.timezone);
      item.mtime_date = mtime;
      item.included_by_mtime = mtime >= targetDate;
      if (!item.included_by_mtime) item.skip_reason = "mtime_before_target";
    } catch {
      item.skip_reason = "stat_failed";
    }
    entries.push(item);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export function countRawMessageLines(filePath) {
  let rawMessageLines = 0;
  let userAssistantMessageLines = 0;
  let firstTs = null;
  let lastTs = null;
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== "message") continue;
      rawMessageLines += 1;
      const ts = parseTs(obj.timestamp);
      if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
      if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
      const role = obj?.message?.role;
      if (role === "user" || role === "assistant") userAssistantMessageLines += 1;
    }
  } catch {
    // Coverage is best-effort.
  }
  return {
    raw_message_lines: rawMessageLines,
    user_assistant_message_lines: userAssistantMessageLines,
    first_timestamp: firstTs ? firstTs.toISOString() : null,
    last_timestamp: lastTs ? lastTs.toISOString() : null,
  };
}

export function normalizedTextHash(text) {
  const normalized = String(text || "").split(/\s+/).filter(Boolean).join(" ");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function strictMessageDedupeKey(msg) {
  const ts = msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp_raw || "";
  return [ts, msg.role || "", normalizedTextHash(msg.text || "")];
}

export function dedupeMessagesStrict(messages) {
  const seen = new Set();
  const deduped = [];
  let dropped = 0;
  for (const msg of messages) {
    const key = JSON.stringify(strictMessageDedupeKey(msg));
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    deduped.push(msg);
  }
  return { messages: deduped, dropped };
}

export function cleanUserText(text) {
  if (!text.includes("Conversation info (untrusted metadata):") || !text.includes("Sender (untrusted metadata):")) {
    return text;
  }
  const match = /^\s*Conversation info \(untrusted metadata\):\s*```(?:json)?\s*[\s\S]*?```\s*Sender \(untrusted metadata\):\s*```(?:json)?\s*[\s\S]*?```\s*([\s\S]*)$/.exec(text);
  const actual = match?.[1]?.trim();
  return actual || text;
}

export function isInternalExecutionNoise(role, text) {
  const stripped = String(text || "").trim();
  if (role === "assistant") return stripped.startsWith("Exec completed") || stripped.startsWith("[cron:");
  if (role === "user") {
    const lower = stripped.toLowerCase();
    const compactLower = lower.split(/\s+/).join(" ");
    if (stripped.startsWith("[cron:") && lower.includes("run `")) return true;
    return (
      stripped.startsWith("System (untrusted):") &&
      compactLower.includes("exec completed") &&
      compactLower.includes(":: ok an async command you ran earlier has completed") &&
      compactLower.includes("handle the result internally")
    );
  }
  return false;
}

export function isHeartbeatNoise(role, text) {
  const stripped = String(text || "").trim();
  if (!stripped) return true;
  if (role === "assistant" && (stripped === "HEARTBEAT_OK" || stripped === "NO_REPLY")) return true;
  if (role === "user") {
    const lower = stripped.toLowerCase();
    if (lower.startsWith("read heartbeat.md if it exists")) return true;
    if (lower.includes("if nothing needs attention, reply heartbeat_ok") && lower.includes("current time:")) return true;
  }
  return false;
}

export function isSessionStartupNoise(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes("a new session was started") || lower.includes("new session started") || lower.includes("execute your session startup sequence");
}

function extractMarkerBlock(text, beginMarker, endMarker) {
  if (!text.includes(beginMarker)) return "";
  const afterBegin = text.split(beginMarker, 2)[1];
  return (afterBegin.includes(endMarker) ? afterBegin.split(endMarker, 1)[0] : afterBegin);
}

export function compactInternalContext(text) {
  if (!String(text || "").includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")) return text;
  const task = /^task:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const status = /^status:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const result = extractMarkerBlock(
    text,
    "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
    "<<<END_UNTRUSTED_CHILD_RESULT>>>",
  ).trim();

  const parts = [];
  if (task || status) {
    const details = [];
    if (task) details.push(`task: ${task}`);
    if (status) details.push(`status: ${status}`);
    parts.push(`Internal task completion - ${details.join("; ")}`);
  }
  if (result) parts.push(result);
  return parts.join("\n\n").trim();
}

export function compactExternalUntrustedContent(text) {
  if (!String(text || "").includes("<<<EXTERNAL_UNTRUSTED_CONTENT")) return text;
  return text
    .replace(/\s*<<<EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>+[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>+/g, "\n[external attached content omitted]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTextParts(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text") continue;
    const text = asString(item.text).trim();
    if (text) parts.push(text);
  }
  return parts;
}

export function extractMessages(filePath, targetDate, config = {}) {
  const timezone = resolveTimezone(config.timezone);
  const messages = [];
  let lines;
  try {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  } catch (error) {
    config.log?.(`  Error reading ${filePath}: ${error.message ?? error}`);
    return messages;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type !== "message") continue;

    const tsRaw = asString(obj.timestamp);
    const ts = parseTs(tsRaw);
    if (ts && localDate(ts, timezone) !== targetDate) continue;

    const msg = obj.message ?? {};
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    const parts = [];
    for (let text of extractTextParts(msg.content)) {
      if (isHeartbeatNoise(role, text)) continue;
      if (isInternalExecutionNoise(role, text)) continue;
      if (role === "user") {
        text = cleanUserText(text);
        text = compactInternalContext(text);
        text = compactExternalUntrustedContent(text);
        if (!text || isHeartbeatNoise(role, text) || text.trim().length < 3) continue;
      }
      if (isSessionStartupNoise(text)) continue;
      parts.push(text);
    }
    if (parts.length === 0) continue;

    messages.push({
      role,
      text: parts.join("\n\n").trim(),
      timestamp: ts,
      timestamp_raw: tsRaw,
      line_no: index + 1,
      source: path.basename(filePath),
    });
  }

  return messages;
}

export function isNoiseTopic(messages) {
  const totalUserText = messages.filter((msg) => msg.role === "user").map((msg) => msg.text).join(" ").trim();
  return totalUserText.length < 5;
}

export function buildCoverageReport(config, targetDate = null) {
  const day = targetDate ?? defaultTargetDate(config.timezone);
  const report = {
    target_date: day,
    base_dir: config.sessionsDir,
    files: [],
    topics: {},
    totals: {
      session_fragments: 0,
      included_files: 0,
      files_with_messages_for_date: 0,
      messages_for_date: 0,
      strict_duplicate_messages: 0,
      messages_after_strict_dedupe: 0,
      active_topics: 0,
      noise_topics: 0,
    },
  };
  const messagesByFile = new Map();

  for (const entry of iterSessionFileEntries(config, day)) {
    const fileReport = { ...entry };
    if (entry.is_session_fragment) report.totals.session_fragments += 1;
    if (!entry.included_by_mtime) {
      report.files.push(fileReport);
      continue;
    }

    report.totals.included_files += 1;
    Object.assign(fileReport, countRawMessageLines(entry.path));
    const messages = extractMessages(entry.path, day, config);
    messagesByFile.set(entry.name, messages);
    fileReport.messages_for_date = messages.length;
    fileReport.topic_key = extractTopicKey(entry.name);
    if (messages.length > 0) {
      report.totals.files_with_messages_for_date += 1;
      report.totals.messages_for_date += messages.length;
      const topic = report.topics[fileReport.topic_key] ??= {
        files: [],
        messages_for_date: 0,
        first_timestamp: null,
        last_timestamp: null,
        is_noise: false,
      };
      topic.files.push(entry.name);
      topic.messages_for_date += messages.length;
      for (const msg of messages) {
        if (!msg.timestamp) continue;
        const ts = msg.timestamp.toISOString();
        if (topic.first_timestamp === null || ts < topic.first_timestamp) topic.first_timestamp = ts;
        if (topic.last_timestamp === null || ts > topic.last_timestamp) topic.last_timestamp = ts;
      }
    }
    report.files.push(fileReport);
  }

  for (const [topicKey, topic] of Object.entries(report.topics)) {
    const topicMessages = [];
    for (const fileName of topic.files) {
      topicMessages.push(...(messagesByFile.get(fileName) ?? []));
    }
    topicMessages.sort(compareMessages);
    const { messages, dropped } = dedupeMessagesStrict(topicMessages);
    topic.strict_duplicate_messages = dropped;
    topic.messages_after_strict_dedupe = messages.length;
    report.totals.strict_duplicate_messages += dropped;
    report.totals.messages_after_strict_dedupe += messages.length;
    topic.is_noise = isNoiseTopic(messages);
    if (topic.is_noise) report.totals.noise_topics += 1;
    else report.totals.active_topics += 1;
  }

  return report;
}

export function formatCoverageReport(report) {
  const lines = [
    `Coverage report for ${report.target_date}`,
    `Base dir: ${report.base_dir}`,
    "",
    "Totals:",
  ];
  for (const [key, value] of Object.entries(report.totals)) lines.push(`- ${key}: ${value}`);

  lines.push("\nIncluded files:");
  for (const item of report.files) {
    if (!item.included_by_mtime) continue;
    lines.push(`- ${item.name} topic=${item.topic_key} messages_for_date=${item.messages_for_date ?? 0} raw_messages=${item.raw_message_lines ?? 0} first=${item.first_timestamp ?? null} last=${item.last_timestamp ?? null}`);
  }

  const skipped = report.files.filter((item) => item.skip_reason);
  if (skipped.length > 0) {
    lines.push("\nSkipped files:");
    for (const item of skipped) lines.push(`- ${item.name} reason=${item.skip_reason} mtime=${item.mtime_date ?? null}`);
  }

  lines.push("\nTopics:");
  for (const [topicKey, topic] of Object.entries(report.topics).sort(([a], [b]) => a.localeCompare(b))) {
    const noise = topic.is_noise ? " noise" : "";
    const files = topic.files.join(", ");
    const dedupe = topic.strict_duplicate_messages ?? 0;
    const after = topic.messages_after_strict_dedupe ?? topic.messages_for_date;
    lines.push(`- ${topicKey}: messages=${topic.messages_for_date} after_dedupe=${after} strict_dupes=${dedupe}${noise} files=[${files}] first=${topic.first_timestamp ?? null} last=${topic.last_timestamp ?? null}`);
  }
  return lines.join("\n");
}

export function clipMessageText(text, limit = 2500) {
  if (text.length <= limit) return text;
  return `${text.slice(0, 1200).trimEnd()}\n[...trimmed, preserved ending...]\n${text.slice(-1000).trimStart()}`;
}

export function formatMessage(msg) {
  const prefix = msg.role === "user" ? "User" : "Assistant";
  return `${prefix}: ${clipMessageText(msg.text)}`;
}

export function formatConversation(messages, maxChars = MAX_CHARS_PER_TOPIC) {
  const rendered = messages.map(formatMessage);
  const full = rendered.join("\n\n");
  if (full.length <= maxChars) return full;

  const kept = [];
  let total = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    let line = rendered[index];
    let extra = line.length + (kept.length ? 2 : 0);
    if (kept.length && total + extra > maxChars) break;
    if (!kept.length && line.length > maxChars) {
      line = line.slice(-maxChars);
      extra = line.length;
    }
    kept.push(line);
    total += extra;
  }
  kept.reverse();
  return `[...earlier conversation trimmed to preserve latest context...]\n\n${kept.join("\n\n")}`;
}

export function chunkTopicTexts(topicTexts, maxCharsTotal = MAX_CHARS_TOTAL) {
  const batches = [];
  let current = [];
  let currentSize = 0;
  for (const [topicId, conv] of topicTexts) {
    const topicSize = conv.length + topicId.length + 32;
    if (current.length > 0 && currentSize + topicSize > maxCharsTotal) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push([topicId, conv]);
    currentSize += topicSize;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function normalizeSummary(summary) {
  const lines = String(summary || "").trim().split(/\r?\n/);
  if (lines.length === 0) return "";
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("##") || stripped.startsWith("- ") || stripped.startsWith("* ") || stripped.startsWith("**")) {
      start = i;
      break;
    }
  }
  return lines.slice(start).join("\n").trim();
}

export function isValidSummary(summary) {
  if (!String(summary || "").trim()) return false;
  const normalized = normalizeSummary(summary);
  const lines = normalized.split(/\r?\n/);
  return lines.some((line) => line.startsWith("## ")) && lines.some((line) => line.trimStart().startsWith("- ") || line.trimStart().startsWith("* "));
}

export function clipExistingMemory(text, limit = MAX_EXISTING_MEMORY_CHARS) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  const headLen = Math.floor(limit / 2);
  const tailLen = limit - headLen;
  return `${value.slice(0, headLen).trimEnd()}\n\n[...existing memory clipped in the middle; beginning and ending preserved...]\n\n${value.slice(-tailLen).trimStart()}`;
}

export function extractMemoryTopicsBody(text) {
  if (!text) return "";
  let body = text;
  if (body.includes(LEGACY_DAY_TOPICS_MARKER)) body = body.split(LEGACY_DAY_TOPICS_MARKER, 2)[1];
  const footerMatch = /\n---\nGenerated at /.exec(body);
  if (footerMatch) body = body.slice(0, footerMatch.index);
  return body.trim();
}

export function deterministicMergeFallback(existingBody, generatedSummary) {
  const existing = String(existingBody || "").trim();
  const generated = String(generatedSummary || "").trim();
  if (existing && generated) return `${existing}\n\n${generated}`;
  return generated || existing;
}

async function llmCompleteChecked(llm, prompt, maxTokens) {
  const result = await llm(prompt, { maxTokens });
  if (result && isValidSummary(result)) return normalizeSummary(result);
  const retry = await llm(prompt + FORMAT_REMINDER, { maxTokens });
  if (retry && isValidSummary(retry)) return normalizeSummary(retry);
  return null;
}

export async function mergeWithExistingMemory(llm, existingText, generatedSummary, log = () => {}) {
  const existingBody = clipExistingMemory(extractMemoryTopicsBody(existingText));
  const generated = String(generatedSummary || "").trim();
  if (!existingBody || !generated) return generated;
  const prompt = `${MERGE_PROMPT}\n=== EXISTING_MEMORY ===\n${existingBody}\n\n=== GENERATED_FROM_TRANSCRIPTS ===\n${generated}`;
  log("\nMerging generated summary with existing memory file...");
  const merged = await llmCompleteChecked(llm, prompt, 12000);
  if (merged) return merged;
  log("  Merge pass failed format checks; preserving existing memory with generated summary appended.");
  return deterministicMergeFallback(existingBody, generated);
}

export function backupExistingMemoryFile(memoryFile, _day, backupDir, log = () => {}, now = new Date()) {
  if (!backupDir) {
    log("Backup disabled; existing memory file will be overwritten without backup.");
    return null;
  }
  if (!fs.existsSync(memoryFile)) return null;
  const dir = backupDir;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const parsed = path.parse(memoryFile);
  let backupFile = path.join(dir, `${parsed.name}-${stamp}${parsed.ext}`);
  for (let index = 1; fs.existsSync(backupFile); index += 1) {
    backupFile = path.join(dir, `${parsed.name}-${stamp}-${index}${parsed.ext}`);
  }
  fs.copyFileSync(memoryFile, backupFile);
  log(`Backed up existing memory file to: ${backupFile}`);
  return backupFile;
}

export async function atomicWriteText(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, text, "utf8");
    await fsp.rename(tmp, filePath);
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {});
    throw error;
  }
}

export function acquireDayLock(memoryDir, day) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const lockPath = path.join(memoryDir, `.daymaker-${day}.lock`);
  const openLock = () => {
    const fd = fs.openSync(lockPath, "wx");
    const payload = {
      pid: process.pid,
      processStartTicks: readProcessStartTicks(process.pid),
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    };
    try {
      fs.writeSync(fd, `${JSON.stringify(payload)}\n`);
      return { lockPath, fd };
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // best effort
      }
      throw error;
    }
  };

  try {
    return openLock();
  } catch (error) {
    if (error?.code === "EEXIST") {
      if (removeStaleDayLock(lockPath)) return openLock();
      throw new Error(`Daymaker run already in progress for ${day}: ${lockPath}`);
    }
    throw error;
  }
}

function readProcessStartTicks(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return rest[19] || null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseLockInfo(lockPath) {
  const raw = fs.readFileSync(lockPath, "utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return {
      pid: Number.isInteger(parsed.pid) ? parsed.pid : Number.parseInt(parsed.pid, 10),
      processStartTicks: typeof parsed.processStartTicks === "string" ? parsed.processStartTicks : null,
      legacy: false,
    };
  } catch {
    return {
      pid: Number.parseInt(raw, 10),
      processStartTicks: null,
      legacy: true,
    };
  }
}

function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

function isDayLockActive(lockPath) {
  let info;
  try {
    info = parseLockInfo(lockPath);
  } catch {
    return lockAgeMs(lockPath) < LEGACY_LOCK_STALE_MS;
  }

  const pid = Number.isInteger(info.pid) && info.pid > 0 ? info.pid : null;
  if (!pid) return lockAgeMs(lockPath) < LEGACY_LOCK_STALE_MS;

  if (info.processStartTicks) {
    const currentStartTicks = readProcessStartTicks(pid);
    if (currentStartTicks) return currentStartTicks === info.processStartTicks;
  }

  if (!isProcessAlive(pid)) return false;
  if (info.legacy) return lockAgeMs(lockPath) < LEGACY_LOCK_STALE_MS;
  return true;
}

function removeStaleDayLock(lockPath) {
  if (isDayLockActive(lockPath)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

export function releaseDayLock(lock) {
  try {
    if (lock?.fd !== undefined) fs.closeSync(lock.fd);
  } catch {
    // best effort
  }
  try {
    if (lock?.lockPath) fs.unlinkSync(lock.lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function summarizeBatch(llm, batch, batchIdx, totalBatches, log) {
  const batchBody = batch.map(([topicId, conv]) => `--- TOPIC ${topicId} ---\n${conv}\n`).join("");
  log(`\nBatch ${batchIdx}/${totalBatches}: summarizing ${batch.length} topics...`);
  return await llmCompleteChecked(llm, BATCH_PROMPT + batchBody, 8192);
}

async function summarizeTopic(llm, topicId, conv, log) {
  log(`  Topic ${topicId}...`);
  const result = await llmCompleteChecked(llm, SINGLE_PROMPT + conv, 2048);
  if (result) return result.startsWith("##") ? result : `## Topic ${topicId}\n${result}`;
  return basicFallbackFromConv(topicId, conv);
}

export function basicFallback(messages, topicId) {
  const userMsgs = messages.filter((msg) => msg.role === "user").map((msg) => msg.text);
  if (userMsgs.length === 0) {
    const assistantMsgs = messages.filter((msg) => msg.role === "assistant").map((msg) => msg.text);
    if (assistantMsgs.length === 0) return null;
    const snippet = assistantMsgs[0].slice(0, 150).replace(/\n/g, " ").trim();
    return `## Topic ${topicId}\n- ${snippet}\n- _${messages.length} messages; LLM summary unavailable._`;
  }
  const lines = [`## Topic ${topicId}`];
  for (const msgText of userMsgs.slice(0, 4)) {
    let snippet = msgText.slice(0, 150).replace(/\n/g, " ").trim();
    if (msgText.length > 150) snippet += "...";
    lines.push(`- ${snippet}`);
  }
  lines.push(`- _${messages.length} messages; LLM summary unavailable._`);
  return lines.join("\n");
}

export function basicFallbackFromConv(topicId, conv) {
  let snippet = conv.slice(0, 220).replace(/\n/g, " ").trim();
  if (conv.length > 220) snippet += "...";
  return `## Topic ${topicId}\n- ${snippet}\n- _Summary unavailable; preserved a raw conversation excerpt._`;
}

function compareMessages(a, b) {
  const at = a.timestamp instanceof Date ? a.timestamp.getTime() : -8640000000000000;
  const bt = b.timestamp instanceof Date ? b.timestamp.getTime() : -8640000000000000;
  if (at !== bt) return at - bt;
  const source = String(a.source).localeCompare(String(b.source));
  if (source !== 0) return source;
  return (a.line_no ?? 0) - (b.line_no ?? 0);
}

function collectActiveTopics(config, targetDate, log) {
  const { files, day } = getFiles(config, targetDate);
  log(`Target date: ${day}`);
  log(`Found ${files.length} candidate session files\n`);

  const topics = new Map();
  for (const filePath of files) {
    const messages = extractMessages(filePath, day, { ...config, log });
    if (messages.length === 0) continue;
    const topicKey = extractTopicKey(path.basename(filePath));
    if (!topics.has(topicKey)) topics.set(topicKey, []);
    topics.get(topicKey).push(...messages);
  }

  const activeTopics = new Map();
  for (const [topicKey, messages] of topics.entries()) {
    messages.sort(compareMessages);
    const deduped = dedupeMessagesStrict(messages);
    if (deduped.dropped) log(`  Strict dedupe: ${topicKey}: dropped ${deduped.dropped}/${messages.length} duplicate messages`);
    if (isNoiseTopic(deduped.messages)) {
      log(`  Skipping noise: ${topicKey} (${deduped.messages.length} msgs)`);
      continue;
    }
    activeTopics.set(topicKey, deduped.messages);
  }
  log(`\nActive topics: ${activeTopics.size}`);
  return { activeTopics, day };
}

export function createEmbeddedLlm(api, ctx = {}, config = {}) {
  const agentRuntime = api?.runtime?.agent;
  if (!agentRuntime?.runEmbeddedAgent && !agentRuntime?.runEmbeddedPiAgent) {
    throw new Error("Memory Daymaker requires api.runtime.agent.runEmbeddedAgent for LLM turns");
  }
  const runEmbedded = agentRuntime.runEmbeddedAgent?.bind(agentRuntime) ?? agentRuntime.runEmbeddedPiAgent.bind(agentRuntime);
  const stateDir = api.runtime?.state?.resolveStateDir?.() ?? path.join(os.homedir(), ".openclaw");
  const runDir = path.join(stateDir, "memory-daymaker", "llm-runs");
  const modelSpec = resolveConfiguredModelSpec(api.config, config.model);
  const [provider, model] = modelSpec ? modelSpec.split("/", 2) : [];
  if (provider && model) api.logger?.info?.(`memory-daymaker: embedded LLM model ${provider}/${model}`);
  const embeddedConfig = stripExplicitToolAllowlists(api.config);

  return async (prompt, opts = {}) => {
    await fsp.mkdir(runDir, { recursive: true, mode: 0o700 });
    const id = `memory-daymaker-llm-${crypto.randomUUID()}`;
    const workspaceDir = ctx.workspaceDir ?? agentRuntime.resolveAgentWorkspaceDir?.(api.config, ctx.agentId) ?? api.config?.agents?.defaults?.workspace ?? process.cwd();
    const agentDir = agentRuntime.resolveAgentDir?.(api.config, ctx.agentId) ?? path.join(stateDir, "agents", ctx.agentId ?? "main", "agent");
    const result = await runEmbedded({
      sessionId: id,
      runId: id,
      sessionFile: path.join(runDir, `${id}.jsonl`),
      workspaceDir,
      agentDir,
      config: embeddedConfig,
      prompt,
      timeoutMs: 180_000,
      // The cron hook already runs inside OpenClaw's global embedded-agent lane.
      // Run the plugin-owned inner LLM turn inline so it does not queue behind itself.
      enqueue: async (task) => task(),
      trigger: "manual",
      disableTools: true,
      disableMessageTool: true,
      bootstrapContextMode: "lightweight",
      verboseLevel: "off",
      reasoningLevel: "off",
      silentExpected: true,
      ...(provider && model ? { provider, model } : {}),
      ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.messageProvider ? { messageProvider: ctx.messageProvider } : {}),
      ...(ctx.channelId ? { messageChannel: ctx.channelId } : {}),
      ...(opts.maxTokens ? { streamParams: { maxTokens: opts.maxTokens } } : {}),
    });
    const text = (result?.payloads ?? [])
      .filter((payload) => !payload.isError && !payload.isReasoning && payload.text)
      .map((payload) => payload.text.trim())
      .join("\n")
      .trim();
    if (!text) throw new Error("LLM returned empty output");
    return text;
  };
}

function stripToolPolicyAllowlists(policy) {
  if (!isRecord(policy)) return policy;

  let changed = false;
  const next = { ...policy };
  if (hasOwn(next, "allow")) {
    delete next.allow;
    changed = true;
  }
  if (hasOwn(next, "alsoAllow")) {
    delete next.alsoAllow;
    changed = true;
  }

  if (isRecord(policy.byProvider)) {
    const byProvider = { ...policy.byProvider };
    let providerChanged = false;
    for (const [key, value] of Object.entries(policy.byProvider)) {
      const stripped = stripToolPolicyAllowlists(value);
      if (stripped !== value) {
        byProvider[key] = stripped;
        providerChanged = true;
      }
    }
    if (providerChanged) {
      next.byProvider = byProvider;
      changed = true;
    }
  }

  if (isRecord(policy.subagents) && isRecord(policy.subagents.tools)) {
    const subagentTools = stripToolPolicyAllowlists(policy.subagents.tools);
    if (subagentTools !== policy.subagents.tools) {
      next.subagents = { ...policy.subagents, tools: subagentTools };
      changed = true;
    }
  }

  return changed ? next : policy;
}

function stripAgentToolAllowlists(agents) {
  if (!isRecord(agents) || !Array.isArray(agents.list)) return agents;

  let changed = false;
  const list = agents.list.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.tools)) return entry;
    const tools = stripToolPolicyAllowlists(entry.tools);
    if (tools === entry.tools) return entry;
    changed = true;
    return { ...entry, tools };
  });

  return changed ? { ...agents, list } : agents;
}

function stripExplicitToolAllowlists(appConfig) {
  if (!isRecord(appConfig)) return appConfig;

  let changed = false;
  const next = { ...appConfig };
  const tools = stripToolPolicyAllowlists(appConfig.tools);
  if (tools !== appConfig.tools) {
    next.tools = tools;
    changed = true;
  }

  const agents = stripAgentToolAllowlists(appConfig.agents);
  if (agents !== appConfig.agents) {
    next.agents = agents;
    changed = true;
  }

  return changed ? next : appConfig;
}

export function resolveConfiguredModelSpec(appConfig = {}, configuredModel) {
  const value = typeof configuredModel === "string" ? configuredModel.trim() : "";
  if (!value) return "";
  if (value.includes("/")) return value;

  const models = appConfig?.agents?.defaults?.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    for (const [modelId, modelConfig] of Object.entries(models)) {
      if (modelId === value || modelConfig?.alias === value) return modelId;
    }
  }

  return "";
}

export async function runDaymaker(args, config, options = {}) {
  const logLines = [];
  const log = (line = "") => {
    logLines.push(String(line));
    if (options.verbose || options.coverage) options.stdout?.write?.(`${line}\n`);
  };
  const verbose = args.includes("--verbose") || options.verbose === true;
  const coverage = args.includes("--coverage") || options.coverage === true;
  const filteredArgs = args.filter((arg) => arg !== "--verbose" && arg !== "--coverage");

  let targetDate = null;
  const dateFlagIndex = filteredArgs.indexOf("--date");
  if (dateFlagIndex >= 0) {
    if (dateFlagIndex + 1 >= filteredArgs.length) throw new Error("Missing value for --date, expected YYYY-MM-DD");
    targetDate = parseDay(filteredArgs[dateFlagIndex + 1]);
    filteredArgs.splice(dateFlagIndex, 2);
  } else if (filteredArgs[0]) {
    targetDate = parseDay(filteredArgs[0]);
  }

  if (coverage) {
    const report = buildCoverageReport(config, targetDate);
    const text = formatCoverageReport(report);
    options.stdout?.write?.(`${text}\n`);
    return { ok: true, text, log: logLines.join("\n") };
  }

  if (verbose) {
    log("=".repeat(60));
    log("MEMORY DAYMAKER");
    log(`Run at: ${new Date().toISOString()}`);
    log("=".repeat(60));
  }

  const { activeTopics, day } = collectActiveTopics(config, targetDate, log);
  if (activeTopics.size === 0) {
    log("No active topics. Done.");
    options.stdout?.write?.("OK\n");
    return { ok: true, text: "OK", log: logLines.join("\n") };
  }

  const lock = acquireDayLock(config.memoryDir, day);
  try {
    const llm = options.llm ?? createEmbeddedLlm(options.api, options.ctx, config);
    const topicItems = [];
    for (const [topicKey, messages] of activeTopics.entries()) {
      const conv = formatConversation(messages);
      const firstTs = messages[0]?.timestamp ?? new Date(-8640000000000000);
      topicItems.push([firstTs, topicKey, conv]);
    }
    topicItems.sort((a, b) => {
      const time = a[0].getTime() - b[0].getTime();
      return time || a[1].localeCompare(b[1]);
    });

    const topicTexts = topicItems.map(([, topicKey, conv]) => [topicKey, conv]);
    const totalChars = topicTexts.reduce((sum, [, conv]) => sum + conv.length, 0);
    log(`Total conversation text: ~${Math.floor(totalChars / 1000)}k chars`);

    const summaryParts = [];
    const batches = chunkTopicTexts(topicTexts, MAX_CHARS_TOTAL);
    if (batches.length === 1) {
      const result = await summarizeBatch(llm, batches[0], 1, 1, log);
      if (result) summaryParts.push(result);
      else {
        log("\nSingle batch failed format/summary checks, falling back to per-topic mode...");
        for (const [topicId, conv] of topicTexts) {
          summaryParts.push(await summarizeTopic(llm, topicId, conv, log));
          await sleep(options.interRequestDelayMs ?? INTER_REQUEST_DELAY_MS);
        }
      }
    } else {
      log(`\nLarge day detected, using chunked batch mode (${batches.length} batches)...`);
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        const result = await summarizeBatch(llm, batch, index + 1, batches.length, log);
        if (result) summaryParts.push(result);
        else {
          log(`  Batch ${index + 1} failed, falling back to per-topic summaries for that batch...`);
          for (const [topicId, conv] of batch) {
            summaryParts.push(await summarizeTopic(llm, topicId, conv, log));
            await sleep(options.interRequestDelayMs ?? INTER_REQUEST_DELAY_MS);
          }
        }
        await sleep(options.interRequestDelayMs ?? INTER_REQUEST_DELAY_MS);
      }
    }

    let summaryMd = summaryParts.filter((part) => part && part.trim()).join("\n\n");
    if (!summaryMd.trim()) {
      log("\nAll LLM summaries failed. Using basic fallback...");
      const sections = [];
      for (const [topicId, messages] of activeTopics.entries()) {
        const fallback = basicFallback(messages, topicId);
        if (fallback) sections.push(fallback);
      }
      summaryMd = sections.join("\n\n");
    }

    await fsp.mkdir(config.memoryDir, { recursive: true });
    const memoryFile = path.join(config.memoryDir, `${day}.md`);
    if (fs.existsSync(memoryFile)) {
      const existingMemory = fs.readFileSync(memoryFile, "utf8");
      summaryMd = await mergeWithExistingMemory(llm, existingMemory, summaryMd, log);
    }

    const output = `${summaryMd.trimEnd()}\n`;
    backupExistingMemoryFile(memoryFile, day, config.backupDir, log);
    await atomicWriteText(memoryFile, output);

    log(`\nWrote: ${memoryFile}`);
    log(`Size: ${output.length} chars`);
    options.stdout?.write?.("OK\n");
    return { ok: true, text: "OK", output, log: logLines.join("\n") };
  } finally {
    releaseDayLock(lock);
  }
}
