/**
 * PR-1 run_summary E2E driver (A 回收验证用，规格五场景 + T3 deny + T5 排队).
 *
 * Drives the real /ws/agent protocol (loadtest 同款链路)。Scenario selection via
 * SCENARIOS env (comma list): a,b,c,d,e,queue. One throwaway user per invocation
 * unless COOKIE/EMAIL provided.
 *
 * 本脚本是 Eval Harness PRD (docs/4. PRD/2026-07-07) M2 eval-runner 的雏形，
 * 2026-07-07 A 回收 PR-1 时首次投用（六场景全过，结果见任务中间态报告）。
 *
 * Usage (repo root; 环境起法见中间态报告 R2 的 recipe):
 *   LOADTEST=1 APP_URL=http://127.0.0.1:3100 WS_URL=ws://127.0.0.1:3201/ws/agent \
 *     SCENARIOS=a,b,c,d,e node scripts/eval/e2e-run-summary.mjs
 *   SCENARIOS=queue 需 ws-server 以 PER_USER_MAX_WORKERS=1 启动
 */
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { provisionUsers } from '../loadtest/auth-setup.mjs';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3100';
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:3201/ws/agent';
const SCENARIOS = (process.env.SCENARIOS || 'a').split(',').map((s) => s.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Open one WS connection; returns helpers to drive scenarios. */
function connect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { cookie } });
    const listeners = new Set();
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      for (const fn of [...listeners]) fn(msg);
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      send: (obj) => ws.send(JSON.stringify(obj)),
      // Wait for the first frame matching pred; reject on timeout.
      wait: (pred, timeoutMs = 120000, tag = '') =>
        new Promise((res, rej) => {
          const t = setTimeout(() => { listeners.delete(fn); rej(new Error(`timeout waiting ${tag}`)); }, timeoutMs);
          const fn = (msg) => { if (pred(msg)) { clearTimeout(t); listeners.delete(fn); res(msg); } };
          listeners.add(fn);
        }),
      onEach: (fn) => listeners.add(fn),
    }));
  });
}

async function createSession(c) {
  c.send({ type: 'create_session' });
  const init = await c.wait((m) => m.type === 'session_init', 30000, 'session_init');
  return init.sessionId;
}

const isTerminal = (m, sid) =>
  (m.type === 'done' || m.type === 'error' || m.type === 'aborted') &&
  (!m.sessionId || !sid || m.sessionId === sid || true);

async function scenarioA(c) {
  const sid = await createSession(c);
  log('A: session', sid);
  c.send({ type: 'chat', sessionId: sid, content: '请在工作目录创建文件 e2e-proof.txt，内容写 kin-e2e-ok。必须真正调用 Write 工具创建文件，不要只口头回答。创建后用 Read 工具读回来确认。' });
  const t = await c.wait((m) => isTerminal(m, sid), 180000, 'A terminal');
  log('A terminal:', t.type);
  return { sid, terminal: t.type };
}

async function scenarioB(c) {
  const sid = await createSession(c);
  log('B: session', sid);
  c.send({ type: 'chat', sessionId: sid, content: '请从 1 数到 100，每个数字换行，边想边慢慢输出。' });
  await c.wait((m) => m.type === 'message', 120000, 'B first token');
  await sleep(1500);
  c.send({ type: 'abort', sessionId: sid });
  const t = await c.wait((m) => m.type === 'aborted', 60000, 'B aborted');
  log('B terminal:', t.type);
  return { sid, terminal: t.type };
}

async function scenarioC(c) {
  const sid = await createSession(c);
  log('C: session', sid);
  c.send({ type: 'chat', sessionId: sid, permissionTier: 'ask', content: '请在工作目录创建文件 deny-me.txt，内容写 should-be-denied。必须真正调用 Write 工具创建，不要口头回答。' });
  const req = await c.wait((m) => m.type === 'approval_request', 180000, 'C approval_request');
  log('C approval_request tool:', req.toolName, req.toolUseID);
  c.send({ type: 'approval_response', sessionId: sid, toolUseID: req.toolUseID, decision: 'deny' });
  const t = await c.wait((m) => isTerminal(m, sid), 180000, 'C terminal');
  log('C terminal:', t.type);
  return { sid, terminal: t.type, toolUseID: req.toolUseID };
}

async function scenarioD(c) {
  const sid = await createSession(c);
  log('D: session', sid);
  c.send({ type: 'chat', sessionId: sid, content: '请用 Bash 运行 `sleep 30 && echo done-sleeping`，等它完成。' });
  await c.wait((m) => m.type === 'message', 120000, 'D first token');
  await sleep(4000); // let the worker settle into the tool call
  const pids = execSync("ps ax -o pid=,command= | grep 'ws-query-worker' | grep -v grep | awk '{print $1}'")
    .toString().trim().split('\n').filter(Boolean);
  log('D: killing worker pids', pids);
  for (const pid of pids) { try { execSync(`kill -9 ${pid}`); } catch {} }
  const t = await c.wait((m) => m.type === 'error' || m.type === 'aborted' || m.type === 'done', 60000, 'D terminal');
  log('D terminal:', t.type, t.code || '');
  return { sid, terminal: t.type };
}

async function scenarioE(c) {
  const sid = await createSession(c);
  log('E: session', sid);
  c.send({ type: 'chat', sessionId: sid, content: '第一条：请从 1 数到 50。' });
  await c.wait((m) => m.type === 'message', 120000, 'E first token of run1');
  c.send({ type: 'chat', sessionId: sid, content: '第二条（覆盖）：只回答两个字：好的。' });
  const t = await c.wait((m) => m.type === 'done', 180000, 'E done of run2');
  log('E terminal:', t.type);
  await sleep(2000);
  return { sid, terminal: t.type };
}

// T5 queue: two sessions, same user, PER_USER_MAX_WORKERS=1 on the ws-server.
async function scenarioQueue(c) {
  const sid1 = await createSession(c);
  c.send({ type: 'chat', sessionId: sid1, content: '请用 Bash 运行 `sleep 10 && echo q1`，等它完成后告诉我。' });
  await c.wait((m) => m.type === 'message', 120000, 'queue run1 first token');
  const sid2 = await createSession(c);
  log('queue: run1', sid1, 'run2', sid2);
  c.send({ type: 'chat', sessionId: sid2, content: '只回答两个字：好的。' });
  const q = await c.wait((m) => m.type === 'queued', 30000, 'queued frame').catch(() => null);
  log('queue: queued frame:', q ? JSON.stringify(q) : 'NOT RECEIVED');
  let doneCount = 0;
  await new Promise((res) => c.onEach((m) => { if (m.type === 'done') { doneCount++; if (doneCount >= 2) res(); } }));
  log('queue: both done');
  return { sid1, sid2 };
}

const [user] = await provisionUsers({ count: 1, appUrl: APP_URL, tag: `e2e${Date.now()}` });
log('user:', user.email);
const c = await connect(user.cookie);
const results = {};
for (const s of SCENARIOS) {
  const fn = { a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD, e: scenarioE, queue: scenarioQueue }[s];
  if (!fn) { log('skip unknown scenario', s); continue; }
  try {
    results[s] = await fn(c);
    await sleep(2500); // let close-handler flush run_summary
  } catch (err) {
    results[s] = { error: String(err) };
    log(`scenario ${s} FAILED:`, String(err));
  }
}
log('RESULTS', JSON.stringify(results, null, 2));
c.ws.close();
process.exit(0);
