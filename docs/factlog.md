# factlog integration

*Containers isolate, facts coordinate.*

NanoClaw's core principle is agent-level isolation: every agent in its own
container, walled off from every other agent. The cost is amnesia and
fragmentation — agents cannot share what they learn. This integration adds the
missing middle: a host-side [factlog](https://github.com/justinrbenson-bot/factlog)
daemon whose append-only fact log is the **single, narrow, auditable channel
between containers**. Agents never talk to each other. They read and write
small typed facts (decisions, invariants, notes, questions, findings, handoffs,
claims) through an explicitly granted transport. Isolation stays intact;
coordination becomes possible; every cross-agent influence is a logged,
attributable event a human can inspect in the factlog web UI.

## Architecture

```
host
├── factlog daemon — SQLite log, HTTP API (:4711), web UI (:4820)
│     └── unix socket: <workspace>/.factlog/factlog.sock
├── nanoclaw host process
│     ├── mints a per-run actor token at container spawn
│     ├── writes the run identity into the session dir
│     └── bind-mounts the daemon socket into each container
└── containers (one per agent, unchanged isolation)
      └── /run/factlog.sock + /workspace/factlog.json
```

In-container, the agent-runner (when `/workspace/factlog.json` exists):

- starts a **loopback proxy** so the provider subprocess can reach the
  daemon's MCP surface (`mcp__factlog__*` tools) — the proxy injects the run's
  Bearer token; the subprocess never sees it;
- **SessionStart** → injects `GET /brief` (≤500 tokens) for the agent's home
  scopes: current invariants, decisions, open questions, last handoff;
- **PreToolUse** → for effectful messaging tools (`send_message`, `send_file`,
  `edit_message`), asks the daemon's hook endpoint with the destination mapped
  to a `channel://` scope. An active gating invariant (`meta["x-gate"]="block"`)
  mechanically blocks the send — enforced policy, not advice;
- **Stop** → the daemon's stop gate: a run holding open claims is blocked with
  a write-back instruction, so scheduled runs leave a resumable trail.

All hooks fail open with a log line when the daemon is unreachable: message
delivery outranks coordination.

## Setup

1. Install factlog and initialize a workspace (not a git repo — the stop
   gate's commit counting would pick up unrelated commits):

   ```bash
   mkdir -p ~/nanoclaw-factlog-ws && cd ~/nanoclaw-factlog-ws && factlog init
   factlog serve   # web :4820, API :4711, socket .factlog/factlog.sock
   ```

2. Point NanoClaw at it in `.env`:

   ```bash
   FACTLOG_WORKSPACE=/Users/you/nanoclaw-factlog-ws
   # optional:
   # FACTLOG_BIN=factlog                     # CLI used to mint/revoke run tokens
   # FACTLOG_TRANSPORT=socket|host-gateway   # default: socket on Linux, host-gateway on macOS
   # FACTLOG_SOCKET=<workspace>/.factlog/factlog.sock
   # FACTLOG_HOST_URL=http://host.docker.internal:4711
   ```

   macOS note: Docker Desktop cannot forward host unix sockets into the VM,
   so darwin defaults to `host-gateway` (TCP via `host.docker.internal`,
   still token-authenticated). Linux uses the socket mount — no container
   networking at all.

3. (Optional) Declare per-agent scopes in `groups/<folder>/factlog.json`:

   ```json
   {
     "homeScopes": ["topic://meals/**", "job://grocery-order", "channel://whatsapp/**"],
     "writeScopes": ["topic://meals/**", "job://**"],
     "origin": "external",
     "sponsor": "justin"
   }
   ```

   `homeScopes` bound what the agent's brief covers; `writeScopes` bound where
   it may post (enforced daemon-side via the token). Absent file = global
   brief, unrestricted writes, external origin.

Scope vocabulary (URIs, RFC §3.4): `channel://whatsapp/family`,
`topic://finances/**`, `job://daily-digest`, `contact://mom`.

## Identity and trust

- **Server-stamped actors.** At spawn the host mints a token scoped to
  `{agent: <group folder>, session: <container name>}` with a lifetime bound
  to the run (revoked on container exit, 24h TTL as backstop). The daemon
  stamps every write's actor from the token — containers cannot spoof
  authorship, and every fact carries `meta["x-actor-verified"]`.
- **Taint at the source.** Runs default to `origin: external` (every nanoclaw
  agent processes inbound channel content). The daemon stamps
  `meta["x-origin"]="external"` on every write — the client cannot unset it —
  and holds `decision`/`invariant` posts in `pending` until a human approves
  them in the factlog web UI. A WhatsApp message can *suggest* "we're
  vegetarian now"; only the human can make it law. Set `"origin": "internal"`
  in the group's factlog.json only for agents that never touch untrusted
  content.
- **Write-scope ACLs** bound blast radius: a compromised email agent with
  `writeScopes: ["topic://email/**"]` cannot post into `channel://whatsapp/**`.
- Briefs render tainted facts visibly delimited (quoted, `[external]` badge),
  never as bare instructions.

## Patterns

- **Run-lock:** a `claim` on `job://daily-digest` (exclusive, TTL) prevents
  duplicate execution when a job fires from two agents or a retry races a slow
  run; the loser yields. The Stop gate makes the winner release + hand off.
- **Enforced quiet hours:** post an `invariant` scoped to `channel://**` with
  `meta["x-gate"]="block"` and an `x-expires` at 08:00 — sends are
  mechanically blocked until it expires, and the block reason echoes the
  invariant body back to the agent.
- **Compounding memory:** knowledge accumulates in the log instead of in
  per-session transcripts; a run's fixed context overhead is the ~500-token
  brief regardless of history depth.

## Key files

| File | Purpose |
|------|---------|
| `src/modules/factlog/index.ts` | Host side: enablement, group config, token mint/revoke, run identity file, socket mount |
| `container/agent-runner/src/factlog/config.ts` | Run identity (`/workspace/factlog.json`) parsing |
| `container/agent-runner/src/factlog/client.ts` | HTTP client over UDS (Bun `unix:` fetch) or host gateway; brief + hook endpoints |
| `container/agent-runner/src/factlog/proxy.ts` | Loopback proxy exposing the daemon's `/mcp` to the provider subprocess |
| `container/agent-runner/src/factlog/hooks.ts` | SessionStart / PreToolUse / Stop lifecycle hooks |

Non-goals (v1): cross-installation federation, agent-to-agent messaging (the
log carries state, not dialogue), automatic import of existing transcripts.
