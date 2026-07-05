/**
 * Global-variable key hygiene rules (registry v2) — DB-free so both the service
 * layer and unit tests can import it without a database. ws-server.mjs keeps its
 * own plain-JS copy of the blocklist (it imports only .js from src/); keep the two
 * lists in sync when editing.
 */

export const GLOBAL_VAR_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Prefix/name blocklist — vars that would shadow routing/platform/system config. */
export const RESERVED_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'KIN_',
  'OXY_',
  'DATABASE_',
  'POSTGRES_',
  'REDIS_',
  'BETTER_AUTH',
  'NODE_',
  'WS_',
  'APP_',
  'EXEC_',
  'BASH_RUNNER_',
];

export const RESERVED_EXACT = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'PORT'];

/** Throws (Chinese, user-facing) when a key is not safe to define. */
export function assertGlobalVarKeyAllowed(key: string): void {
  if (!GLOBAL_VAR_KEY_RE.test(key)) {
    throw new Error('变量名必须是大写字母开头的环境变量风格（A-Z、0-9、下划线），如 TAVILY_API_KEY');
  }
  if (RESERVED_EXACT.includes(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(`变量名「${key}」属于系统保留命名（模型路由/平台配置），请换一个名字`);
  }
}
