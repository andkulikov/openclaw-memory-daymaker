import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pluginEntry, {
  CRON_TAG,
  CRON_TOOL_NAME,
  CRON_TRIGGER_TOKEN,
  DAYMAKER_TOOL_NAME,
  buildCronJob,
  buildCronPatch,
  buildDaymakerFailureReply,
  buildDelivery,
  buildFailureAlert,
  createDaymakerRunTool,
  formatDaymakerFailure,
  hostSupportsNativeCronHook,
  isDaymakerCronContext,
  isDaymakerCronTrigger,
  isManagedCronJob,
  parseVersion,
  parseDaymakerCronTrigger,
  parseScheduleTime,
  pluginEntryIsDisabled,
  pluginAllowsConversationAccess,
  reconcileManagedCron,
  resolvePluginConfig,
  resolveScheduleExecutionMode,
  shouldHandleDaymakerCronTrigger,
} from '../index.js';
import {
  acquireDayLock,
  atomicWriteText,
  backupExistingMemoryFile,
  buildCoverageReport,
  cleanUserText,
  compactExternalUntrustedContent,
  compactInternalContext,
  createEmbeddedLlm,
  dedupeMessagesStrict,
  extractMemoryTopicsBody,
  extractMessages,
  extractTopicKey,
  formatConversation,
  formatCoverageReport,
  isHeartbeatNoise,
  isInternalExecutionNoise,
  isSessionFragment,
  isValidSummary,
  localDate,
  mergeWithExistingMemory,
  parseDay,
  releaseDayLock,
  resolveConfiguredModelSpec,
  resolveRuntimeTimezone,
  runDaymaker,
  strictMessageDedupeKey,
} from '../daymaker.js';

test('parseScheduleTime validates HH:MM', () => {
  assert.deepEqual(parseScheduleTime('00:05'), { hour: 0, minute: 5 });
  assert.deepEqual(parseScheduleTime('9:30'), { hour: 9, minute: 30 });
  assert.throws(() => parseScheduleTime('24:00'));
  assert.throws(() => parseScheduleTime('bad'));
});

test('parseDay validates real YYYY-MM-DD calendar dates', () => {
  assert.equal(parseDay('2026-02-28'), '2026-02-28');
  assert.equal(parseDay('2024-02-29'), '2024-02-29');
  assert.throws(() => parseDay('2026-02-31'));
  assert.throws(() => parseDay('2025-02-29'));
  assert.throws(() => parseDay('bad'));
});

test('buildCronJob uses private token payload with cron-only self-disable fallback', () => {
  const job = buildCronJob(
    { timezone: 'Europe/Berlin', schedule: { enabled: true, time: '01:15' } },
  );
  assert.equal(job.name, 'Memory Daymaker Daily');
  assert.match(job.description, /\[managed-by=memory-daymaker\]/);
  assert.equal(job.enabled, true);
  assert.equal(job.schedule.expr, '15 1 * * *');
  assert.equal(job.schedule.tz, 'Europe/Berlin');
  assert.equal(job.payload.kind, 'agentTurn');
  assert.equal(job.payload.message.split('\n', 1)[0], CRON_TRIGGER_TOKEN);
  assert.equal('model' in job.payload, false);
  assert.equal('thinking' in job.payload, false);
  assert.equal(job.payload.lightContext, true);
  assert.deepEqual(job.payload.toolsAllow, [CRON_TOOL_NAME]);
  assert.deepEqual(job.delivery, { mode: 'none' });
  assert.deepEqual(job.failureAlert, {});
});

test('buildCronJob passes configured model as cron preflight override only', () => {
  const job = buildCronJob({ model: 'mini' });
  assert.equal(job.payload.kind, 'agentTurn');
  assert.equal(job.payload.message.split('\n', 1)[0], CRON_TRIGGER_TOKEN);
  assert.equal(job.payload.model, 'mini');
  assert.equal('thinking' in job.payload, false);
  assert.deepEqual(job.payload.toolsAllow, [CRON_TOOL_NAME]);

  const scheduled = buildCronJob({ model: 'mini', schedule: { model: 'openai/gpt-test' } });
  assert.equal(scheduled.payload.model, 'openai/gpt-test');
});

test('buildCronJob can use compatibility tool execution mode', () => {
  const job = buildCronJob({ model: 'mini' }, { executionMode: 'tool' });
  assert.equal(job.payload.kind, 'agentTurn');
  assert.match(job.payload.message, new RegExp(DAYMAKER_TOOL_NAME));
  assert.deepEqual(job.payload.toolsAllow, [DAYMAKER_TOOL_NAME, CRON_TOOL_NAME]);
  assert.equal(job.payload.lightContext, true);
  assert.equal(job.payload.model, 'mini');
  assert.equal('thinking' in job.payload, false);
});

test('host version detection selects native cron hook when available', () => {
  assert.deepEqual(parseVersion('2026.4.29-beta.2'), { major: 2026, minor: 4, patch: 29 });
  assert.equal(hostSupportsNativeCronHook({ runtime: { version: '2026.4.22' } }), false);
  assert.equal(hostSupportsNativeCronHook({ runtime: { version: '2026.4.23' } }), false);
  assert.equal(hostSupportsNativeCronHook({ runtime: { version: '2026.4.24' } }), true);
  assert.equal(hostSupportsNativeCronHook({ runtime: { version: '2026.4.29-beta.2' } }), true);
  assert.equal(pluginAllowsConversationAccess({}, { plugins: { entries: { 'memory-daymaker': { hooks: { allowConversationAccess: true } } } } }), true);
  assert.equal(pluginEntryIsDisabled({ plugins: { entries: { 'memory-daymaker': { enabled: false } } } }), true);
  assert.equal(pluginEntryIsDisabled({ plugins: { entries: { 'memory-daymaker': { enabled: true } } } }), false);
  assert.equal(resolveScheduleExecutionMode({ runtime: { version: '2026.4.22' } }, {}), 'tool');
  assert.equal(resolveScheduleExecutionMode({ runtime: { version: '2026.4.23' } }, {}), 'tool');
  assert.equal(resolveScheduleExecutionMode({ runtime: { version: '2026.4.24' } }, {}), 'tool');
  assert.equal(
    resolveScheduleExecutionMode(
      { runtime: { version: '2026.4.24' } },
      {},
      { plugins: { entries: { 'memory-daymaker': { hooks: { allowConversationAccess: true } } } } },
    ),
    'native',
  );
  assert.equal(resolveScheduleExecutionMode({ runtime: { version: '2026.4.24' } }, { schedule: { mode: 'tool' } }), 'tool');
  assert.equal(resolveScheduleExecutionMode({ runtime: { version: '2026.4.22' } }, { schedule: { mode: 'native' } }), 'native');
});

test('resolvePluginConfig derives runtime timezone and OpenClaw directories', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-runtime-'));
  const workspaceRoot = path.join(tmp, 'workspace');
  const api = {
    config: {
      plugins: {
        entries: {
          'memory-daymaker': {
            config: {
              schedule: { time: '03:20' },
            },
          },
        },
      },
    },
    runtime: {
      state: {
        resolveStateDir: () => tmp,
      },
      agent: {
        resolveAgentWorkspaceDir: (_cfg, agentId) => path.join(workspaceRoot, agentId),
        resolveAgentDir: (_cfg, agentId) => path.join(tmp, 'agents', agentId, 'agent'),
      },
    },
  };

  const config = resolvePluginConfig(api, api.config, { agentId: 'side' });
  assert.equal(config.sessionsDir, path.join(tmp, 'agents', 'side', 'sessions'));
  assert.equal(config.memoryDir, path.join(workspaceRoot, 'side', 'memory'));
  assert.equal(config.backupDir, path.join(workspaceRoot, 'side', 'backups', 'memory-daymaker'));
  assert.equal(config.timezone, resolveRuntimeTimezone());
  assert.equal(config.schedule.time, '03:20');
});

test('resolvePluginConfig keeps explicit directories and can disable backups', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-runtime-'));
  const api = {
    pluginConfig: {
      timezone: 'UTC',
      sessionsDir: '/sessions',
      memoryDir: '/memory',
      backupDir: '',
    },
    runtime: {
      state: {
        resolveStateDir: () => tmp,
      },
    },
  };

  const config = resolvePluginConfig(api, {});
  assert.equal(config.timezone, 'UTC');
  assert.equal(config.sessionsDir, '/sessions');
  assert.equal(config.memoryDir, '/memory');
  assert.equal(config.backupDir, '');
});

test('buildDelivery keeps normal cron delivery quiet', () => {
  assert.deepEqual(
    buildDelivery({ schedule: { delivery: { to: '123' } } }),
    { mode: 'none' },
  );
});

test('buildFailureAlert allows minimal schedule overrides', () => {
  assert.deepEqual(
    buildFailureAlert({ schedule: { failureAlert: { to: '123', cooldownMs: 1000 } } }),
    {
      to: '123',
      cooldownMs: 1000,
    },
  );
});

test('buildFailureAlert uses legacy delivery as destination fallback', () => {
  assert.deepEqual(
    buildFailureAlert({ schedule: { delivery: { to: '123' } } }),
    {
      to: '123',
    },
  );
});

test('buildFailureAlert can be disabled explicitly', () => {
  assert.equal(buildFailureAlert({ schedule: { delivery: { to: '123' }, failureAlert: false } }), false);
});

test('buildFailureAlert treats true as enabled with OpenClaw defaults', () => {
  assert.deepEqual(buildFailureAlert({ schedule: { failureAlert: true } }), {});
});

test('isDaymakerCronTrigger accepts bare and OpenClaw-wrapped cron token', () => {
  assert.equal(isDaymakerCronTrigger(CRON_TRIGGER_TOKEN), true);
  assert.deepEqual(parseDaymakerCronTrigger(CRON_TRIGGER_TOKEN), { matched: true, wrapped: false });
  assert.equal(isDaymakerCronTrigger(`${CRON_TRIGGER_TOKEN}\nFallback instructions`), true);
  assert.deepEqual(parseDaymakerCronTrigger(`${CRON_TRIGGER_TOKEN}\nFallback instructions`), { matched: true, wrapped: false });
  assert.equal(
    isDaymakerCronTrigger(`[cron:c65d Memory Daymaker Daily] ${CRON_TRIGGER_TOKEN}
Current time: Thursday, April 30th, 2026 - 6:11 PM (Europe/Berlin)`),
    true,
  );
  assert.deepEqual(
    parseDaymakerCronTrigger(`[cron:c65d Memory Daymaker Daily] ${CRON_TRIGGER_TOKEN}
Current time: Thursday, April 30th, 2026 - 6:11 PM (Europe/Berlin)`),
    { matched: true, wrapped: true },
  );
  assert.equal(isDaymakerCronTrigger('please run daymaker'), false);
});

test('shouldHandleDaymakerCronTrigger requires cron context for bare token', () => {
  assert.equal(shouldHandleDaymakerCronTrigger(CRON_TRIGGER_TOKEN, { trigger: 'user' }), false);
  assert.equal(
    shouldHandleDaymakerCronTrigger(CRON_TRIGGER_TOKEN, { sessionKey: 'agent:main:cron:c65d2e84' }),
    true,
  );
  assert.equal(shouldHandleDaymakerCronTrigger(CRON_TRIGGER_TOKEN, { messageProvider: 'cron-event' }), true);
  assert.equal(
    shouldHandleDaymakerCronTrigger(`[cron:c65d Memory Daymaker Daily] ${CRON_TRIGGER_TOKEN}`, { trigger: 'user' }),
    true,
  );
});

test('isDaymakerCronContext recognizes OpenClaw cron session context', () => {
  assert.equal(isDaymakerCronContext({ trigger: 'cron' }), true);
  assert.equal(isDaymakerCronContext({ sessionKey: 'agent:main:cron:c65d2e84:run:session' }), true);
  assert.equal(isDaymakerCronContext({ channelId: 'cron-event' }), true);
  assert.equal(isDaymakerCronContext({ sessionKey: 'agent:main:chat:direct:12345' }), false);
});

test('plugin registers before_agent_reply as typed hook', () => {
  const lifecycle = [];
  const tools = [];
  pluginEntry.register({
    registrationMode: 'full',
    logger: {},
    on(name, handler, opts) {
      lifecycle.push({ name, handler, opts });
    },
    registerTool(factory) {
      tools.push(factory);
    },
    registerHook() {
      throw new Error('before_agent_reply should use typed api.on');
    },
    registerCli() {},
  });

  assert.equal(tools.length, 1);
  assert.equal(lifecycle.some(({ name }) => name === 'gateway_start'), true);
  const hook = lifecycle.find(({ name }) => name === 'before_agent_reply');
  assert.equal(typeof hook.handler, 'function');
  assert.equal(hook.opts.timeoutMs > 0, true);
});

test('isManagedCronJob recognizes new and legacy jobs', () => {
  assert.equal(isManagedCronJob({ description: `${CRON_TAG} x` }), true);
  assert.equal(isManagedCronJob({ id: 'memory-daymaker-daily' }), true);
  assert.equal(isManagedCronJob({ managedBy: 'memory-daymaker' }), true);
  assert.equal(
    isManagedCronJob({
      name: 'Memory Daymaker Daily',
      payload: { kind: 'agentTurn', message: `${CRON_TRIGGER_TOKEN}\nFallback instructions` },
    }),
    true,
  );
  assert.equal(
    isManagedCronJob({
      name: 'Memory Daymaker Daily',
      payload: { kind: 'agentTurn', message: 'Run `/x/memory-daymaker/bin/daymaker-run`.' },
    }),
    true,
  );
  assert.equal(
    isManagedCronJob({
      name: 'Daily Memory Log',
      payload: { kind: 'agentTurn', message: 'Run `./scripts/collect_memory.py`.' },
    }),
    true,
  );
  assert.equal(isManagedCronJob({ name: 'Other' }), false);
});

test('buildCronPatch updates legacy exec payload and replaces stale tool allowlist', () => {
  const desired = buildCronJob({ timezone: 'Europe/Berlin', schedule: { time: '02:10' } });
  const patch = buildCronPatch(
    {
      name: 'Memory Daymaker Daily',
      description: 'Daily Memory Daymaker run managed by the memory-daymaker plugin',
      enabled: true,
      schedule: { kind: 'cron', expr: '5 0 * * *', tz: 'Europe/Berlin' },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: {
        kind: 'agentTurn',
        message: 'Run `/x/memory-daymaker/bin/daymaker-run`.',
        timeoutSeconds: 3600,
        lightContext: true,
        model: 'memory-daymaker/daymaker-run',
        thinking: 'off',
        toolsAllow: ['exec', 'process'],
      },
    },
    desired,
  );

  assert.equal(patch.description, desired.description);
  assert.deepEqual(patch.schedule, desired.schedule);
  assert.equal(patch.payload.message.split('\n', 1)[0], CRON_TRIGGER_TOKEN);
  assert.equal(patch.payload.model, null);
  assert.equal(patch.payload.thinking, null);
  assert.deepEqual(patch.payload.toolsAllow, [CRON_TOOL_NAME]);
});

test('buildCronPatch updates configured cron preflight model and cron fallback tool', () => {
  const desired = buildCronJob({ model: 'mini' });
  const patch = buildCronPatch(
    {
      name: desired.name,
      description: desired.description,
      enabled: true,
      schedule: desired.schedule,
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: {
        kind: 'agentTurn',
        message: CRON_TRIGGER_TOKEN,
        timeoutSeconds: desired.payload.timeoutSeconds,
        lightContext: true,
      },
      delivery: desired.delivery,
      failureAlert: desired.failureAlert,
    },
    desired,
  );

  assert.deepEqual(patch, { payload: desired.payload });
});

test('buildCronPatch preserves desired tool allowlist in compatibility mode', () => {
  const desired = buildCronJob({ model: 'mini' }, { executionMode: 'tool' });
  const patch = buildCronPatch(
    {
      name: desired.name,
      description: desired.description,
      enabled: true,
      schedule: desired.schedule,
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: {
        kind: 'agentTurn',
        message: CRON_TRIGGER_TOKEN,
        timeoutSeconds: desired.payload.timeoutSeconds,
        lightContext: true,
      },
      delivery: desired.delivery,
      failureAlert: desired.failureAlert,
    },
    desired,
  );

  assert.deepEqual(patch, { payload: desired.payload });
  assert.deepEqual(patch.payload.toolsAllow, [DAYMAKER_TOOL_NAME, CRON_TOOL_NAME]);
});

test('buildCronPatch replaces compatibility tool allowlist in native mode', () => {
  const desired = buildCronJob({ model: 'mini' });
  const patch = buildCronPatch(
    {
      name: desired.name,
      description: desired.description,
      enabled: true,
      schedule: desired.schedule,
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: {
        kind: 'agentTurn',
        message: 'Run through tool',
        timeoutSeconds: desired.payload.timeoutSeconds,
        lightContext: true,
        model: 'mini',
        toolsAllow: [DAYMAKER_TOOL_NAME],
      },
      delivery: desired.delivery,
      failureAlert: desired.failureAlert,
    },
    desired,
  );

  assert.equal(patch.payload.message.split('\n', 1)[0], CRON_TRIGGER_TOKEN);
  assert.deepEqual(patch.payload.toolsAllow, [CRON_TOOL_NAME]);
});

test('reconcileManagedCron adds, updates, prunes, and removes managed jobs through cron service', async () => {
  const calls = [];
  const jobs = [];
  const cron = {
    async list() {
      return jobs;
    },
    async add(job) {
      calls.push(['add', job]);
      jobs.push({ ...job, id: `job-${jobs.length + 1}`, createdAtMs: Date.now() + jobs.length });
      return jobs.at(-1);
    },
    async update(id, patch) {
      calls.push(['update', id, patch]);
      const index = jobs.findIndex((job) => job.id === id);
      jobs[index] = { ...jobs[index], ...patch };
      return jobs[index];
    },
    async remove(id) {
      calls.push(['remove', id]);
      const index = jobs.findIndex((job) => job.id === id);
      if (index >= 0) jobs.splice(index, 1);
      return { removed: index >= 0 };
    },
  };
  const api = {
    logger: {},
    config: { plugins: { entries: { 'memory-daymaker': { hooks: { allowConversationAccess: true } } } } },
    pluginConfig: { timezone: 'Europe/Berlin', schedule: { time: '00:05' } },
  };

  let result = await reconcileManagedCron(api, { getCron: () => cron });
  assert.equal(result.status, 'added');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.message.split('\n', 1)[0], CRON_TRIGGER_TOKEN);

  jobs.push({
    id: 'legacy',
    createdAtMs: 1,
    name: 'Memory Daymaker Daily',
    description: 'Daily Memory Daymaker run managed by the memory-daymaker plugin',
    enabled: true,
    schedule: { kind: 'cron', expr: '5 0 * * *', tz: 'Europe/Berlin' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'Run `/x/bin/daymaker-run`.', toolsAllow: ['exec'] },
  });

  result = await reconcileManagedCron(api, { getCron: () => cron });
  assert.equal(result.status, 'updated');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.message.split('\n', 1)[0], CRON_TRIGGER_TOKEN);
  assert.deepEqual(jobs[0].payload.toolsAllow, [CRON_TOOL_NAME]);
  assert.equal(calls.some(([name]) => name === 'remove'), true);
  assert.equal(calls.filter(([name]) => name === 'add').length, 1);

  api.pluginConfig = { timezone: 'Europe/Berlin', schedule: { enabled: false, time: '00:05' } };
  result = await reconcileManagedCron(api, { getCron: () => cron });
  assert.equal(result.status, 'disabled');
  assert.equal(jobs.length, 0);
});

test('reconcileManagedCron disables stale jobs when plugin entry is disabled and re-enables them later', async () => {
  const calls = [];
  const jobs = [{
    ...buildCronJob(
      { timezone: 'Europe/Berlin', model: 'mini', schedule: { time: '00:05' } },
      { executionMode: 'tool' },
    ),
    id: 'managed',
    createdAtMs: 1,
  }];
  const cron = {
    async list() {
      return jobs;
    },
    async add(job) {
      calls.push(['add', job]);
      jobs.push({ ...job, id: 'new', createdAtMs: 2 });
      return jobs.at(-1);
    },
    async update(id, patch) {
      calls.push(['update', id, patch]);
      const index = jobs.findIndex((job) => job.id === id);
      jobs[index] = { ...jobs[index], ...patch };
      return jobs[index];
    },
    async remove(id) {
      calls.push(['remove', id]);
      throw new Error(`unexpected remove ${id}`);
    },
  };
  const api = {
    logger: {},
    runtime: { version: '2026.4.22' },
    config: {
      plugins: {
        entries: {
          'memory-daymaker': { enabled: false },
        },
      },
    },
    pluginConfig: { timezone: 'Europe/Berlin', model: 'mini', schedule: { time: '00:05' } },
  };

  let result = await reconcileManagedCron(api, { getCron: () => cron });
  assert.equal(result.status, 'plugin-disabled');
  assert.equal(result.disabled, 1);
  assert.equal(jobs[0].enabled, false);
  assert.deepEqual(calls.at(-1), ['update', 'managed', { enabled: false }]);

  api.config.plugins.entries['memory-daymaker'].enabled = true;
  result = await reconcileManagedCron(api, { getCron: () => cron });
  assert.equal(result.status, 'updated');
  assert.equal(jobs[0].enabled, true);
  assert.deepEqual(calls.at(-1), ['update', 'managed', { enabled: true }]);
  assert.equal(calls.some(([name]) => name === 'add'), false);
});

test('reconcileManagedCron uses tool mode on OpenClaw 2026.4.22', async () => {
  const jobs = [];
  const cron = {
    async list() {
      return jobs;
    },
    async add(job) {
      jobs.push({ ...job, id: `job-${jobs.length + 1}`, createdAtMs: Date.now() });
      return jobs.at(-1);
    },
    async update() {
      throw new Error('unexpected update');
    },
    async remove() {
      throw new Error('unexpected remove');
    },
  };
  const api = {
    logger: {},
    runtime: { version: '2026.4.22' },
    pluginConfig: { timezone: 'Europe/Berlin', model: 'mini', schedule: { time: '00:05' } },
  };

  const result = await reconcileManagedCron(api, { getCron: () => cron });
  assert.equal(result.status, 'added');
  assert.match(jobs[0].payload.message, new RegExp(DAYMAKER_TOOL_NAME));
  assert.deepEqual(jobs[0].payload.toolsAllow, [DAYMAKER_TOOL_NAME, CRON_TOOL_NAME]);
  assert.equal(jobs[0].payload.model, 'mini');
});

test('reconcileManagedCron replaces old jobs that have stale model overrides', async () => {
  const jobs = [{
    id: 'old',
    createdAtMs: 1,
    name: 'Memory Daymaker Daily',
    description: 'Daily Memory Daymaker run managed by the memory-daymaker plugin',
    enabled: true,
    schedule: { kind: 'cron', expr: '5 0 * * *', tz: 'Europe/Berlin' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'Run `/x/bin/daymaker-run`.', model: 'mini' },
  }];
  const cron = {
    async list() {
      return jobs;
    },
    async add(job) {
      jobs.push({ ...job, id: 'new', createdAtMs: 2 });
      return jobs.at(-1);
    },
    async update(id, patch) {
      throw new Error(`should replace instead of update ${id} ${JSON.stringify(patch)}`);
    },
    async remove(id) {
      const index = jobs.findIndex((job) => job.id === id);
      if (index >= 0) jobs.splice(index, 1);
      return { removed: index >= 0 };
    },
  };

  const result = await reconcileManagedCron(
    {
      logger: {},
      config: { plugins: { entries: { 'memory-daymaker': { hooks: { allowConversationAccess: true } } } } },
      pluginConfig: { timezone: 'Europe/Berlin', schedule: { time: '00:05' } },
    },
    { getCron: () => cron },
  );
  assert.equal(result.status, 'replaced');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'new');
  assert.equal('model' in jobs[0].payload, false);
  assert.equal('thinking' in jobs[0].payload, false);
});

test('reconcileManagedCron replaces jobs with stale failure alert destinations', async () => {
  const jobs = [{
    id: 'old-alert',
    createdAtMs: 1,
    name: 'Memory Daymaker Daily',
    description: 'Daily Memory Daymaker run managed by the memory-daymaker plugin',
    enabled: true,
    schedule: { kind: 'cron', expr: '5 0 * * *', tz: resolveRuntimeTimezone() },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: CRON_TRIGGER_TOKEN,
      timeoutSeconds: 3720,
      lightContext: true,
      model: 'mini',
    },
    delivery: { mode: 'none' },
    failureAlert: {
      after: 1,
      channel: 'chat',
      to: 'old-destination',
      cooldownMs: 21600000,
      mode: 'announce',
      accountId: 'old-account',
    },
  }];
  const cron = {
    async list() {
      return jobs;
    },
    async add(job) {
      jobs.push({ ...job, id: 'new-alert', createdAtMs: 2 });
      return jobs.at(-1);
    },
    async update(id, patch) {
      throw new Error(`should replace instead of update ${id} ${JSON.stringify(patch)}`);
    },
    async remove(id) {
      const index = jobs.findIndex((job) => job.id === id);
      if (index >= 0) jobs.splice(index, 1);
      return { removed: index >= 0 };
    },
  };

  const result = await reconcileManagedCron(
    { logger: {}, pluginConfig: { model: 'mini', schedule: { time: '00:05' } } },
    { getCron: () => cron },
  );
  assert.equal(result.status, 'replaced');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'new-alert');
  assert.deepEqual(jobs[0].failureAlert, {});
});

test('formatDaymakerFailure prefers collected generator log', () => {
  const error = new Error('run failed');
  error.log = 'Memory Daymaker failed: no model';
  assert.equal(formatDaymakerFailure(error), 'Memory Daymaker failed: no model');
});

test('buildDaymakerFailureReply marks scheduled run as cron failure payload', () => {
  const error = new Error('run failed');
  error.log = 'Memory Daymaker failed: no model';
  assert.deepEqual(buildDaymakerFailureReply(error), {
    text: 'Memory Daymaker failed: no model',
    isError: true,
  });
});

test('extractMemoryTopicsBody strips header and generated footer', () => {
  const text = `# 2026-04-29 - Daily Log

## \u0422\u0435\u043c\u044b \u0434\u043d\u044f

## Topic A
- Useful fact.

---
Generated at 2026-04-30T01:00:00 by collect_memory v8
`;
  assert.equal(extractMemoryTopicsBody(text), '## Topic A\n- Useful fact.');
  assert.equal(extractMemoryTopicsBody('## Topic A\n- Useful fact.'), '## Topic A\n- Useful fact.');
});

test('mergeWithExistingMemory preserves existing through LLM merge or fallback', async () => {
  const calls = [];
  const llm = async (prompt, opts) => {
    calls.push([prompt, opts]);
    return '## Existing and generated\n- A\n- B';
  };

  const merged = await mergeWithExistingMemory(
    llm,
    '# day\n\n## \u0422\u0435\u043c\u044b \u0434\u043d\u044f\n\n## Existing\n- A\n\n---\nGenerated at x',
    '## Generated\n- B',
  );

  assert.equal(merged, '## Existing and generated\n- A\n- B');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].maxTokens, 12000);
  assert.match(calls[0][0], /=== EXISTING_MEMORY ===/);
  assert.match(calls[0][0], /## Existing\n- A/);
  assert.match(calls[0][0], /=== GENERATED_FROM_TRANSCRIPTS ===/);

  const fallback = await mergeWithExistingMemory(async () => 'not valid', '## Existing\n- A', '## Generated\n- B');
  assert.equal(fallback, '## Existing\n- A\n\n## Generated\n- B');
  assert.equal(await mergeWithExistingMemory(llm, '', '## Generated\n- B'), '## Generated\n- B');
});

test('backupExistingMemoryFile and atomicWriteText keep flat timestamped backups only', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-js-'));
  const memoryFile = path.join(tmp, 'memory', '2026-04-29.md');
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, 'important memory', 'utf8');

  const backupDir = path.join(tmp, 'backups', 'memory-daymaker');
  const fixedNow = new Date(2026, 3, 30, 18, 48, 32);
  const backup = backupExistingMemoryFile(memoryFile, '2026-04-29', backupDir, () => {}, fixedNow);
  assert.equal(path.dirname(backup), backupDir);
  assert.equal(path.basename(backup), '2026-04-29-20260430-184832.md');
  assert.equal(fs.readFileSync(backup, 'utf8'), 'important memory');
  assert.equal(fs.existsSync(path.join(path.dirname(memoryFile), '2026-04-29_old.md')), false);

  fs.writeFileSync(memoryFile, 'second memory', 'utf8');
  const secondBackup = backupExistingMemoryFile(memoryFile, '2026-04-29', backupDir, () => {}, fixedNow);
  assert.equal(path.basename(secondBackup), '2026-04-29-20260430-184832-1.md');
  assert.equal(fs.readFileSync(secondBackup, 'utf8'), 'second memory');

  await atomicWriteText(memoryFile, 'new');
  assert.equal(fs.readFileSync(memoryFile, 'utf8'), 'new');
});

test('summary validation and conversation trimming match collector behavior', () => {
  assert.equal(isValidSummary('## Topic\n- item'), true);
  assert.equal(isValidSummary('### Topic\n- item'), false);
  assert.equal(isValidSummary('## Topic\nplain text'), false);

  const rendered = formatConversation([
    { role: 'user', text: `early ${'x'.repeat(400)}`, timestamp: null, source: 's', line_no: 1 },
    { role: 'assistant', text: `middle ${'y'.repeat(400)}`, timestamp: null, source: 's', line_no: 2 },
    { role: 'user', text: 'FINAL DECISION keep this', timestamp: null, source: 's', line_no: 3 },
  ], 180);

  assert.match(rendered, /\[\.\.\.earlier conversation trimmed/);
  assert.match(rendered, /FINAL DECISION keep this/);
  assert.doesNotMatch(rendered, /early /);
});

test('session helpers classify fragments and topic keys', () => {
  assert.equal(isSessionFragment('abc.jsonl'), true);
  assert.equal(isSessionFragment('abc.jsonl.reset.123'), true);
  assert.equal(isSessionFragment('abc.jsonl.deleted.123'), true);
  assert.equal(isSessionFragment('abc.trajectory.jsonl'), false);
  assert.equal(isSessionFragment('abc.txt'), false);
  assert.equal(extractTopicKey('chat-direct-12345-topic-629274.jsonl'), '629274');
  assert.equal(extractTopicKey('plain-session.jsonl.reset.123'), 'session:plain-session');
});

test('extractMessages filters date, heartbeat, startup, and execution noise', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-msg-'));
  const file = path.join(tmp, 'session-topic-1.jsonl');
  const rows = [
    { type: 'message', timestamp: '2026-04-28T22:30:00+00:00', message: { role: 'user', content: [{ type: 'text', text: 'after midnight local' }] } },
    { type: 'message', timestamp: '2026-04-29T22:30:00+00:00', message: { role: 'user', content: [{ type: 'text', text: 'next local day' }] } },
    { type: 'message', timestamp: '2026-04-29T10:01:00+00:00', message: { role: 'assistant', content: [{ type: 'text', text: 'HEARTBEAT_OK' }] } },
    { type: 'message', timestamp: '2026-04-29T10:02:00+00:00', message: { role: 'assistant', content: [{ type: 'text', text: 'Exec completed blah' }] } },
    { type: 'message', timestamp: '2026-04-29T10:03:00+00:00', message: { role: 'user', content: [{ type: 'text', text: 'a new session was started' }] } },
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  const messages = extractMessages(file, '2026-04-29', { timezone: 'Europe/Berlin' });
  assert.deepEqual(messages.map((msg) => msg.text), ['after midnight local']);
});

test('metadata and attachment compaction keep useful content', () => {
  const metadataText = `Conversation info (untrusted metadata):
\`\`\`json
{"message_id":"1"}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"id":"12345"}
\`\`\`

real text`;
  assert.equal(cleanUserText(metadataText), 'real text');

  const internal = compactInternalContext(`<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
task: useful task
status: completed successfully
<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>
important child result
<<<END_UNTRUSTED_CHILD_RESULT>>>
Stats: noisy
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`);
  assert.match(internal, /task: useful task/);
  assert.match(internal, /important child result/);
  assert.doesNotMatch(internal, /Stats: noisy/);

  const external = compactExternalUntrustedContent(`<media:document> <file name="export.csv">
<<<EXTERNAL_UNTRUSTED_CONTENT id="abc">
col1,col2
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>`);
  assert.match(external, /export.csv/);
  assert.match(external, /\[external attached content omitted\]/);
  assert.doesNotMatch(external, /col1,col2/);
});

test('dedupe, heartbeat, and internal execution noise guards match expected edges', () => {
  const ts = new Date('2026-04-29T10:00:00Z');
  const messages = [
    { timestamp: ts, timestamp_raw: ts.toISOString(), role: 'user', text: 'same   text', source: 'a', line_no: 1 },
    { timestamp: ts, timestamp_raw: ts.toISOString(), role: 'user', text: 'same text', source: 'b', line_no: 2 },
    { timestamp: ts, timestamp_raw: ts.toISOString(), role: 'assistant', text: 'same text', source: 'c', line_no: 3 },
  ];
  const { messages: deduped, dropped } = dedupeMessagesStrict(messages);
  assert.equal(dropped, 1);
  assert.deepEqual(deduped.map((msg) => msg.source), ['a', 'c']);
  assert.equal(strictMessageDedupeKey(messages[0])[2].length, 64);

  assert.equal(isHeartbeatNoise('assistant', 'HEARTBEAT_OK'), true);
  assert.equal(isHeartbeatNoise('user', 'check heartbeat logs'), false);
  assert.equal(isInternalExecutionNoise('assistant', '[cron:abc] done'), true);
  assert.equal(isInternalExecutionNoise('user', 'please look at [cron:abc] logs'), false);
});

test('coverage report groups session fragments and formats debug output', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-coverage-'));
  const target = '2026-04-29';
  const writeJsonl = (name, rows, mtime) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
    fs.utimesSync(file, mtime, mtime);
  };
  const rows = (text, timestamp = '2026-04-29T09:00:00+00:00', role = 'user') => [
    { type: 'message', timestamp, message: { role, content: [{ type: 'text', text }] } },
  ];
  writeJsonl('chat-topic-1.jsonl', rows('topic one message'), new Date('2026-04-29T12:00:00Z'));
  writeJsonl('chat-topic-1.jsonl.reset.abc', rows('topic one answer', '2026-04-29T10:00:00+00:00', 'assistant'), new Date('2026-04-29T12:00:00Z'));
  writeJsonl('chat-topic-2.jsonl.deleted.abc', rows('topic two message'), new Date('2026-04-29T12:00:00Z'));
  writeJsonl('old-topic-4.jsonl', rows('old'), new Date('2026-04-28T12:00:00Z'));
  fs.writeFileSync(path.join(tmp, 'not-a-session.txt'), 'ignore', 'utf8');

  const report = buildCoverageReport({ sessionsDir: tmp, timezone: 'UTC' }, target);
  assert.equal(report.totals.session_fragments, 4);
  assert.equal(report.totals.included_files, 3);
  assert.equal(report.totals.files_with_messages_for_date, 3);
  assert.deepEqual(Object.keys(report.topics).sort(), ['1', '2']);
  assert.deepEqual(report.topics['1'].files.sort(), ['chat-topic-1.jsonl', 'chat-topic-1.jsonl.reset.abc']);

  const text = formatCoverageReport(report);
  assert.match(text, /Coverage report for 2026-04-29/);
  assert.match(text, /Included files:/);
  assert.match(text, /chat-topic-1\.jsonl topic=1/);
  assert.match(text, /Skipped files:/);
  assert.match(text, /old-topic-4\.jsonl reason=mtime_before_target/);
});

test('day locks block concurrent runs and release cleanly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-lock-'));
  const lock = acquireDayLock(tmp, '2026-04-29');
  try {
    assert.throws(() => acquireDayLock(tmp, '2026-04-29'), /already in progress/);
  } finally {
    releaseDayLock(lock);
  }
  const lock2 = acquireDayLock(tmp, '2026-04-29');
  releaseDayLock(lock2);
  assert.equal(fs.existsSync(lock2.lockPath), false);
});

test('day locks recover stale interrupted runs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-stale-lock-'));
  const lockPath = path.join(tmp, '.daymaker-2026-04-29.lock');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, processStartTicks: '1' }), 'utf8');

  const lock = acquireDayLock(tmp, '2026-04-29');
  try {
    assert.equal(lock.lockPath, lockPath);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(lockPath, 'utf8')));
  } finally {
    releaseDayLock(lock);
  }
});

test('day locks recover old plain-pid locks after stale window', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-legacy-lock-'));
  const lockPath = path.join(tmp, '.daymaker-2026-04-29.lock');
  fs.writeFileSync(lockPath, String(process.pid), 'utf8');
  const old = new Date(Date.now() - 20 * 60_000);
  fs.utimesSync(lockPath, old, old);

  const lock = acquireDayLock(tmp, '2026-04-29');
  releaseDayLock(lock);
});

test('runDaymaker uses injected LLM and writes daily memory without Python', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-run-'));
  const sessionsDir = path.join(tmp, 'sessions');
  const memoryDir = path.join(tmp, 'memory');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, 'chat-topic-1.jsonl');
  fs.writeFileSync(sessionFile, JSON.stringify({
    type: 'message',
    timestamp: '2026-04-29T09:00:00+00:00',
    message: { role: 'user', content: [{ type: 'text', text: 'Please remember the native JS rewrite decision.' }] },
  }), 'utf8');
  fs.utimesSync(sessionFile, new Date('2026-04-29T12:00:00Z'), new Date('2026-04-29T12:00:00Z'));

  const calls = [];
  const llm = async (prompt) => {
    calls.push(prompt);
    return '## Memory Daymaker rewrite\n- **Decision:** port the generator to native JavaScript and use OpenClaw embedded LLM turns.';
  };
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const result = await runDaymaker(['--date', '2026-04-29'], {
    sessionsDir,
    memoryDir,
    backupDir: '',
    timezone: 'UTC',
  }, { llm, stdout, interRequestDelayMs: 0 });

  assert.equal(result.text, 'OK');
  assert.equal(stdout.text, 'OK\n');
  assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(path.join(memoryDir, '2026-04-29.md'), 'utf8'), /Memory Daymaker rewrite/);
});

test('runDaymaker merges generated summary with an existing memory file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-run-merge-'));
  const sessionsDir = path.join(tmp, 'sessions');
  const memoryDir = path.join(tmp, 'memory');
  const backupDir = path.join(tmp, 'backups');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, '2026-04-29.md'), '## Existing note\n- Preserve this existing-only fact.\n', 'utf8');
  const sessionFile = path.join(sessionsDir, 'chat-topic-1.jsonl');
  fs.writeFileSync(sessionFile, JSON.stringify({
    type: 'message',
    timestamp: '2026-04-29T09:00:00+00:00',
    message: { role: 'user', content: [{ type: 'text', text: 'Add the generated fact.' }] },
  }), 'utf8');
  fs.utimesSync(sessionFile, new Date('2026-04-29T12:00:00Z'), new Date('2026-04-29T12:00:00Z'));

  const prompts = [];
  const llm = async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes('=== EXISTING_MEMORY ===')) {
      return '## Existing note\n- Preserve this existing-only fact.\n\n## Generated note\n- Add the generated fact.';
    }
    return '## Generated note\n- Add the generated fact.';
  };

  await runDaymaker(['--date', '2026-04-29'], {
    sessionsDir,
    memoryDir,
    backupDir,
    timezone: 'UTC',
  }, { llm, stdout: { write() {} }, interRequestDelayMs: 0 });

  const written = fs.readFileSync(path.join(memoryDir, '2026-04-29.md'), 'utf8');
  assert.match(written, /Preserve this existing-only fact/);
  assert.match(written, /Add the generated fact/);
  assert.equal(prompts.length, 2);
  assert.equal(fs.readdirSync(backupDir).length, 1);
});

test('runDaymaker treats a missing sessions directory as an empty day', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-missing-sessions-'));
  const sessionsDir = path.join(tmp, 'missing-sessions');
  const memoryDir = path.join(tmp, 'memory');
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const result = await runDaymaker(['--date', '2026-04-29'], {
    sessionsDir,
    memoryDir,
    backupDir: '',
    timezone: 'UTC',
  }, { stdout });

  assert.equal(result.text, 'OK');
  assert.equal(stdout.text, 'OK\n');
  assert.equal(fs.existsSync(path.join(memoryDir, '2026-04-29.md')), false);

  const report = buildCoverageReport({ sessionsDir, timezone: 'UTC' }, '2026-04-29');
  assert.equal(report.totals.session_fragments, 0);
  assert.equal(report.totals.active_topics, 0);
});

test('memory-daymaker-run tool executes Daymaker without Python', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-tool-'));
  const factory = createDaymakerRunTool({
    logger: {},
    pluginConfig: {
      sessionsDir: path.join(tmp, 'missing-sessions'),
      memoryDir: path.join(tmp, 'memory'),
      backupDir: '',
      timezone: 'UTC',
    },
  });
  const tool = factory({});
  const result = await tool.execute('call-1', { date: '2026-04-29' });

  assert.equal(tool.name, DAYMAKER_TOOL_NAME);
  assert.match(result.content[0].text, /completed successfully/i);
  assert.equal(result.details.status, 'ok');
  assert.equal(fs.existsSync(path.join(tmp, 'memory', '2026-04-29.md')), false);
});

test('createEmbeddedLlm calls OpenClaw embedded agent with tools disabled', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-embedded-'));
  const calls = [];
  const appConfig = {
    tools: {
      profile: 'full',
      allow: ['group:fs', 'group:runtime'],
      alsoAllow: ['cron'],
      byProvider: {
        openai: {
          allow: ['read'],
          deny: ['exec'],
        },
      },
      subagents: {
        tools: {
          allow: ['sessions_spawn'],
          deny: ['cron'],
        },
      },
    },
    agents: {
      defaults: { workspace: tmp },
      list: [{
        id: 'main',
        tools: {
          allow: ['write'],
          alsoAllow: ['edit'],
          deny: ['exec'],
        },
      }],
    },
  };
  const api = {
    config: appConfig,
    runtime: {
      state: { resolveStateDir: () => tmp },
      agent: {
        resolveAgentWorkspaceDir: () => tmp,
        resolveAgentDir: () => path.join(tmp, 'agent'),
        async runEmbeddedAgent(params) {
          calls.push(params);
          return { payloads: [{ text: '## Good\n- Embedded result' }] };
        },
      },
    },
  };

  const llm = createEmbeddedLlm(api, { sessionKey: 'main', agentId: 'main' }, { model: 'openai/gpt-test' });
  const text = await llm('prompt', { maxTokens: 123 });
  assert.equal(text, '## Good\n- Embedded result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].disableTools, true);
  assert.equal(calls[0].disableMessageTool, true);
  assert.equal(calls[0].bootstrapContextMode, 'lightweight');
  assert.equal('toolsAllow' in calls[0], false);
  assert.equal('allow' in calls[0].config.tools, false);
  assert.equal('alsoAllow' in calls[0].config.tools, false);
  assert.equal('allow' in calls[0].config.tools.byProvider.openai, false);
  assert.deepEqual(calls[0].config.tools.byProvider.openai.deny, ['exec']);
  assert.equal('allow' in calls[0].config.tools.subagents.tools, false);
  assert.deepEqual(calls[0].config.tools.subagents.tools.deny, ['cron']);
  assert.equal('allow' in calls[0].config.agents.list[0].tools, false);
  assert.equal('alsoAllow' in calls[0].config.agents.list[0].tools, false);
  assert.deepEqual(appConfig.tools.allow, ['group:fs', 'group:runtime']);
  assert.deepEqual(appConfig.agents.list[0].tools.allow, ['write']);
  assert.equal(calls[0].provider, 'openai');
  assert.equal(calls[0].model, 'gpt-test');
  assert.deepEqual(calls[0].streamParams, { maxTokens: 123 });
  assert.equal(typeof calls[0].enqueue, 'function');
  let inlineRan = false;
  const inlineResult = await calls[0].enqueue(async () => {
    inlineRan = true;
    return 'inline-ok';
  });
  assert.equal(inlineRan, true);
  assert.equal(inlineResult, 'inline-ok');
});

test('createEmbeddedLlm falls back to runEmbeddedPiAgent alias', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-embedded-pi-'));
  const calls = [];
  const api = {
    config: { agents: { defaults: { workspace: tmp } } },
    runtime: {
      state: { resolveStateDir: () => tmp },
      agent: {
        async runEmbeddedPiAgent(params) {
          calls.push(params);
          return { payloads: [{ text: '## Good\n- Alias path result' }] };
        },
      },
    },
  };

  const llm = createEmbeddedLlm(api, {}, {});
  const text = await llm('prompt');
  assert.equal(text, '## Good\n- Alias path result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].disableTools, true);
});

test('resolveConfiguredModelSpec accepts provider specs and OpenClaw model aliases', () => {
  const appConfig = {
    agents: {
      defaults: {
        models: {
          'openai-codex/gpt-5.4-mini': { alias: 'mini' },
        },
      },
    },
  };

  assert.equal(resolveConfiguredModelSpec(appConfig, 'openai/gpt-test'), 'openai/gpt-test');
  assert.equal(resolveConfiguredModelSpec(appConfig, 'mini'), 'openai-codex/gpt-5.4-mini');
  assert.equal(resolveConfiguredModelSpec(appConfig, 'unknown'), '');
});

test('createEmbeddedLlm resolves model alias from OpenClaw config', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daymaker-embedded-alias-'));
  const calls = [];
  const api = {
    config: {
      agents: {
        defaults: {
          workspace: tmp,
          models: {
            'openai-codex/gpt-5.4-mini': { alias: 'mini' },
          },
        },
      },
    },
    runtime: {
      state: { resolveStateDir: () => tmp },
      agent: {
        resolveAgentWorkspaceDir: () => tmp,
        resolveAgentDir: () => path.join(tmp, 'agent'),
        async runEmbeddedAgent(params) {
          calls.push(params);
          return { payloads: [{ text: '## Good\n- Alias result' }] };
        },
      },
    },
  };

  const llm = createEmbeddedLlm(api, {}, { model: 'mini' });
  await llm('prompt');
  assert.equal(calls[0].provider, 'openai-codex');
  assert.equal(calls[0].model, 'gpt-5.4-mini');
});

test('localDate uses configured timezone boundary', () => {
  assert.equal(localDate(new Date('2026-04-28T22:30:00Z'), 'Europe/Berlin'), '2026-04-29');
  assert.equal(localDate('not-a-date', 'UTC'), null);
});
