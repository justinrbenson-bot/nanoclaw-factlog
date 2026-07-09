# Harness capabilities

NanoClaw disables harness-native features that overlap its own systems, and exposes a small per-group toggle surface for the ones where both states are meaningful. Policy (keys, defaults, resolution) lives host-side in [`src/harness-capabilities.ts`](../src/harness-capabilities.ts); per-group overrides live in the `harness_capabilities` column of `container_configs`; mechanisms live in the agent runner and the settings reconciler ([`src/group-init.ts`](../src/group-init.ts)).

## Capability table

| Capability | Key | Default | Mechanism |
|---|---|---|---|
| Agent teams (experimental multi-agent coordination inside one session) | `agent-teams` | **off** | Settings reconciler adds/removes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in the group's `settings.json` on every spawn. On the pinned CLI, settings env strictly beats SDK options env, so the settings file is the only working switch. |
| Workflow tool (in-session multi-agent orchestration scripts) | `workflow` | **off** | Reconciler sets `disableWorkflows: true` (removes the tool and its agent-types catalog — ~26KB/turn); the runner also adds `Workflow` to `disallowedTools` + PreToolUse hook as a backstop. |
| Cron/scheduling (`CronCreate/CronDelete/CronList`, `ScheduleWakeup`) | — | fixed off | `disallowedTools` + hook. NanoClaw's `schedule_task` MCP suite is the authoritative scheduler. |
| `AskUserQuestion` | — | fixed off | `disallowedTools` (returns a placeholder headless; `ask_user_question` is the real mechanism). |
| Plan/worktree modes | — | fixed off | `disallowedTools` (broken headless). |
| `DesignSync` | — | fixed off | `disallowedTools` (desktop design-tool integration; nothing to sync with in a container; ~9.3KB/turn schema). |
| Task list (`TaskCreate/…`), subagents (`Agent`), web (`WebSearch/WebFetch`) | — | fixed on | No NanoClaw overlap. Harness task lists are per-session scratch — not NanoClaw scheduled tasks. |

Toggling:

```bash
ncl groups config get --id <group-id>                                    # shows raw overrides + resolved view
ncl groups config update --id <group-id> --harness-capabilities 'agent-teams=on'
ncl groups config update --id <group-id> --harness-capabilities 'workflow=on,agent-teams=default'
ncl groups restart --id <group-id>                                       # apply
```

`default` clears the per-group override (it is never stored). Config changes through `ncl` from inside a container are rejected — like `cli_scope`, the sanctioned/persistent path is operator-only.

### Enforcement strength (be precise about the boundary)

- **`workflow` off** has two independent locks: the reconciled `disableWorkflows` settings key *and* a runner-side `disallowedTools` block. The tool cannot come back inside a running container even if the settings file is edited.
- **`agent-teams` off** has only one mechanism: the absence of the env key from the group's `settings.json`. That file is mounted **read-write** into the container (the CLI needs to write transcripts there), and `settingSources` also loads project/local settings from the agent-writable workspace. So an agent that actively rewrites its own settings can re-enable teams **for the current container lifetime**, until the next spawn re-reconciles it. Treat `agent-teams=off` as **configuration hygiene enforced at spawn**, not a hard adversarial boundary inside a live container — the real trust boundary remains the container sandbox + OneCLI. A follow-up ([nanocoai/nanoclaw#TBD](https://github.com/nanocoai/nanoclaw/issues)) will mount the managed settings source read-only to close this.

## [BREAKING] Agent teams default off

- **Detect**: after updating, agents in a group that used Claude's experimental agent-teams feature lose team coordination (the expanded `Agent`/`SendMessage`/`TaskCreate`/`TaskList` schemas revert to baseline) at the group's next container spawn. `ncl groups config get` shows `agent-teams: off (default)`; the group's `.claude-shared/settings.json` no longer contains `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.
- **Why**: it overlaps NanoClaw's agent-to-agent system (`create_agent` + destinations routing), is experimental upstream, multiplies separately-billed agent contexts invisibly to NanoClaw ops, and its `SendMessage` invites confusion with `mcp__nanoclaw__send_message`.
- **Fix**: `ncl groups config update --id <g> --harness-capabilities 'agent-teams=on'` then `ncl groups restart --id <g>`.
- **Verify**: `ncl groups config get --id <g>` shows `agent-teams: on (override)`; the settings.json env key is back after the next spawn.
- **Rollback**: the fix line above IS the rollback — per group, no code changes.

## [BREAKING] Workflow tool default off

- **Detect**: agents no longer have the `Workflow` tool; request payloads shrink ~26KB/turn. `ncl groups config get` shows `workflow: off (default)`.
- **Why**: it is redundant with NanoClaw's orchestration model (sessions + a2a, host stays in control), can spawn dozens of agents invisible to NanoClaw ops, and is the single largest tool schema on every turn (21.3KB measured on CLI 2.1.197).
- **Fix**: `ncl groups config update --id <g> --harness-capabilities 'workflow=on'` then `ncl groups restart --id <g>`.
- **Verify / Rollback**: as above, with `workflow`.

## Notes for forks

- If your fork patched `SDK_DISALLOWED_TOOLS` in `container/agent-runner/src/providers/claude.ts`: the fixed list still lives there, but per-group state now composes through `buildDisallowedTools()` — re-apply your patch to the fixed list, or express it as capability keys if it fits.
- The measured numbers above are for `@anthropic-ai/claude-code` 2.1.197 / SDK 0.3.197. When bumping the pin, `claude.tools.test.ts` fails until you regenerate the tool-surface fixture: run [`dump-sdk-tools.ts`](../container/agent-runner/src/providers/dump-sdk-tools.ts) inside the agent image (invocation in its header) and re-verify the allow/disallow lists against the new surface.
