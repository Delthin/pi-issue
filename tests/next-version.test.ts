import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piIssueExtension, { __testing, parseIssueDocument } from "../index.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const isolatedGitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_NO_LAZY_FETCH: "1",
	GIT_OPTIONAL_LOCKS: "0",
};

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeProject(withGitMarker = true): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-issue-next-"));
	temporaryDirectories.push(root);
	if (withGitMarker) await mkdir(join(root, ".git"));
	return root;
}

async function git(root: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", root, ...args], {
		env: isolatedGitEnv,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	return String(result.stdout).trim();
}

async function makeRealGitProject(): Promise<{ root: string; commit: string; blob: string }> {
	const root = await makeProject(false);
	await execFileAsync("git", ["init", "--quiet", root], { env: isolatedGitEnv });
	await writeFile(join(root, "tracked.txt"), "first\n");
	await git(root, ["-c", "core.hooksPath=/dev/null", "add", "tracked.txt"]);
	await git(root, [
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"user.name=pi-issue tests",
		"-c",
		"user.email=pi-issue@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--quiet",
		"-m",
		"test commit",
	]);
	return {
		root,
		commit: await git(root, ["rev-parse", "HEAD"]),
		blob: await git(root, ["rev-parse", "HEAD:tracked.txt"]),
	};
}

interface Registered {
	tools: Map<string, any>;
	commands: Map<string, any>;
	events: Map<string, any[]>;
	messages: Array<{ message: any; options: any }>;
	entries: Array<{ customType: string; data: any }>;
	userMessages: Array<{ content: any; options: any }>;
	appendEntryImpl?: (customType: string, data: any) => void;
	sendUserMessageImpl?: (content: any, options?: any) => void;
}

function register(): Registered {
	const state: Registered = {
		tools: new Map(), commands: new Map(), events: new Map(), messages: [], entries: [], userMessages: [],
	};
	piIssueExtension({
		registerTool(definition: any) {
			state.tools.set(definition.name, definition);
		},
		registerCommand(name: string, definition: any) {
			state.commands.set(name, definition);
		},
		on(name: string, handler: any) {
			state.events.set(name, [...(state.events.get(name) ?? []), handler]);
		},
		sendMessage(message: any, options: any) {
			state.messages.push({ message, options });
		},
		appendEntry(customType: string, data: any) {
			state.entries.push({ customType, data });
			state.appendEntryImpl?.(customType, data);
		},
		sendUserMessage(content: any, options?: any) {
			state.userMessages.push({ content, options });
			state.sendUserMessageImpl?.(content, options);
		},
	} as any);
	return state;
}

function makeContext(cwd: string, overrides: Record<string, any> = {}) {
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		signal: undefined,
		sessionManager: {
			getSessionId: () => `session-${cwd}`,
			getSessionFile: () => join(cwd, "session.jsonl"),
			getBranch: () => [],
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		waitForIdle: () => { throw new Error("waitForIdle must not be called"); },
		newSession: () => { throw new Error("newSession must not be called"); },
		switchSession: () => { throw new Error("switchSession must not be called"); },
		...overrides,
		ui: {
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => true,
			notify: () => undefined,
			setEditorText: () => undefined,
			...(overrides.ui ?? {}),
		},
	};
}

async function tool(state: Registered, name: string, params: Record<string, unknown>, cwd: string) {
	return state.tools.get(name).execute("call", params, undefined, undefined, makeContext(cwd));
}

async function command(state: Registered, args: string, ctx: any) {
	await state.commands.get("issues").handler(args, ctx);
}

function lastFeedback(state: Registered): string {
	return state.messages.at(-1)?.message.content ?? "";
}

test("commit associations validate real local commits, expand hashes, deduplicate, search, show, clear, and reject unsafe objects", async () => {
	const { root, commit, blob } = await makeRealGitProject();
	const state = register();
	await tool(state, "add_issue", { title: "Commit-backed fix", context: "parser path" }, root);

	await command(state, `link 1 ${commit.slice(0, 12)} ${commit}`, makeContext(root));
	let document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.deepEqual(document.issues[0].commits, [commit]);
	assert.match(await readFile(join(root, ".pi", "issues.md"), "utf8"), new RegExp(`  - 提交：${commit}`));
	assert.match(lastFeedback(state), new RegExp(commit.slice(0, 12)));

	await command(state, "show 1", makeContext(root));
	assert.match(lastFeedback(state), new RegExp(commit));
	await command(state, `search ${commit.slice(8, 20)}`, makeContext(root));
	assert.match(lastFeedback(state), /Commit-backed fix/);
	const searched = await tool(state, "list_issues", { status: "all", query: "PARSER PATH" }, root);
	assert.equal(searched.details.count, 1);

	const before = await readFile(join(root, ".pi", "issues.md"), "utf8");
	await command(state, `link 1 ${blob}`, makeContext(root));
	assert.match(lastFeedback(state), /not a commit/i);
	await command(state, "link 1 deadbee;touch", makeContext(root));
	assert.match(lastFeedback(state), /Invalid commit hash/i);
	await command(state, `link 1 ${"f".repeat(40)}`, makeContext(root));
	assert.match(lastFeedback(state), /unknown, ambiguous, or not a commit/i);
	assert.equal(await readFile(join(root, ".pi", "issues.md"), "utf8"), before);

	await tool(state, "update_issue", { id: 1, commits: [] }, root);
	document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.equal(document.issues[0].commits, undefined);
	await tool(state, "resolve_issue", { id: 1, commits: [commit.slice(0, 10)] }, root);
	document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.deepEqual(document.issues[0].commits, [commit]);
	await tool(state, "resolve_issue", { id: 1, note: "still linked" }, root);
	document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.deepEqual(document.issues[0].commits, [commit], "omitted commits must preserve associations");
});

test("non-Git projects reject non-empty commit associations without affecting ordinary issue behavior", async () => {
	const root = await makeProject(false);
	const state = register();
	await tool(state, "add_issue", { title: "Standalone" }, root);
	const before = await readFile(join(root, ".pi", "issues.md"), "utf8");
	await assert.rejects(() => tool(state, "update_issue", { id: 1, commits: ["a".repeat(40)] }, root), /not a Git repository/);
	assert.equal(await readFile(join(root, ".pi", "issues.md"), "utf8"), before);
	await tool(state, "update_issue", { id: 1, commits: [] }, root);
});

test("commit changes participate in confirmed-delete snapshots", async () => {
	const { root, commit } = await makeRealGitProject();
	const state = register();
	await tool(state, "add_issue", { title: "Do not delete changed issue" }, root);
	await command(
		state,
		"remove 1",
		makeContext(root, {
			ui: {
				confirm: async () => {
					await __testing.linkIssueCommits(root, 1, [commit]);
					return true;
				},
			},
		}),
	);
	assert.match(lastFeedback(state), /changed after confirmation/i);
	assert.deepEqual(parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0].commits, [commit]);
});

test("start focuses and sends exactly one user task in the current session, records the sidecar, and is idempotent", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Focused parser fix", context: "Only parser.ts" });
	const state = register();
	const branch: any[] = [];
	state.appendEntryImpl = (customType, data) => branch.push({ type: "custom", customType, data });
	const notices: string[] = [];
	const sessionFile = join(root, "sessions", "current.jsonl");
	const ctx = makeContext(root, {
		sessionManager: {
			getSessionId: () => "session-123",
			getSessionFile: () => sessionFile,
			getBranch: () => branch,
		},
		ui: { notify: (message: string) => notices.push(message) },
	});

	await command(state, "start 1", ctx);
	assert.deepEqual(state.entries[0], {
		customType: "pi-issue-focus",
		data: { projectRoot: root, issueId: 1, started: true },
	});
	assert.equal(state.userMessages.length, 1);
	assert.match(state.userMessages[0].content, /^Work on project issue #1: Focused parser fix/);
	assert.match(state.userMessages[0].content, /Only parser\.ts/);
	assert.match(notices[0], /start request was submitted to this conversation/i);
	assert.doesNotMatch(notices[0], /completed|resolved/i);
	const local = JSON.parse(await readFile(join(root, ".pi", "issues.local.json"), "utf8"));
	assert.equal(local.issues["1"].length, 1);
	assert.equal(local.issues["1"][0].sessionId, "session-123");
	assert.equal(local.issues["1"][0].sessionFile, sessionFile);

	await command(state, "start 1", ctx);
	assert.equal(state.userMessages.length, 1);
	assert.equal(state.entries.length, 1);
	assert.match(notices.at(-1) ?? "", /already focused.*request was already submitted/i);
});

test("start refuses a busy agent or queued work without waiting", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Busy safety" });
	for (const overrides of [
		{ isIdle: () => false, hasPendingMessages: () => false },
		{ isIdle: () => true, hasPendingMessages: () => true },
	]) {
		const state = register();
		await command(state, "start 1", makeContext(root, overrides));
		assert.match(lastFeedback(state), /busy or already has queued work/i);
		assert.equal(state.entries.length, 0);
		assert.equal(state.userMessages.length, 0);
	}
});

test("start confirmation explains retained context and supports cancellation or replacing another focus", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "First" });
	await __testing.addIssue(root, { title: "Second" });
	const oldConversation = [{ type: "message", message: { role: "user", content: "old task" } }];
	let confirmation = "";
	const cancelled = register();
	await command(cancelled, "start 1", makeContext(root, {
		sessionManager: { getSessionId: () => "old", getSessionFile: () => join(root, "old.jsonl"), getBranch: () => oldConversation },
		ui: { confirm: async (_title: string, message: string) => { confirmation = message; return false; } },
	}));
	assert.match(confirmation, /will not clear the old context/i);
	assert.match(confirmation, /new conversation.*native UI/i);
	assert.equal(cancelled.userMessages.length, 0);

	const switched = register();
	const branch: any[] = [{ type: "custom", customType: "pi-issue-focus", data: { projectRoot: root, issueId: 1, started: true } }];
	switched.appendEntryImpl = (customType, data) => branch.push({ type: "custom", customType, data });
	let confirmed = 0;
	await command(switched, "start 2", makeContext(root, {
		sessionManager: { getSessionId: () => "switch", getSessionFile: () => join(root, "switch.jsonl"), getBranch: () => branch },
		ui: { confirm: async (_title: string, message: string) => { confirmed += 1; assert.match(message, /focused on issue #1/i); return true; } },
	}));
	assert.equal(confirmed, 1);
	assert.equal(switched.userMessages.length, 1);
	assert.equal(switched.entries.at(-1)?.data.issueId, 2);
});

test("same-session concurrent start fails fast while another session remains independent", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Concurrent" });
	const state = register();
	let release!: () => void;
	let entered!: () => void;
	const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
	const releasePromise = new Promise<void>((resolve) => { release = resolve; });
	const history = [{ type: "message", message: { role: "assistant", content: [] } }];
	const first = command(state, "start 1", makeContext(root, {
		sessionManager: { getSessionId: () => "same", getSessionFile: () => join(root, "same.jsonl"), getBranch: () => history },
		ui: { confirm: async () => { entered(); await releasePromise; return false; } },
	}));
	await enteredPromise;
	await command(state, "start 1", makeContext(root, {
		sessionManager: { getSessionId: () => "same", getSessionFile: () => join(root, "same.jsonl"), getBranch: () => history },
	}));
	assert.match(lastFeedback(state), /already in progress for this Pi session/i);

	await command(state, "start 1", makeContext(root, {
		sessionManager: { getSessionId: () => "other", getSessionFile: () => join(root, "other.jsonl"), getBranch: () => [] },
	}));
	assert.equal(state.userMessages.length, 1);
	release();
	await first;
});

test("start rechecks busy state and issue contents after confirmation", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Candidate" });
	const history = [{ type: "message", message: { role: "user", content: "existing" } }];
	let idle = true;
	const busy = register();
	await command(busy, "start 1", makeContext(root, {
		sessionManager: { getSessionId: () => "busy-after", getSessionFile: () => join(root, "busy.jsonl"), getBranch: () => history },
		isIdle: () => idle,
		ui: { confirm: async () => { idle = false; return true; } },
	}));
	assert.match(lastFeedback(busy), /busy or already has queued work/i);
	assert.equal(busy.userMessages.length, 0);

	const changed = register();
	await command(changed, "start 1", makeContext(root, {
		sessionManager: { getSessionId: () => "changed", getSessionFile: () => join(root, "changed.jsonl"), getBranch: () => history },
		ui: { confirm: async () => { await __testing.updateIssue(root, { id: 1, title: "Changed during confirm" }); return true; } },
	}));
	assert.match(lastFeedback(changed), /changed during confirmation.*no task was sent/i);
	assert.equal(changed.userMessages.length, 0);
});

test("a synchronous send failure restores focus and allows retry without duplicating the sidecar", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Retry send" });
	const state = register();
	const branch: any[] = [];
	state.appendEntryImpl = (customType, data) => branch.push({ type: "custom", customType, data });
	let attempts = 0;
	state.sendUserMessageImpl = () => { attempts += 1; if (attempts === 1) throw new Error("sync send failed"); };
	const ctx = makeContext(root, {
		sessionManager: { getSessionId: () => "retry", getSessionFile: () => join(root, "retry.jsonl"), getBranch: () => branch },
	});
	await command(state, "start 1", ctx);
	assert.match(lastFeedback(state), /could not be sent.*Focus was restored/i);
	assert.equal(branch.at(-1).data.active, false);
	await assert.rejects(access(join(root, ".pi", "issues.local.json")), { code: "ENOENT" });
	await command(state, "start 1", ctx);
	assert.equal(attempts, 2);
	assert.equal(branch.at(-1).data.started, true);
	const local = JSON.parse(await readFile(join(root, ".pi", "issues.local.json"), "utf8"));
	assert.equal(local.issues["1"].length, 1);
});

test("sidecar corruption and symlinks are preserved while start reports partial success", async () => {
	for (const kind of ["corrupt", "symlink"] as const) {
		const root = await makeProject();
		await __testing.addIssue(root, { title: `Sidecar ${kind}` });
		const localPath = join(root, ".pi", "issues.local.json");
		let external: string | undefined;
		if (kind === "corrupt") await writeFile(localPath, "not json\n");
		else {
			external = join(await makeProject(false), "outside.json");
			await writeFile(external, "outside\n");
			await symlink(external, localPath);
		}
		const state = register();
		const notices: string[] = [];
		await command(state, "start 1", makeContext(root, { ui: { notify: (message: string) => notices.push(message) } }));
		assert.equal(state.userMessages.length, 1);
		assert.match(notices[0], /start request was submitted.*association could not be saved/i);
		if (kind === "corrupt") assert.equal(await readFile(localPath, "utf8"), "not json\n");
		else assert.equal(await readFile(external!, "utf8"), "outside\n");
	}
});

test("a sidecar lock failure does not cancel a task that was still sent", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Locked sidecar" });
	const lockPath = join(root, ".pi", "issues.local.json.lock");
	await writeFile(lockPath, "foreign lock\n");
	const state = register();
	const notices: string[] = [];
	await command(state, "start 1", makeContext(root, { ui: { notify: (message: string) => notices.push(message) } }));
	assert.equal(state.userMessages.length, 1);
	assert.match(notices[0], /start request was submitted.*Timed out waiting for issue lock/i);
	assert.equal(await readFile(lockPath, "utf8"), "foreign lock\n");
});

test("explicit retry requires confirmation, stays guarded when busy, and does not duplicate session history", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Recover an asynchronous host failure" });
	const state = register();
	const branch: any[] = [];
	state.appendEntryImpl = (customType, data) => branch.push({ type: "custom", customType, data });
	let approve = false;
	let idle = true;
	let confirmations = 0;
	const ctx = makeContext(root, {
		isIdle: () => idle,
		sessionManager: { getSessionId: () => "retry-async", getSessionFile: () => join(root, "retry.jsonl"), getBranch: () => branch },
		ui: { confirm: async (_title: string, text: string) => {
			confirmations++;
			assert.match(text, /can repeat work/);
			return approve;
		} },
	});
	await command(state, "retry 1", ctx);
	assert.match(lastFeedback(state), /no prior start request/);
	await command(state, "start 1", ctx);
	await command(state, "start 1", ctx);
	assert.equal(state.userMessages.length, 1);
	await command(state, "retry 1", ctx);
	assert.equal(confirmations, 1);
	assert.equal(state.userMessages.length, 1, "cancel must not resubmit");
	idle = false;
	approve = true;
	await command(state, "retry 1", ctx);
	assert.equal(confirmations, 1, "busy retry must not even ask");
	idle = true;
	await command(state, "retry 1", ctx);
	assert.equal(state.userMessages.length, 2);
	const local = JSON.parse(await readFile(join(root, ".pi", "issues.local.json"), "utf8"));
	assert.equal(local.issues["1"].length, 1);
});

test("legacy focus without started marker is migrated by the first real start", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Legacy draft" });
	const state = register();
	const branch: any[] = [{ type: "custom", customType: "pi-issue-focus", data: { projectRoot: root, issueId: 1 } }];
	state.appendEntryImpl = (customType, data) => branch.push({ type: "custom", customType, data });
	const ctx = makeContext(root, {
		sessionManager: { getSessionId: () => "legacy", getSessionFile: () => join(root, "legacy.jsonl"), getBranch: () => branch },
	});
	await command(state, "start 1", ctx);
	assert.equal(state.userMessages.length, 1);
	assert.equal(state.entries[0].data.started, true);
	await command(state, "start 1", ctx);
	assert.equal(state.userMessages.length, 1);
});

test("real SessionManager keeps focus metadata in memory but does not create the session file before a sent turn", async () => {
	const root = await makeProject();
	const sessionDir = join(root, "sessions");
	const manager = SessionManager.create(root, sessionDir);
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	manager.appendCustomEntry("pi-issue-focus", { projectRoot: root, issueId: 7, started: true });
	assert.equal(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-issue-focus"), true);
	await assert.rejects(access(sessionFile));
});

test("focus prompt is restored from branch custom entries only for the matching project", async () => {
	const first = await makeProject();
	const second = await makeProject();
	const state = register();
	const handler = state.events.get("before_agent_start")![0];
	const focusEntry = { type: "custom", customType: "pi-issue-focus", data: { projectRoot: first, issueId: 42 } };
	const focused = await handler({ systemPrompt: "base", prompt: "normal user text" }, makeContext(first, { sessionManager: { getBranch: () => [focusEntry] } }));
	assert.match(focused.systemPrompt, /focused on issue #42/i);
	assert.doesNotMatch(focused.systemPrompt, /normal user text/);
	const unrelated = await handler({ systemPrompt: "base", prompt: "x" }, makeContext(second, { sessionManager: { getBranch: () => [focusEntry] } }));
	assert.doesNotMatch(unrelated.systemPrompt, /focused on issue #42/i);
});

test("show output remains bounded for full details", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Large details", context: "x".repeat(100_000) });
	const state = register();
	await command(state, "show 1", makeContext(root));
	const output = lastFeedback(state);
	assert.match(output, /Output truncated:/);
	assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
});

test("commit append limits and hexadecimal ref names cannot corrupt or misassociate issues", async () => {
	const { root, commit } = await makeRealGitProject();
	const state = register();
	await __testing.addIssue(root, { title: "Commit capacity" });
	const hundredHashes = Array.from({ length: 100 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));
	await __testing.updateIssue(root, { id: 1, commits: hundredHashes });
	const before = await readFile(join(root, ".pi", "issues.md"), "utf8");
	await command(state, `link 1 ${commit}`, makeContext(root));
	assert.match(lastFeedback(state), /At most 100/);
	assert.equal(await readFile(join(root, ".pi", "issues.md"), "utf8"), before);
	await git(root, ["update-ref", "refs/heads/deadbee", commit]);
	await assert.rejects(__testing.validateCommitHashes(root, ["deadbee"]), /not a commit/);
});

test("show keeps local history while resume and continue are read-only native-session guidance", async () => {
	const root = await makeProject();
	const state = register();
	await __testing.addIssue(root, { title: "Historical fix" });
	await __testing.resolveIssue(root, 1, "Fixed already");
	const sessionFile = join(root, "history.jsonl");
	await __testing.appendIssueSessionReference(await __testing.storagePaths(root), 1, {
		sessionId: "history-session", sessionFile, createdAt: new Date().toISOString(),
	});
	await command(state, "show 1", makeContext(root));
	assert.match(lastFeedback(state), /Local processing sessions \(1/);
	assert.ok(lastFeedback(state).includes(sessionFile));

	for (const action of ["resume", "continue"]) {
		const beforeEntries = state.entries.length;
		const beforeMessages = state.userMessages.length;
		await command(state, `${action} 1`, makeContext(root));
		assert.match(lastFeedback(state), /Session ID: history-session/);
		assert.ok(lastFeedback(state).includes(`Session path: ${sessionFile}`));
		assert.match(lastFeedback(state), /native session list.*open it manually/i);
		assert.match(lastFeedback(state), /take over issue #1 in this conversation/i);
		assert.match(lastFeedback(state), /run \/issues start 1/i);
		assert.equal(state.entries.length, beforeEntries);
		assert.equal(state.userMessages.length, beforeMessages);
	}
	await command(state, "start 1", makeContext(root));
	assert.match(lastFeedback(state), /only open issues can be started/);
});

test("start reports active-branch failures and non-persistent sidecars without false success", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Branch safety" });
	const broken = register();
	await command(broken, "start 1", makeContext(root, {
		sessionManager: {
			getSessionId: () => "broken",
			getSessionFile: () => join(root, "broken.jsonl"),
			getBranch: () => { throw new Error("branch unavailable"); },
		},
	}));
	assert.match(lastFeedback(broken), /branch unavailable/i);
	assert.equal(broken.entries.length, 0);
	assert.equal(broken.userMessages.length, 0);

	const ephemeral = register();
	const notices: string[] = [];
	await command(ephemeral, "start 1", makeContext(root, {
		sessionManager: { getSessionId: () => "ephemeral", getSessionFile: () => undefined, getBranch: () => [] },
		ui: { notify: (message: string) => notices.push(message) },
	}));
	assert.equal(ephemeral.userMessages.length, 1);
	assert.match(notices[0], /start request was submitted.*no persistent path.*association could not be saved/i);
});

test("browser resolve refuses a candidate edited during confirmation and never resolves unknown actions", async () => {
	const root = await makeProject();
	const state = register();
	await __testing.addIssue(root, { title: "Original" });
	let choices = ["Open", "#1 [open] Original", "Resolve issue"];
	await command(state, "browse", makeContext(root, { ui: {
		select: async () => choices.shift(), input: async () => "",
		confirm: async (_title: string, message: string) => {
			assert.match(message, /Original/);
			await __testing.updateIssue(root, { id: 1, title: "Changed" });
			return true;
		},
	} }));
	assert.equal((await __testing.getIssue(root, 1)).issue.status, "open");
	assert.match(lastFeedback(state), /changed during confirmation/);
	choices = ["Open", "#1 [open] Changed", "Unexpected action"];
	await command(state, "browse", makeContext(root, { ui: {
		select: async () => choices.shift(), input: async () => "",
		confirm: async () => { throw new Error("must not confirm an unknown action"); },
	} }));
	assert.match(lastFeedback(state), /unknown action/);
	assert.equal((await __testing.getIssue(root, 1)).issue.status, "open");
});

test("browser exposes current-conversation start and read-only history labels", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Action labels" });
	const state = register();
	let call = 0;
	let actions: string[] = [];
	await command(state, "browse", makeContext(root, { ui: {
		input: async () => "",
		select: async (_title: string, values: string[]) => {
			call += 1;
			if (call === 1) return "Open";
			if (call === 2) return "#1 [open] Action labels";
			actions = values;
			return "Cancel";
		},
	} }));
	assert.ok(actions.includes("Start in this conversation"));
	assert.ok(actions.includes("View session history"));
	assert.equal(actions.includes("Start focused session"), false);
	assert.equal(actions.includes("Continue latest session"), false);
});

test("browser supports search and cancellation at every lightweight UI stage without mutation", async () => {
	const root = await makeProject();
	await __testing.addIssue(root, { title: "Alpha parser" });
	const state = register();
	const before = await readFile(join(root, ".pi", "issues.md"), "utf8");

	await command(state, "browse", makeContext(root, { ui: { select: async () => "Cancel" } }));
	assert.match(lastFeedback(state), /browser cancelled/i);

	let choices = ["Open"];
	await command(state, "browse", makeContext(root, { ui: { select: async () => choices.shift(), input: async () => undefined } }));
	assert.match(lastFeedback(state), /browser cancelled/i);

	choices = ["Open", undefined as any];
	await command(state, "browse", makeContext(root, { ui: { select: async () => choices.shift(), input: async () => "parser" } }));
	assert.match(lastFeedback(state), /browser cancelled/i);

	choices = ["Open", "#1 [open] Alpha parser", "View full details"];
	await command(state, "browse", makeContext(root, { ui: { select: async () => choices.shift(), input: async () => "ALPHA" } }));
	assert.match(lastFeedback(state), /#1 Alpha parser/);
	assert.equal(await readFile(join(root, ".pi", "issues.md"), "utf8"), before);
});
