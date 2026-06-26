// Robust, dependency-free `.env` loader for the backend process.
//
// The server reads all configuration from `process.env` (the TfNSW API key is
// read by the client from there). Node does not load a `.env` automatically,
// and Node's `--env-file` flag refuses to OVERRIDE a variable already present
// in the shell — so a stale/truncated `TFNSW_API_KEY` left over in a session
// can silently shadow the real key. To make `npm run dev` "just work", this
// loader reads the repo-root `.env` and applies it with OVERRIDE semantics.
//
// SECURITY: values are only written into `process.env` of this process; nothing
// is logged. The `.env` file itself is gitignored.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

/**
 * Parse `KEY=VALUE` lines from a dotenv-formatted string. Blank lines and
 * `#` comments are ignored; surrounding single/double quotes are stripped.
 */
export function parseEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Load the repo-root `.env` into `process.env`, OVERRIDING any existing values
 * so a stale shell variable cannot shadow the file. Missing files are ignored
 * (the process then relies on the ambient environment). Safe to call once at
 * startup.
 *
 * @param envPath - optional explicit path; defaults to the repo-root `.env`
 *   resolved relative to this module (`backend/src/infra` → three levels up).
 */
export function loadEnvFile(envPath?: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = envPath ?? resolvePath(here, '..', '..', '..', '.env');

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // No .env; rely on the ambient environment.
  }

  const parsed = parseEnv(raw);
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = value;
  }
}
