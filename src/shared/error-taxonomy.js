/**
 * Error Taxonomy (T1)
 *
 * Shared, pure-JS classification of run terminal outcomes. Imported by both the
 * TypeScript app (routes, tests) and the plain-JS ws-server.mjs, so it must stay
 * ESM-only with no TypeScript syntax.
 */

/**
 * @typedef {'user_abort' | 'permission_denied' | 'tool_error' | 'api_error' | 'worker_crash' | 'env_error' | 'timeout' | 'context_overflow' | 'task_failure' | 'unknown'} ErrorType
 */

/** @type {ErrorType[]} */
export const ERROR_TYPES = [
  'user_abort',
  'permission_denied',
  'tool_error',
  'api_error',
  'worker_crash',
  'env_error',
  'timeout',
  'context_overflow',
  'task_failure',
  'unknown',
];

/** @type {Set<string>} */
const ENV_INFRA_SIGNATURES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

/**
 * @typedef {object} ClassifyContext
 * @property {string} terminalState - 'done' | 'error' | 'aborted' | 'worker_crash'
 * @property {boolean} [intentionalAbort]
 * @property {object|null} [lastResultEvent]
 * @property {number} [approvalDenyCount]
 * @property {boolean} [lastToolErrorWasDenied] - true if the last is_error tool_result was for a denied tool_use_id
 * @property {boolean} [lastToolError]
 * @property {string} [stderrTail]
 */

/**
 * Classify a run's terminal outcome into a canonical ErrorType.
 *
 * Priority (per PRD §3.6 / 实施规格 T1):
 *  1. intentionalAbort              → user_abort
 *  2. worker_crash + infra stderr   → env_error
 *     worker_crash                  → worker_crash
 *  3. result.subtype                → timeout | context_overflow | api_error | null
 *  4. deny + tool error adjacent    → permission_denied
 *  5. tool error                    → tool_error
 *  6. terminal error frame          → api_error
 *  7. fallback                      → unknown
 *
 * @param {ClassifyContext} ctx
 * @returns {ErrorType | null}
 */
export function classifyTerminal(ctx) {
  const terminalState = ctx.terminalState;
  const intentionalAbort = !!ctx.intentionalAbort;
  const lastResultEvent = ctx.lastResultEvent || null;
  const approvalDenyCount = ctx.approvalDenyCount || 0;
  const lastToolErrorWasDenied = !!ctx.lastToolErrorWasDenied;
  const lastToolError = !!ctx.lastToolError;
  const stderrTail = ctx.stderrTail || '';

  // 1. User-initiated abort
  if (intentionalAbort || terminalState === 'aborted') {
    return 'user_abort';
  }

  // 2. Worker process crashed/exited without terminal frame
  if (terminalState === 'worker_crash') {
    if (stderrTail && [...ENV_INFRA_SIGNATURES].some((sig) => stderrTail.includes(sig))) {
      return 'env_error';
    }
    return 'worker_crash';
  }

  // 3. Completed successfully — nothing to classify. Checked before tool-level
  // signals so a mid-run tool error the agent recovered from doesn't taint a done run.
  if (terminalState === 'done') {
    return null;
  }

  // 4. HITL deny of the specific tool that produced the last error → permission_denied.
  // lastToolErrorWasDenied is true iff the final is_error tool_result's tool_use_id
  // was in the run's denied set. Checked BEFORE result-subtype mapping (规格 T1
  // priority): a deny surfacing as a non-success subtype must attribute to the
  // denial, not api_error.
  if (approvalDenyCount > 0 && lastToolErrorWasDenied) {
    return 'permission_denied';
  }

  // 5. Specific terminal subtypes beat a preceding tool error: if the run kept
  // going after the last tool error and then timed out / overflowed, THAT is the
  // terminal cause. Generic non-success stays below tool_error (step 7).
  const subtype =
    lastResultEvent && typeof lastResultEvent.subtype === 'string' ? lastResultEvent.subtype : null;
  if (subtype === 'timeout') return 'timeout';
  if (subtype === 'context_overflow') return 'context_overflow';

  // 6. Tool error without deny context
  if (lastToolError) {
    return 'tool_error';
  }

  // 7. Generic non-success result subtype
  if (subtype && subtype !== 'success') {
    return 'api_error';
  }

  // 7. Worker emitted an explicit error frame
  if (terminalState === 'error') {
    return 'api_error';
  }

  return 'unknown';
}

/**
 * Validate that a string is a known ErrorType.
 * @param {string} value
 * @returns {value is ErrorType}
 */
export function isErrorType(value) {
  return typeof value === 'string' && ERROR_TYPES.includes(value);
}
