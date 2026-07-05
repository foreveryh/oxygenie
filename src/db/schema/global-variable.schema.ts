/**
 * global_variable — admin-managed variables/secrets beyond model credentials
 * (registry v2). For API keys that MCP servers / skills / tools need (e.g.
 * TAVILY_API_KEY), configured in the UI instead of `.env`.
 *
 * Values are ALWAYS stored sealed (secret-box, KIN_SECRET_KEY); `isSecret` only
 * controls UI display (mask vs plaintext). `injectWorker` opts the variable into the
 * agent worker's process env at spawn (ws-server decrypts just-in-time). The agent's
 * sandboxed bash does NOT inherit worker env (src/claude/bash/runner.js builds a
 * minimal env), so injected secrets stay out of the model-visible shell.
 *
 * Key naming is env-style (^[A-Z][A-Z0-9_]*$) with a reserved-prefix blocklist
 * (ANTHROPIC_*, CLAUDE_*, KIN_*, DATABASE_* …) enforced in the server fns so a
 * variable can never shadow model routing or platform config.
 *
 * See coordination-repo PRD 2026-07-05-模型注册表v2与全局变量-PRD.md §4.
 */

import { pgTable, text, boolean } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './_shared';

export const globalVariable = pgTable('global_variable', {
  // Env-style name, e.g. "TAVILY_API_KEY". Primary key — one value per name.
  key: text('key').primaryKey(),
  // secret-box sealed value (never plaintext, even for isSecret=false rows).
  valueEncrypted: text('value_encrypted').notNull(),
  // UI display only: mask (true) vs show decrypted value to admins (false).
  isSecret: boolean('is_secret').notNull().default(true),
  // Inject into the agent worker env at spawn (and thus stdio MCP servers it starts).
  injectWorker: boolean('inject_worker').notNull().default(true),
  description: text('description'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type GlobalVariable = typeof globalVariable.$inferSelect;
export type NewGlobalVariable = typeof globalVariable.$inferInsert;
