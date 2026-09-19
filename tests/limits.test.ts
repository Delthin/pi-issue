import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing, parseIssueDocument } from "../index.ts";

test("ID exhaustion rejects mutation without writing an unreadable nextId", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-issue-limit-"));
  try {
    await mkdir(join(root, ".pi"));
    const path = join(root, ".pi/issues.md");
    const original = `# Issues\n\n<!-- pi-issue: nextId=${Number.MAX_SAFE_INTEGER} -->\n\n## Open\n\n## Resolved\n`;
    await writeFile(path, original);
    await assert.rejects(__testing.addIssue(root, { title: "overflow" }), /exhausted/);
    assert.equal(await readFile(path, "utf8"), original);
    assert.throws(() => parseIssueDocument(`# Issues\n\n## Open\n- [ ] #${Number.MAX_SAFE_INTEGER} last — 2026-01-01\n\n## Resolved\n`), /exhausted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized output cannot turn a readable inbox into an unreadable one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-issue-size-"));
  try {
    await mkdir(join(root, ".pi"));
    const path = join(root, ".pi/issues.md");
    // 52 valid, individually bounded context fields, just below 5 MiB.
    const rows = Array.from({ length: 52 }, (_, i) => `- [ ] #${i + 1} entry (normal) — 2026-01-01\n  - 补充：${"a".repeat(100_000)}`);
    const original = `# Issues\n\n<!-- pi-issue: nextId=53 -->\n\n## Open\n${rows.join("\n")}\n\n## Resolved\n`;
    assert.ok(Buffer.byteLength(original) < 5 * 1024 * 1024);
    await writeFile(path, original);
    await assert.rejects(__testing.addIssue(root, { title: "too large", context: "a".repeat(100_000) }), /would exceed/);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await __testing.listIssues(root, "all")).issues.length, 52);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
