# Local CLI inference

A live run can use the operator's own locally installed, logged-in
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`)
instead of the Cloudflare AI Gateway for every model role: the planner, the
board agents' turns, the executor's edits (including the verify-fail
escalation ladder), and tool authoring. The AI Gateway stays the default and
is fully supported.

The call runs on the operator's machine under the operator's own login and
subscription. The repository holds no provider key and makes no provider HTTP
call: it spawns the `claude` binary the operator installed.

## Turn it on

```bash
claude                      # once, interactively: log in
make cli ARGS="doctor --inference claude-cli"   # checks the binary and the login
```

Then either set it in `.env`:

```bash
SWITCHYARD_INFERENCE=claude-cli
```

or pass `--inference claude-cli` to a live command (`run-board`, `run-live`,
`recruit-live`, `tool-smoke`, `jev-smoke`, `doctor`, `env-check`). The flag
wins over the environment. Accepted values: `gateway` (default), `claude-cli`,
and `codex-cli` (the OpenAI Codex CLI; see "Codex" below). Anything else is an
error.

In CLI mode `EXECUTOR` is ignored and the AI Gateway URL and token are not
needed. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are still needed
for Artifacts and the Worker. Before a live run creates anything it checks
that `claude --version` runs and `claude auth status` reports a login (only
the login flag and method are read, never the account); otherwise it refuses
to start with the reason.

## Settings

| Variable | Default | Role |
|----------|---------|------|
| `CLI_MODEL` | `sonnet` (codex: `gpt-5.5`) | executor base model |
| `CLI_ESCALATION_MODELS` | `opus` (codex: `gpt-6.1-sol`) | ordered verify-fail ladder (comma separated); also the planner's |
| `CLI_PLANNER_MODEL` | `sonnet` (codex: `gpt-5.5`) | planner base model |
| `CLI_AGENT_MODEL` | `sonnet` (codex: `gpt-5.5`) | board agent turns |
| `CLI_TOOL_MODELS` | `opus,sonnet` (codex: `gpt-6.1-sol,gpt-5.5`) | tool authoring, strongest first |
| `CLAUDE_CLI_BIN` | `claude` on PATH | the Claude Code binary |
| `CODEX_CLI_BIN` | `codex` on PATH | the Codex binary |
| `CLI_TIMEOUT_MS` | `300000` | per-call timeout (the process group is killed) |
| `CLI_JEV` | `off` | `gateway` keeps the advisory Jev layer on the AI Gateway (needs its credentials) |

Models are Claude Code aliases (`sonnet`, `opus`, `haiku`) or full model ids.
The concurrency dial is unchanged. Each call is a process of its own, so a
board run bounds how many run at once with `--max-inflight N` (default
min(the dial's max, 8)); agents beyond it queue for a slot (see "Wide pools"
in BOARD.md). The run header names the path, for example:

```
inference: local claude CLI on this machine's own login (executor sonnet -> opus; planner sonnet; agent turns sonnet; tools opus, sonnet); Jev off
```

## How a call is made

Each call is one `claude -p --output-format json` process:

- `--tools ""` (no tool at all), `--no-session-persistence`,
  `--setting-sources ""` (no user or project settings), `--strict-mcp-config`
  (no MCP servers); never `--dangerously-skip-permissions`;
- the system messages as `--system-prompt`, the rest of the conversation on
  stdin (one user message verbatim; a multi-turn history with a role header
  per message);
- for the planner, agent turns, and tool fills, the same JSON schema the
  gateway path uses, as `--json-schema`; the reply is the CLI's
  `structured_output`;
- spawned without a shell, in a fresh empty temp directory removed after, with
  an allowlisted environment (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, the XDG
  directories and `CLAUDE_CONFIG_DIR` when set): no Cloudflare, gateway, or
  Git host credential ever reaches it;
- stdout and stderr are bounded.

The prompts, the schemas, the anchored-edit parsing, and the mechanical gate
are exactly the gateway path's. The gate stays authoritative.

## Errors

- A usage or rate limit (HTTP 429, or a "usage limit ... resets ..." message)
  is a rate limit: the run backs off like a gateway 429, honouring the reset
  time when the CLI names one.
- Not logged in (or an expired login): a clear error telling the operator to
  run `claude` and log in. It is never retried.
- A missing binary: a clear error naming `CLAUDE_CLI_BIN`.
- An empty, garbled, or truncated reply: the same unusable-output or budget
  error the gateway path raises.

## Usage meter

Calls and tokens are counted. A subscription call is not billed per call, so
its USD is reported as not applicable (never as spend, and never from the
CLI's list-price estimate). An explicit `--price <model>=<in>/<out>` still
prices that model. `--max-calls` applies as usual. `--max-spend-usd` still
requires a `--price` for every model the run calls.

## Codex

`SWITCHYARD_INFERENCE=codex-cli` (or `--inference codex-cli`) runs every model
role through the operator's own logged-in OpenAI Codex CLI. Log in once with
`codex login`; `make cli ARGS="doctor --inference codex-cli"` checks the binary
and the login. It is a second driver behind the same `CliDriver` interface in
`packages/model-adapters/src/cli-transport.ts`, so everything above (the
runner, the bounded output, rate-limit and login classification, the meter,
the flag) applies unchanged.

How a call is made: `codex exec --json` in the call's fresh empty temp
directory, with `--sandbox read-only`, `approval_policy="never"`,
`shell_environment_policy.inherit="none"`, `web_search="disabled"`,
`--ignore-user-config`, `--ignore-rules`, `--ephemeral` (no saved session),
and `--skip-git-repo-check`. Codex has no switch that turns its tools off, so
the hardening is the read-only sandbox plus the empty directory and the
allowlisted environment: a command the model runs can read nothing of the repo
and change nothing. Codex has no system-prompt flag either, so the system
prompt leads the stdin prompt under a `=== SYSTEM ===` header. A JSON schema is
written to `schema.json` in the temp directory and passed as
`--output-schema`. The reply is the last `agent_message` event; usage comes
from `turn.completed` (reasoning tokens count as output). The model `default`
omits `--model` and uses the CLI's own default.

Defaults are the same base and stronger split as Claude's: `gpt-5.5` for the
executor, planner, and agent turns, and `gpt-6.1-sol` for escalation and
tools (both accepted by a ChatGPT-login Codex as of 2026-10-14). Note that
every Codex call carries its own built-in agent instructions, about 11,000 to
14,000 input tokens even for a one-line reply.

`CODEX_HOME` passes through the allowlist, so a run can use a different Codex
login with `CODEX_HOME=<dir> make run-board-cityhall INFERENCE=codex-cli`, the
same way `CLAUDE_CONFIG_DIR` selects a Claude profile.
