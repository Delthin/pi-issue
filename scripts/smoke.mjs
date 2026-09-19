// Load the actual TypeScript entry through Pi's loader, with no user config or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'pi-issue-smoke-'));
const savedEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = root;
process.env.USERPROFILE = root;
const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
try {
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  const loader = new DefaultResourceLoader({
    cwd, agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [resolve(process.argv[2] ?? 'index.ts')],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], 'Pi loader must accept the shipped extension');
  assert.equal(loaded.extensions.length, 1, 'Only the isolated extension is loaded');
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ['add_issue', 'list_issues', 'resolve_issue', 'update_issue']);
  assert.ok(extension.commands.has('issues'));
  assert.ok(extension.handlers.has('before_agent_start'));
  const ctx = { cwd, hasUI: false, mode: 'print' };
  const call = (name, args) => extension.tools.get(name).definition.execute('smoke', args, undefined, undefined, ctx);
  await call('add_issue', { title: '打包后加载验证', context: '不调用模型、不读取个人设置' });
  const list = await call('list_issues', {});
  assert.match(JSON.stringify(list.content), /打包后加载验证/);
  await call('resolve_issue', { id: 1, note: 'Verified' });
  const persisted = await readFile(join(cwd, '.pi', 'issues.md'), 'utf8');
  assert.match(persisted, /\[x\] #1/);
  assert.match(persisted, /Verified/);
  console.log('Pi loader smoke passed: four tools, slash command, prompt hook, persisted add/list/resolve.');
} finally {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}
