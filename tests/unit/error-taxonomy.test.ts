/**
 * Unit tests for the shared error taxonomy (T1).
 */
import { describe, it, expect } from 'vitest';
import { classifyTerminal, ERROR_TYPES, isErrorType } from '~/shared/error-taxonomy';

describe('classifyTerminal', () => {
  it('returns user_abort for intentional abort', () => {
    expect(classifyTerminal({ terminalState: 'aborted', intentionalAbort: true })).toBe('user_abort');
  });

  it('returns user_abort for aborted terminal state even without flag', () => {
    expect(classifyTerminal({ terminalState: 'aborted' })).toBe('user_abort');
  });

  it('classifies worker_crash', () => {
    expect(classifyTerminal({ terminalState: 'worker_crash' })).toBe('worker_crash');
  });

  it('classifies env_error when stderr has infrastructure signature', () => {
    expect(classifyTerminal({ terminalState: 'worker_crash', stderrTail: 'connect ECONNREFUSED 127.0.0.1' })).toBe('env_error');
    expect(classifyTerminal({ terminalState: 'worker_crash', stderrTail: 'getaddrinfo ENOTFOUND api.example.com' })).toBe('env_error');
  });

  it('maps result subtype to timeout/context_overflow/api_error', () => {
    expect(classifyTerminal({ terminalState: 'error', lastResultEvent: { subtype: 'timeout' } })).toBe('timeout');
    expect(classifyTerminal({ terminalState: 'error', lastResultEvent: { subtype: 'context_overflow' } })).toBe('context_overflow');
    expect(classifyTerminal({ terminalState: 'error', lastResultEvent: { subtype: 'rate_limit' } })).toBe('api_error');
  });

  it('returns null for successful result', () => {
    expect(classifyTerminal({ terminalState: 'done', lastResultEvent: { subtype: 'success' } })).toBeNull();
  });

  it('classifies permission_denied when the last tool error was for a denied tool', () => {
    expect(
      classifyTerminal({
        terminalState: 'error',
        lastResultEvent: { subtype: 'success' },
        approvalDenyCount: 1,
        lastToolError: true,
        lastToolErrorWasDenied: true,
      }),
    ).toBe('permission_denied');
  });

  it('classifies tool_error when no deny context', () => {
    expect(
      classifyTerminal({
        terminalState: 'error',
        lastToolError: true,
      }),
    ).toBe('tool_error');
  });

  it('classifies tool_error when a tool was denied but the final error is a different tool', () => {
    expect(
      classifyTerminal({
        terminalState: 'error',
        approvalDenyCount: 1,
        lastToolError: true,
        lastToolErrorWasDenied: false,
      }),
    ).toBe('tool_error');
  });

  it('classifies explicit worker error frame as api_error when no result', () => {
    expect(classifyTerminal({ terminalState: 'error' })).toBe('api_error');
  });

  it('returns unknown for unrecognized state', () => {
    expect(classifyTerminal({ terminalState: 'weird' as any })).toBe('unknown');
  });

  it('prioritizes user_abort over result subtype', () => {
    expect(
      classifyTerminal({
        terminalState: 'aborted',
        intentionalAbort: true,
        lastResultEvent: { subtype: 'timeout' },
      }),
    ).toBe('user_abort');
  });

  it('prioritizes result subtype over tool_error', () => {
    expect(
      classifyTerminal({
        terminalState: 'error',
        lastResultEvent: { subtype: 'timeout' },
        lastToolError: true,
      }),
    ).toBe('timeout');
  });

  it('prioritizes permission_denied over plain tool_error only when the error tool was denied', () => {
    expect(
      classifyTerminal({
        terminalState: 'error',
        approvalDenyCount: 1,
        lastToolError: true,
        lastToolErrorWasDenied: true,
      }),
    ).toBe('permission_denied');
  });

  it('prioritizes permission_denied over a non-success result subtype (deny surfacing as error_during_execution must not become api_error)', () => {
    expect(
      classifyTerminal({
        terminalState: 'error',
        lastResultEvent: { subtype: 'error_during_execution' },
        approvalDenyCount: 1,
        lastToolError: true,
        lastToolErrorWasDenied: true,
      }),
    ).toBe('permission_denied');
  });

  it('clears nothing on done: a recovered mid-run tool error yields null for a done run', () => {
    expect(
      classifyTerminal({
        terminalState: 'done',
        lastResultEvent: { subtype: 'success' },
        lastToolError: false,
      }),
    ).toBe(null);
  });
});

describe('ERROR_TYPES / isErrorType', () => {
  it('covers all expected values', () => {
    expect(new Set(ERROR_TYPES)).toEqual(
      new Set([
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
      ]),
    );
  });

  it('validates known error types', () => {
    expect(isErrorType('tool_error')).toBe(true);
    expect(isErrorType('not_real')).toBe(false);
  });
});
