import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url))

function run(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  })
}

function ourHooks(settings) {
  return (settings.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes("onehook-noslop"))
}

test("global install keeps other settings, is idempotent, and uninstalls cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "noslop-"))
  const env = { CLAUDE_CONFIG_DIR: dir }
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] }
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "x", hooks: { PreToolUse: [other] } }))

  assert.equal(run(["install"], { env }).status, 0)
  assert.equal(run(["install"], { env }).status, 0)
  let s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))
  assert.equal(s.model, "x")
  assert.equal(ourHooks(s).length, 1)
  assert.deepEqual(s.hooks.PreToolUse[0], other)
  assert.ok(existsSync(join(dir, "hooks", "onehook-noslop", "couplets.mjs")))

  assert.equal(run(["uninstall"], { env }).status, 0)
  s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))
  assert.equal(ourHooks(s).length, 0)
  assert.deepEqual(s.hooks.PreToolUse, [other])
  assert.ok(!existsSync(join(dir, "hooks", "onehook-noslop")))
})

test("project install writes .claude/settings.json and the installed hook blocks a couplet", () => {
  const cwd = mkdtempSync(join(tmpdir(), "noslop-proj-"))
  assert.equal(run(["install", "--project"], { cwd }).status, 0)
  const s = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"))
  assert.match(ourHooks(s)[0].command, /\$CLAUDE_PROJECT_DIR/)

  const script = join(cwd, ".claude", "hooks", "onehook-noslop", "couplets.mjs")
  const r = spawnSync(process.execPath, [script, "--hook"], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "a.md", content: "Two layers, one rule" } }),
    encoding: "utf8",
  })
  assert.equal(r.status, 2)
})

test("install refuses to overwrite unparseable settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "noslop-bad-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "settings.json"), "{ not json")
  const r = run(["install"], { env: { CLAUDE_CONFIG_DIR: dir } })
  assert.equal(r.status, 1)
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), "{ not json")
})
