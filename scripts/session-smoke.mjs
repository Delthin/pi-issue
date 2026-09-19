// Real Pi command dispatch + current-session focus, with a deterministic offline model fixture.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(join(tmpdir(), 'pi-issue-session-smoke-'));
const savedEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_OFFLINE: process.env.PI_OFFLINE };
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_OFFLINE = '1';
const { InMemoryCredentialStore, createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
const {
  createAgentSessionServices, createAgentSessionFromServices,
  ModelRuntime, SessionManager, SettingsManager,
} = await import('@earendil-works/pi-coding-agent');
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network requests forbidden in session smoke'); };
const sessions = [];
try {
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  // Fixture credential never leaves memory; streamFunction below replaces all provider I/O.
  await modelRuntime.setRuntimeApiKey('anthropic', 'offline-fixture-not-a-real-key');
  const model = modelRuntime.getModel('anthropic', 'claude-sonnet-4-5');
  assert.ok(model, 'the pinned Pi package must provide the fixture model definition');
  const entry = resolve(process.argv[2] ?? 'index.ts');
  const errors = [];
  let fixtureTurns = 0;
  let lastModelContext;
  let switchCalls = 0;
  const bind = async (manager) => {
    const services = await createAgentSessionServices({
      cwd, agentDir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: {
        additionalExtensionPaths: [entry],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      },
    });
    const { session, extensionsResult } = await createAgentSessionFromServices({
      services, sessionManager: manager, model, noTools: 'builtin',
    });
    sessions.push(session);
    assert.deepEqual(extensionsResult.errors, []);
    session.agent.streamFunction = (_model, context) => {
      fixtureTurns++;
      lastModelContext = context;
      const stream = createAssistantMessageEventStream();
      const message = {
        role: 'assistant', content: [{ type: 'text', text: 'Offline fixture response; no external model called.' }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now(),
      };
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    };
    const unsupported = async () => { switchCalls++; throw new Error('Session replacement must not be used'); };
    await session.bindExtensions({
      mode: 'rpc',
      uiContext: {
        notify() {}, setStatus() {}, confirm: async () => true,
        select: async () => undefined, input: async () => undefined,
        setEditorText() { throw new Error('start must send a task, not overwrite the editor'); },
      },
      commandContextActions: {
        waitForIdle: unsupported, newSession: unsupported, switchSession: unsupported,
        fork: unsupported, navigateTree: unsupported, reload: unsupported,
      },
      onError: (error) => { errors.push(error); },
    });
    return session;
  };
  const session = await bind(SessionManager.create(cwd, join(agentDir, 'sessions')));
  const originalId = session.sessionId;
  await session.prompt('/issues add 专注问题验证');
  await session.prompt('/issues show 1');
  await session.prompt('/issues browse'); // Cancel is read-only.
  assert.equal(fixtureTurns, 0);
  await session.prompt('/issues start 1');
  const deadline = Date.now() + 5_000;
  while ((fixtureTurns < 1 || session.isStreaming) && errors.length === 0 && Date.now() < deadline) await delay(10);
  assert.deepEqual(errors, []);
  assert.equal(fixtureTurns, 1, 'explicit start must send exactly one task through the real SDK');
  await session.agent.waitForIdle();
  assert.equal(session.sessionId, originalId, 'start must stay in the current conversation');
  assert.match(JSON.stringify(lastModelContext.messages), /专注问题验证/);
  assert.match(lastModelContext.systemPrompt, /focused on issue #1/i);
  assert.ok((await readFile(join(cwd, '.pi', 'issues.local.json'), 'utf8')).includes(originalId));
  const sessionFile = session.sessionFile;
  assert.ok(sessionFile);
  assert.match(await readFile(sessionFile, 'utf8'), /pi-issue-focus/);
  await session.prompt('/issues start 1');
  await session.prompt('/issues resume 1');
  await session.prompt('/issues continue 1');
  await delay(20);
  assert.equal(fixtureTurns, 1, 'duplicate start and history commands must not trigger another task');
  session.dispose();
  const restored = await bind(SessionManager.open(sessionFile));
  assert.equal(restored.sessionId, originalId);
  await restored.prompt('/issues start 1');
  await delay(20);
  assert.equal(fixtureTurns, 1, 'restored focus must prevent duplicate starts');

  // Actual SDK asynchronous preflight rejection: void sendUserMessage reports an error later.
  await restored.prompt('/issues add 异步失败重试验证');
  restored.agent.state.model = undefined;
  await restored.prompt('/issues start 2');
  const failureDeadline = Date.now() + 5_000;
  while (errors.length === 0 && Date.now() < failureDeadline) await delay(10);
  assert.equal(errors.length, 1, 'missing-model failure must be surfaced by the real host');
  assert.equal(fixtureTurns, 1);
  errors.length = 0;
  restored.agent.state.model = model;
  await restored.prompt('/issues start 2');
  assert.equal(fixtureTurns, 1, 'ordinary duplicate start must remain guarded after failure');
  await restored.prompt('/issues retry 2'); // UI fixture explicitly confirms retry.
  const retryDeadline = Date.now() + 5_000;
  while ((fixtureTurns < 2 || restored.isStreaming) && errors.length === 0 && Date.now() < retryDeadline) await delay(10);
  assert.equal(fixtureTurns, 2, 'explicit confirmed retry must recover an asynchronous preflight failure');
  await restored.agent.waitForIdle();
  assert.equal(restored.sessionId, originalId);
  assert.equal(switchCalls, 0, 'no session replacement APIs may be called');
  assert.deepEqual(errors, []);
  console.log('Session smoke passed: current-session start, deterministic offline fixture turns, persisted focus/link, duplicate guard, async-failure retry and read-only history; no switching or network.');
} finally {
  for (const session of sessions) session.dispose();
  globalThis.fetch = previousFetch;
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}
