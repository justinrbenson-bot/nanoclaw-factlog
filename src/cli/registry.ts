/**
 * Command registry — single source of truth for what `ncl` can do.
 *
 * Most commands come from resource modules under `resources/`, which call
 * `registerResource()` (one `register()` per CRUD verb); the top-level `help`
 * command and the per-resource help commands register directly. The barrel
 * `commands/index.ts` imports the resource barrel for its side effects and then
 * registers the help commands, so the registry is populated before the host's
 * CLI server accepts connections.
 */
import type { CallerContext } from './frame.js';

export type Access = 'open' | 'approval';

export type CommandDef<TArgs = unknown, TData = unknown> = {
  name: string;
  description: string;
  access: Access;
  /**
   * The group-scope whitelist key. Under `cli_scope: 'group'` the dispatcher
   * only lets an agent run commands whose `resource` is on the whitelist
   * (`groups`, `sessions`, `destinations`, `members`); it also drives help
   * grouping. Omitting `resource` exempts the command from the whitelist —
   * that's how general commands like `help` stay reachable in group scope.
   */
  resource?: string;
  /**
   * Set on the auto-generated `list` / `get` handlers (see `registerResource`).
   * These return raw DB rows that carry the resource's `scopeField`, so the
   * dispatcher applies post-handler group-scope filtering to their output.
   * Custom operations return ad-hoc shapes and leave this undefined.
   */
  generic?: 'list' | 'get';
  /**
   * Dotted audit action name, e.g. `groups.config.add-mcp-server`. Stamped
   * explicitly by `registerResource` (which knows verb segment boundaries);
   * hand-registered commands may omit it and get `name` with dashes→dots.
   */
  action: string;
  /** Validates `frame.args` and produces the typed handler input. Throws on invalid. */
  parseArgs: (raw: Record<string, unknown>) => TArgs;
  handler: (args: TArgs, ctx: CallerContext) => Promise<TData>;
};

/** `register()` input — `action` is defaulted, everything else as stored. */
export type CommandInput<TArgs = unknown, TData = unknown> = Omit<CommandDef<TArgs, TData>, 'action'> & {
  action?: string;
};

const registry = new Map<string, CommandDef>();

export function register<TArgs, TData>(def: CommandInput<TArgs, TData>): void {
  if (registry.has(def.name)) {
    throw new Error(`CLI command "${def.name}" already registered`);
  }
  registry.set(def.name, { ...def, action: def.action ?? def.name.replace(/-/g, '.') } as CommandDef);
}

export function lookup(name: string): CommandDef | undefined {
  return registry.get(name);
}

export function listCommands(): CommandDef[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}
