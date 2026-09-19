import piIssueExtension from "../index.ts";

const [cwd, title] = process.argv.slice(2);
if (!cwd || !title) throw new Error("Usage: concurrent-worker.ts <cwd> <title>");

const tools = new Map<string, any>();
const api = {
	registerTool(definition: any) {
		tools.set(definition.name, definition);
	},
	registerCommand() {},
	on() {},
	sendMessage() {},
};

piIssueExtension(api as any);
const add = tools.get("add_issue");
if (!add) throw new Error("add_issue was not registered");
await add.execute("worker", { title }, undefined, undefined, { cwd });
