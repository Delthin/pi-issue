import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import piIssueExtension, {
	__testing,
	parseIssueDocument,
	serializeIssueDocument,
	type Issue,
} from "../index.ts";

interface RegisteredExtension {
	tools: Map<string, any>;
	commands: Map<string, any>;
	events: Map<string, any[]>;
	messages: Array<{ message: any; options: any }>;
	entries: Array<{ customType: string; data: any }>;
	userMessages: Array<{ content: any; options: any }>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeProject(withGit = true): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-issue-test-"));
	temporaryDirectories.push(root);
	if (withGit) await mkdir(join(root, ".git"));
	return root;
}

function registerExtension(): RegisteredExtension {
	const registered: RegisteredExtension = {
		tools: new Map(),
		commands: new Map(),
		events: new Map(),
		messages: [],
		entries: [],
		userMessages: [],
	};
	const api = {
		registerTool(definition: any) {
			registered.tools.set(definition.name, definition);
		},
		registerCommand(name: string, definition: any) {
			registered.commands.set(name, definition);
		},
		on(name: string, handler: any) {
			const handlers = registered.events.get(name) ?? [];
			handlers.push(handler);
			registered.events.set(name, handlers);
		},
		sendMessage(message: any, options: any) {
			registered.messages.push({ message, options });
		},
		appendEntry(customType: string, data: any) {
			registered.entries.push({ customType, data });
		},
		sendUserMessage(content: any, options?: any) {
			registered.userMessages.push({ content, options });
		},
	};
	piIssueExtension(api as any);
	return registered;
}

function context(
	cwd: string,
	options: {
		hasUI?: boolean;
		confirm?: (title: string, message: string) => Promise<boolean>;
		select?: (title: string, values: string[]) => Promise<string | undefined>;
		input?: (title: string, placeholder?: string) => Promise<string | undefined>;
		notify?: (message: string, level?: string) => void;
		setEditorText?: (text: string) => void;
		sessionManager?: any;
		contextEntries?: any[];
		model?: any;
		modelRegistry?: any;
		isIdle?: () => boolean;
		hasPendingMessages?: () => boolean;
	} = {},
) {
	return {
		cwd,
		hasUI: options.hasUI ?? true,
		mode: options.hasUI === false ? "print" : "tui",
		signal: undefined,
		model: options.model,
		modelRegistry: options.modelRegistry ?? {
			hasConfiguredAuth: () => false,
			complete: async () => { throw new Error("model completion must not be called"); },
		},
		sessionManager:
			options.sessionManager ??
			({
				getSessionId: () => `test-session-${cwd}`,
				getSessionFile: () => join(cwd, "session.jsonl"),
				getBranch: () => [],
				buildContextEntries: () => options.contextEntries ?? [],
			} as any),
		isIdle: options.isIdle ?? (() => true),
		hasPendingMessages: options.hasPendingMessages ?? (() => false),
		waitForIdle: () => { throw new Error("waitForIdle must not be called"); },
		newSession: () => { throw new Error("newSession must not be called"); },
		switchSession: () => { throw new Error("switchSession must not be called"); },
		ui: {
			confirm: options.confirm ?? (async () => true),
			select: options.select ?? (async () => undefined),
			input: options.input ?? (async () => undefined),
			notify: options.notify ?? (() => undefined),
			setEditorText: options.setEditorText ?? (() => undefined),
		},
	};
}

async function executeTool(
	registered: RegisteredExtension,
	name: string,
	params: Record<string, unknown>,
	cwd: string,
	signal?: AbortSignal,
): Promise<any> {
	const tool = registered.tools.get(name);
	assert.ok(tool, `${name} should be registered`);
	return tool.execute("test-call", params, signal, undefined, { ...context(cwd), signal });
}

async function invokeIssuesCommand(
	registered: RegisteredExtension,
	args: string,
	cwd: string,
	options?: Parameters<typeof context>[1],
): Promise<void> {
	const command = registered.commands.get("issues");
	assert.ok(command);
	await command.handler(args, context(cwd, options));
}

function firstText(result: any): string {
	assert.equal(result.content[0].type, "text");
	return result.content[0].text;
}

function deferred<T = void>() {
	let resolvePromise!: (value: T | PromiseLike<T>) => void;
	let rejectPromise!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function assistantResponse(text: string, stopReason = "stop") {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		api: "openai-completions",
		provider: "test",
		model: "context-model",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test("registers exactly four tools, one /issues command, and complete static scope guidance", async () => {
	const registered = registerExtension();
	assert.deepEqual([...registered.tools.keys()].sort(), ["add_issue", "list_issues", "resolve_issue", "update_issue"]);
	assert.deepEqual([...registered.commands.keys()], ["issues"]);
	assert.equal(registered.events.get("before_agent_start")?.length, 1);

	const handler = registered.events.get("before_agent_start")?.[0];
	const secretIssueText = "do-not-inject-this-user-issue";
	const result = await handler({ systemPrompt: "base", prompt: secretIssueText }, context("/tmp"));
	assert.match(result.systemPrompt, /issue inbox and scope convention/i);
	assert.match(result.systemPrompt, /current explicit request defines the scope/i);
	assert.match(result.systemPrompt, /remember, defer, or handle an idea later.*add_issue/i);
	assert.match(result.systemPrompt, /handle existing issues, call list_issues first/i);
	assert.match(result.systemPrompt, /list_issues first.*add_issue/i);
	assert.match(result.systemPrompt, /recorded issue ID.*not implementing it now/i);
	assert.match(result.systemPrompt, /small fixes.*necessary.*current request/i);
	assert.match(result.systemPrompt, /substantial complexity.*ask the user/i);
	assert.match(result.systemPrompt, /explicit user decision to expand/i);
	assert.match(result.systemPrompt, /does not implement it, resolve it, create or link a commit, start a session, or switch sessions/i);
	assert.match(result.systemPrompt, /no model tool for switching conversations/i);
	assert.doesNotMatch(result.systemPrompt, new RegExp(secretIssueText));
});

test("tools preserve multiline context and resolution notes through Markdown round trips", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	const originalContext = "first line\n\ncontains ``` fences\nand a trailing newline\n";
	const originalNote = "fixed in two steps\n1. code\n2. docs\n";

	const added = await executeTool(
		registered,
		"add_issue",
		{ title: "Unify API errors", priority: "high", context: originalContext },
		root,
	);
	assert.match(firstText(added), /Added issue #1/);

	await executeTool(
		registered,
		"update_issue",
		{ id: 1, title: "Unify public API errors", priority: "low", context: originalContext },
		root,
	);
	await executeTool(registered, "resolve_issue", { id: 1, note: originalNote }, root);

	const listed = await executeTool(registered, "list_issues", { status: "all" }, root);
	assert.equal(listed.details.count, 1);
	assert.equal(listed.details.issues[0].context, originalContext);
	assert.equal(listed.details.issues[0].note, originalNote);
	assert.equal(listed.details.issues[0].status, "resolved");

	const markdown = await readFile(join(root, ".pi", "issues.md"), "utf8");
	assert.match(markdown, /<!-- pi-issue: nextId=2 -->/);
	assert.match(markdown, /````text/);
	const parsed = parseIssueDocument(markdown);
	assert.equal(parsed.nextId, 2);
	assert.equal(parsed.issues[0].context, originalContext);
	assert.equal(parsed.issues[0].note, originalNote);
});

test("accepts the SPEC Markdown example and migrates it to nextId metadata on mutation", async () => {
	const root = await makeProject();
	await mkdir(join(root, ".pi"));
	await writeFile(
		join(root, ".pi", "issues.md"),
		`# Issues

## Open

- [ ] #3 登录接口的错误码没有统一 (high) — 2026-05-12
  - 补充：参考 utils/errors.ts 里的约定
- [ ] #4 文档里补一个部署章节 (low) — 2026-05-12

## Resolved

- [x] #1 修复分页越界 — 2026-05-10
`,
	);
	const registered = registerExtension();
	const listed = await executeTool(registered, "list_issues", { status: "all" }, root);
	assert.equal(listed.details.count, 3);
	assert.equal(listed.details.issues.find((issue: Issue) => issue.id === 1)?.priority, "normal");

	const added = await executeTool(registered, "add_issue", { title: "new idea" }, root);
	assert.match(firstText(added), /#5/);
	const rewritten = await readFile(join(root, ".pi", "issues.md"), "utf8");
	assert.match(rewritten, /<!-- pi-issue: nextId=6 -->/);
	assert.match(rewritten, /#1 修复分页越界 \(normal\)/);
});

test("nextId never reuses a deleted ID and all six /issues forms send persistent non-triggering feedback", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	const confirmations = [false, true, true];
	const confirm = async () => confirmations.shift() ?? false;

	await invokeIssuesCommand(registered, "", root, { confirm });
	await invokeIssuesCommand(registered, "add Alpha", root, { confirm });
	await invokeIssuesCommand(registered, "all", root, { confirm });
	await invokeIssuesCommand(registered, "done 1", root, { confirm });
	await invokeIssuesCommand(registered, "remove 1", root, { confirm });
	await invokeIssuesCommand(registered, "remove #1", root, { confirm });
	await invokeIssuesCommand(registered, "add Beta", root, { confirm });
	await invokeIssuesCommand(registered, "done #2", root, { confirm });
	await invokeIssuesCommand(registered, "clear", root, { confirm });

	assert.ok(registered.messages.length >= 9);
	for (const { message, options } of registered.messages) {
		assert.equal(message.display, true);
		assert.equal(message.customType, "pi-issue-command");
		assert.equal(options.triggerTurn, false);
	}
	assert.ok(registered.messages.some(({ message }) => /cancelled/i.test(message.content)));

	const document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.equal(document.nextId, 3);
	assert.deepEqual(document.issues, []);

	const next = await executeTool(registered, "add_issue", { title: "Gamma" }, root);
	assert.match(firstText(next), /#3/);
});

test("recent conversation clipping honors the total cap when the final allowance is smaller than the marker", () => {
	const longMessage = "x".repeat(3_000);
	const entries = [
		{ type: "message", message: { role: "user", content: longMessage } },
		{ type: "message", message: { role: "user", content: "m".repeat(1_952) } },
		...Array.from({ length: 4 }, () => ({
			type: "message",
			message: { role: "user", content: longMessage },
		})),
	];
	const conversation = __testing.recentConversationText({
		sessionManager: { buildContextEntries: () => entries },
	} as any);
	assert.equal(conversation.length, 12_000);
	assert.equal(conversation.slice(0, 3), "[us");
});

test("/issues add saves the title before an independent bounded model completion enriches context", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	const completionStarted = deferred();
	const completion = deferred<any>();
	const model = { provider: "test", id: "context-model", api: "openai-completions" };
	let capturedContext: any;
	let capturedOptions: any;

	const invocation = invokeIssuesCommand(registered, "add Preserve title first", root, {
		model,
		contextEntries: [
			{
				type: "message",
				message: { role: "user", content: "The failure is in src/auth.ts and must keep backward compatibility." },
			},
		],
		modelRegistry: {
			hasConfiguredAuth: (candidate: any) => candidate === model,
			complete: async (candidate: any, modelContext: any, options: any) => {
				assert.equal(candidate, model);
				capturedContext = modelContext;
				capturedOptions = options;
				completionStarted.resolve();
				return completion.promise;
			},
		},
	});

	await completionStarted.promise;
	const savedBeforeCompletion = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.equal(savedBeforeCompletion.issues[0].title, "Preserve title first");
	assert.equal(savedBeforeCompletion.issues[0].context, undefined);
	assert.deepEqual(registered.entries, []);
	assert.deepEqual(registered.userMessages, []);
	assert.equal(capturedContext.tools, undefined, "enrichment completion must be tool-free");
	assert.match(capturedContext.systemPrompt, /Return exactly NONE/);
	assert.match(capturedContext.messages[0].content[0].text, /src\/auth\.ts/);
	assert.equal(capturedOptions.maxTokens, 300);
	assert.equal(capturedOptions.maxRetries, 0);
	assert.equal(capturedOptions.cacheRetention, "none");
	assert.ok(capturedOptions.signal instanceof AbortSignal);

	completion.resolve(assistantResponse("Relevant file: src/auth.ts\nConstraint: preserve backward compatibility."));
	await invocation;
	const savedAfterCompletion = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.equal(savedAfterCompletion.issues[0].context, "Relevant file: src/auth.ts\nConstraint: preserve backward compatibility.");
	assert.match(registered.messages.at(-1)?.message.content ?? "", /Model-added context was saved/);
});

test("/issues add skips model work while busy and preserves title on unavailable or failed enrichment", async (t) => {
	await t.test("busy", async () => {
		const root = await makeProject();
		const registered = registerExtension();
		let completions = 0;
		await invokeIssuesCommand(registered, "add Busy capture", root, {
			model: { provider: "test", id: "context-model" },
			contextEntries: [{ type: "message", message: { role: "user", content: "Relevant history" } }],
			isIdle: () => false,
			modelRegistry: {
				hasConfiguredAuth: () => true,
				complete: async () => { completions += 1; return assistantResponse("must not happen"); },
			},
		});
		assert.equal(completions, 0);
		const issue = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0];
		assert.equal(issue.title, "Busy capture");
		assert.equal(issue.context, undefined);
		assert.match(registered.messages.at(-1)?.message.content ?? "", /agent is busy/i);
	});

	await t.test("unavailable", async () => {
		const root = await makeProject();
		const registered = registerExtension();
		await invokeIssuesCommand(registered, "add No model", root);
		const issue = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0];
		assert.equal(issue.context, undefined);
		assert.match(registered.messages.at(-1)?.message.content ?? "", /unavailable/i);
	});

	await t.test("failure", async () => {
		const root = await makeProject();
		const registered = registerExtension();
		await invokeIssuesCommand(registered, "add Model failure", root, {
			model: { provider: "test", id: "context-model" },
			contextEntries: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Relevant history" }] } }],
			modelRegistry: {
				hasConfiguredAuth: () => true,
				complete: async () => { throw new Error("offline"); },
			},
		});
		const issue = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0];
		assert.equal(issue.context, undefined);
		assert.match(registered.messages.at(-1)?.message.content ?? "", /failed or timed out/i);
	});

	await t.test("authentication state read error", async () => {
		const root = await makeProject();
		const registered = registerExtension();
		await invokeIssuesCommand(registered, "add Auth read failure", root, {
			model: { provider: "test", id: "context-model" },
			modelRegistry: {
				hasConfiguredAuth: () => { throw new Error("auth state unavailable"); },
				complete: async () => { throw new Error("must not run"); },
			},
		});
		const issue = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0];
		assert.equal(issue.title, "Auth read failure");
		assert.equal(issue.context, undefined);
		assert.match(registered.messages.at(-1)?.message.content ?? "", /failed or timed out/i);
		assert.doesNotMatch(registered.messages.at(-1)?.message.content ?? "", /Issue command failed/i);
		assert.equal(registered.messages.at(-1)?.message.details.level, "info");
	});

	await t.test("current branch read error", async () => {
		const root = await makeProject();
		const registered = registerExtension();
		await invokeIssuesCommand(registered, "add Branch read failure", root, {
			model: { provider: "test", id: "context-model" },
			sessionManager: {
				buildContextEntries: () => { throw new Error("branch unavailable"); },
			},
			modelRegistry: {
				hasConfiguredAuth: () => true,
				complete: async () => { throw new Error("must not run"); },
			},
		});
		const issue = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0];
		assert.equal(issue.title, "Branch read failure");
		assert.equal(issue.context, undefined);
		assert.match(registered.messages.at(-1)?.message.content ?? "", /failed or timed out/i);
		assert.doesNotMatch(registered.messages.at(-1)?.message.content ?? "", /Issue command failed/i);
		assert.equal(registered.messages.at(-1)?.message.details.level, "info");
	});
});

test("context enrichment redacts secrets, excludes tool output, and does not overwrite later edits", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	const completionStarted = deferred();
	const completion = deferred<any>();
	let prompt = "";
	const model = { provider: "test", id: "context-model", api: "openai-completions" };
	const invocation = invokeIssuesCommand(registered, "add Authentication follow-up", root, {
		model,
		contextEntries: [
			{ type: "message", message: { role: "user", content: "Update auth flow; OPENAI_API_KEY=supersecretvalue123 and keep OAuth compatibility." } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "TOOL_SECRET=must-not-enter-prompt" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Relevant file is src/oauth.ts." }] } },
		],
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async (_candidate: any, modelContext: any) => {
				prompt = modelContext.messages[0].content[0].text;
				completionStarted.resolve();
				return completion.promise;
			},
		},
	});

	await completionStarted.promise;
	assert.doesNotMatch(prompt, /supersecretvalue123/);
	assert.doesNotMatch(prompt, /TOOL_SECRET/);
	assert.doesNotMatch(prompt, /hidden/);
	assert.match(prompt, /OPENAI_API_KEY=\[REDACTED\]/);
	await __testing.updateIssue(root, { id: 1, context: "User-authored context wins." });
	completion.resolve(assistantResponse("Use src/oauth.ts with Authorization: Bearer abcdefghijklmnopqrstuvwxyz."));
	await invocation;

	const issue = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0];
	assert.equal(issue.context, "User-authored context wins.");
	assert.doesNotMatch(JSON.stringify(issue), /abcdefghijklmnopqrstuvwxyz/);
	assert.match(registered.messages.at(-1)?.message.content ?? "", /later edit was preserved/i);
});

test("generated context is sanitized before storage", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	await invokeIssuesCommand(registered, "add Keep context safe", root, {
		model: { provider: "test", id: "context-model", api: "openai-completions" },
		contextEntries: [{ type: "message", message: { role: "user", content: "Relevant auth constraint" } }],
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async () => assistantResponse("Relevant file: src/auth.ts\nBearer abcdefghijklmnopqrstuvwxyz"),
		},
	});
	const issue = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0];
	assert.equal(issue.context, "Relevant file: src/auth.ts\nBearer [REDACTED]");
});

test("headless remove and clear refuse deletion, while command errors are reported instead of thrown", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	await executeTool(registered, "add_issue", { title: "Keep me" }, root);
	await executeTool(registered, "resolve_issue", { id: 1 }, root);
	const before = await readFile(join(root, ".pi", "issues.md"), "utf8");

	await invokeIssuesCommand(registered, "remove 1", root, { hasUI: false });
	await invokeIssuesCommand(registered, "clear", root, { hasUI: false });
	await invokeIssuesCommand(registered, "nonsense", root, { hasUI: false });

	assert.equal(await readFile(join(root, ".pi", "issues.md"), "utf8"), before);
	assert.equal(registered.messages.slice(-3).every(({ message }) => message.details.level === "error"), true);
	assert.match(registered.messages.at(-1)?.message.content ?? "", /Usage:/);
});

test("clear with no resolved candidates neither confirms nor creates storage", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	let confirmations = 0;

	await invokeIssuesCommand(registered, "clear", root, {
		confirm: async () => {
			confirmations += 1;
			return true;
		},
	});

	assert.equal(confirmations, 0);
	assert.equal((await readdir(root)).includes(".pi"), false);
	assert.match(registered.messages.at(-1)?.message.content ?? "", /No resolved issues/);
});

test("clear snapshots before confirmation and preserves issues resolved after that snapshot", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	await executeTool(registered, "add_issue", { title: "Already resolved" }, root);
	await executeTool(registered, "resolve_issue", { id: 1 }, root);
	await executeTool(registered, "add_issue", { title: "Resolved during confirmation" }, root);

	const lockHeld = deferred();
	const confirmed = deferred();
	const blocker = __testing.mutateDocument(root, undefined, async (document) => {
		lockHeld.resolve();
		await confirmed.promise;
		const newlyResolved = document.issues.find((issue) => issue.id === 2);
		assert.ok(newlyResolved);
		newlyResolved.status = "resolved";
	});
	await lockHeld.promise;

	await invokeIssuesCommand(registered, "clear", root, {
		confirm: async (title, message) => {
			assert.equal(title, "Clear resolved issues?");
			assert.match(message, /delete 1 resolved issue/);
			confirmed.resolve();
			return true;
		},
	});
	await blocker;

	const document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.deepEqual(document.issues.map(({ id, status }) => ({ id, status })), [{ id: 2, status: "resolved" }]);
	assert.match(registered.messages.at(-1)?.message.content ?? "", /Cleared 1 resolved issue/);
});

test("clear refuses the whole deletion when a confirmed candidate changes", async (t) => {
	const variants: Array<{
		name: string;
		change: (root: string) => Promise<void>;
		assertCandidate: (issue: Issue) => void;
	}> = [
		{
			name: "updated",
			change: async (root) => {
				await __testing.updateIssue(root, { id: 1, title: "Edited while confirming" });
			},
			assertCandidate: (issue) => assert.equal(issue.title, "Edited while confirming"),
		},
		{
			name: "reopened",
			change: async (root) => {
				await __testing.mutateDocument(root, undefined, (document) => {
					const issue = document.issues.find((candidate) => candidate.id === 1);
					assert.ok(issue);
					issue.status = "open";
				});
			},
			assertCandidate: (issue) => assert.equal(issue.status, "open"),
		},
		{
			name: "deleted and recreated with the same ID",
			change: async (root) => {
				await __testing.mutateDocument(root, undefined, (document) => {
					const index = document.issues.findIndex((candidate) => candidate.id === 1);
					assert.notEqual(index, -1);
					const [removed] = document.issues.splice(index, 1);
					document.issues.push({ ...removed, title: "Replacement with reused ID" });
				});
			},
			assertCandidate: (issue) => assert.equal(issue.title, "Replacement with reused ID"),
		},
	];

	for (const variant of variants) {
		await t.test(variant.name, async () => {
			const root = await makeProject();
			const registered = registerExtension();
			await executeTool(registered, "add_issue", { title: "Candidate" }, root);
			await executeTool(registered, "resolve_issue", { id: 1 }, root);
			await executeTool(registered, "add_issue", { title: "Other candidate" }, root);
			await executeTool(registered, "resolve_issue", { id: 2 }, root);

			await invokeIssuesCommand(registered, "clear", root, {
				confirm: async (_title, message) => {
					assert.match(message, /delete 2 resolved issue/);
					await variant.change(root);
					return true;
				},
			});

			const document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
			assert.equal(document.issues.length, 2, "an unchanged candidate must not be partially deleted");
			const candidate = document.issues.find((issue) => issue.id === 1);
			assert.ok(candidate);
			variant.assertCandidate(candidate);
			assert.ok(document.issues.some((issue) => issue.id === 2));
			assert.match(registered.messages.at(-1)?.message.content ?? "", /changed after confirmation.*Retry \/issues clear/i);
			assert.equal(registered.messages.at(-1)?.message.details.level, "error");
		});
	}
});

test("remove includes the snapshotted title and refuses an edited same-ID issue", async () => {
	const root = await makeProject();
	const registered = registerExtension();
	await executeTool(registered, "add_issue", { title: "Original title" }, root);

	await invokeIssuesCommand(registered, "remove 1", root, {
		confirm: async (title, message) => {
			assert.equal(title, "Remove issue?");
			assert.match(message, /#1: Original title/);
			await __testing.updateIssue(root, { id: 1, title: "Edited during confirmation" });
			return true;
		},
	});

	const document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.equal(document.issues.length, 1);
	assert.equal(document.issues[0].title, "Edited during confirmation");
	assert.match(registered.messages.at(-1)?.message.content ?? "", /changed after confirmation.*Retry \/issues remove/i);
	assert.equal(registered.messages.at(-1)?.message.details.level, "error");
});

test("uses the nearest Git root and recomputes it from every call context", async () => {
	const firstRoot = await makeProject();
	const secondRoot = await makeProject();
	const nested = join(firstRoot, "packages", "app", "src");
	await mkdir(nested, { recursive: true });
	const registered = registerExtension();

	await executeTool(registered, "add_issue", { title: "First project" }, nested);
	await executeTool(registered, "add_issue", { title: "Second project" }, secondRoot);

	const first = parseIssueDocument(await readFile(join(firstRoot, ".pi", "issues.md"), "utf8"));
	const second = parseIssueDocument(await readFile(join(secondRoot, ".pi", "issues.md"), "utf8"));
	assert.equal(first.issues[0].title, "First project");
	assert.equal(second.issues[0].title, "Second project");
	assert.equal(first.issues[0].id, 1);
	assert.equal(second.issues[0].id, 1);
});

test("falls back to ctx.cwd when no Git marker exists", async () => {
	const root = await makeProject(false);
	const registered = registerExtension();
	await executeTool(registered, "add_issue", { title: "Standalone" }, root);
	assert.equal(parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8")).issues[0].title, "Standalone");
});

test("corrupt, duplicate-ID, merge-conflicted, and unknown-ID inputs are never overwritten", async (t) => {
	const variants = [
		{
			name: "unknown Markdown",
			content: "# Issues\n\n## Open\n\nmanual prose\n\n## Resolved\n",
		},
		{
			name: "duplicate IDs",
			content:
				"# Issues\n\n<!-- pi-issue: nextId=2 -->\n\n## Open\n\n- [ ] #1 A (normal) — 2026-01-01\n\n## Resolved\n\n- [x] #1 B (normal) — 2026-01-01\n",
		},
		{
			name: "merge conflict",
			content:
				"# Issues\n\n## Open\n\n<<<<<<< HEAD\n- [ ] #1 A (normal) — 2026-01-01\n=======\n- [ ] #2 B (normal) — 2026-01-01\n>>>>>>> branch\n\n## Resolved\n",
		},
	];

	for (const variant of variants) {
		await t.test(variant.name, async () => {
			const root = await makeProject();
			await mkdir(join(root, ".pi"));
			const path = join(root, ".pi", "issues.md");
			await writeFile(path, variant.content);
			const registered = registerExtension();
			await assert.rejects(() => executeTool(registered, "add_issue", { title: "Must not land" }, root));
			assert.equal(await readFile(path, "utf8"), variant.content);
			const leftovers = (await readdir(join(root, ".pi"))).filter((name) => name.includes(".tmp") || name.endsWith(".lock"));
			assert.deepEqual(leftovers, []);
		});
	}

	await t.test("unknown issue ID", async () => {
		const root = await makeProject();
		const registered = registerExtension();
		await executeTool(registered, "add_issue", { title: "Existing" }, root);
		const path = join(root, ".pi", "issues.md");
		const before = await readFile(path, "utf8");
		await assert.rejects(
			() => executeTool(registered, "update_issue", { id: 999, title: "No" }, root),
			/not found/,
		);
		assert.equal(await readFile(path, "utf8"), before);
	});
});

test("rejects symlinked storage directories and files", async (t) => {
	await t.test("storage directory", async () => {
		const root = await makeProject();
		const external = await makeProject(false);
		await symlink(external, join(root, ".pi"));
		const registered = registerExtension();
		await assert.rejects(() => executeTool(registered, "add_issue", { title: "Unsafe" }, root), /symlinked directory/);
		await assert.rejects(() => readFile(join(external, "issues.md"), "utf8"));
	});

	await t.test("issues file", async () => {
		const root = await makeProject();
		const external = join(await makeProject(false), "external.md");
		await writeFile(external, "do not replace");
		await mkdir(join(root, ".pi"));
		await symlink(external, join(root, ".pi", "issues.md"));
		const registered = registerExtension();
		await assert.rejects(() => executeTool(registered, "add_issue", { title: "Unsafe" }, root), /symlinked file/);
		assert.equal(await readFile(external, "utf8"), "do not replace");
	});
});

test("persistent cross-process locks time out with manual recovery guidance and are never stolen", async () => {
	const root = await makeProject();
	await mkdir(join(root, ".pi"));
	const lock = join(root, ".pi", "issues.md.lock");
	await writeFile(lock, "owner still unknown\n");
	const registered = registerExtension();
	const started = Date.now();
	await assert.rejects(
		() => executeTool(registered, "add_issue", { title: "Wait" }, root),
		/manual.*delete.*lock file/i,
	);
	assert.ok(Date.now() - started >= __testing.LOCK_TIMEOUT_MS);
	assert.equal(await readFile(lock, "utf8"), "owner still unknown\n");
});

test("AbortSignal cancels lock waiting and leaves the foreign lock untouched", async () => {
	const root = await makeProject();
	await mkdir(join(root, ".pi"));
	const lock = join(root, ".pi", "issues.md.lock");
	await writeFile(lock, "foreign\n");
	const registered = registerExtension();
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error("test abort")), 75);
	await assert.rejects(
		() => executeTool(registered, "add_issue", { title: "Cancelled" }, root, controller.signal),
		/test abort/,
	);
	assert.equal(await readFile(lock, "utf8"), "foreign\n");
});

test("list output is truncated to host limits", async () => {
	const root = await makeProject();
	await mkdir(join(root, ".pi"));
	const issues: Issue[] = Array.from({ length: DEFAULT_TEST_ISSUE_COUNT }, (_, index) => ({
		id: index + 1,
		title: `Issue ${index + 1} ${"x".repeat(30)}`,
		priority: "normal",
		status: "open",
		created: "2026-01-01",
	}));
	await writeFile(
		join(root, ".pi", "issues.md"),
		serializeIssueDocument({ issues, nextId: issues.length + 1 }),
	);
	const registered = registerExtension();
	const result = await executeTool(registered, "list_issues", { status: "open" }, root);
	const output = firstText(result);
	assert.match(output, /Output truncated:/);
	assert.ok(Buffer.byteLength(output, "utf8") <= DEFAULT_MAX_BYTES);
	assert.ok(output.split("\n").length <= DEFAULT_MAX_LINES);
	assert.equal(result.details.count, DEFAULT_TEST_ISSUE_COUNT);
});

const DEFAULT_TEST_ISSUE_COUNT = 2_500;

test("cross-process concurrent additions serialize without lost updates", async () => {
	const root = await makeProject();
	const worker = join(dirname(fileURLToPath(import.meta.url)), "concurrent-worker.ts");
	const titles = Array.from({ length: 8 }, (_, index) => `worker-${index + 1}`);

	await Promise.all(
		titles.map(
			(title) =>
				new Promise<void>((resolvePromise, reject) => {
					const child = spawn(process.execPath, ["--import", "tsx", worker, root, title], {
						cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
						stdio: ["ignore", "pipe", "pipe"],
					});
					let stderr = "";
					child.stderr.setEncoding("utf8");
					child.stderr.on("data", (chunk) => {
						stderr += chunk;
					});
					child.on("error", reject);
					child.on("exit", (code) => {
						if (code === 0) resolvePromise();
						else reject(new Error(`worker exited ${code}: ${stderr}`));
					});
				}),
		),
	);

	const document = parseIssueDocument(await readFile(join(root, ".pi", "issues.md"), "utf8"));
	assert.equal(document.issues.length, titles.length);
	assert.equal(document.nextId, titles.length + 1);
	assert.deepEqual(
		document.issues.map((issue) => issue.id).sort((a, b) => a - b),
		Array.from({ length: titles.length }, (_, index) => index + 1),
	);
	assert.deepEqual(
		document.issues.map((issue) => issue.title).sort(),
		titles.sort(),
	);
});
