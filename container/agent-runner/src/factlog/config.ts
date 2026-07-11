/**
 * factlog run identity — written by the host at container spawn
 * (src/modules/factlog/index.ts) into the session dir, visible here at
 * /workspace/factlog.json. Absent file = factlog disabled for this run;
 * everything factlog-related in the runner is a no-op then.
 *
 * The token is this run's identity: the daemon stamps every write's actor
 * server-side from it, so nothing in this container can post as anyone else.
 */
import fs from 'fs';

export interface FactlogRunConfig {
  transport: 'socket' | 'http';
  /** In-container daemon socket path (`socket` transport). */
  socket?: string;
  /** Daemon base URL (`http` transport via host gateway). */
  url?: string;
  token: string;
  agent: string;
  session: string;
  /** What this agent's brief covers. Absent = the whole log. */
  homeScopes?: string[];
  writeScopes?: string[];
}

export const FACTLOG_CONFIG_PATH = '/workspace/factlog.json';

export function loadFactlogRunConfig(file: string = FACTLOG_CONFIG_PATH): FactlogRunConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const cfg = JSON.parse(raw) as FactlogRunConfig;
    if (typeof cfg.token !== 'string' || typeof cfg.session !== 'string') return null;
    if (cfg.transport === 'socket' && typeof cfg.socket !== 'string') return null;
    if (cfg.transport === 'http' && typeof cfg.url !== 'string') return null;
    return cfg;
  } catch {
    console.error(`[factlog] invalid ${file} — factlog disabled for this run`);
    return null;
  }
}
