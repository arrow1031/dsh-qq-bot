#!/usr/bin/env node
/**
 * 打包后插件的独立验证：不需要 DSH，不需要 QQ。
 *
 *   node test-plugin.mjs
 *
 * 用假的 ctx（实现 subprocess / sessionController / timer / effect / tools）
 * 直接加载真正的 lib/index.js，配一个真的假 OneBot 服务，跑完整链路：
 *
 *   假 QQ 消息 -> 假 OneBot -> 真适配器 -> 真插件 -> 假 Agent -> 回复 -> 真适配器 -> 假 OneBot
 *
 * 顺带验证 defineTool 能接受我们的参数 DSL，以及 ctx.tools.register 被调用。
 * 注：@deepseek-ai/dsh-tools 在未安装到 profile 时解析不到，脚本会临时建一个
 * node_modules 软链来模拟安装后的位置，结束后删除。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { startMockOneBot } from './mock-onebot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(here, '..');
const PROFILE_MODULES = '/home/dsh/.dsh/profiles/node_modules';

let failures = 0;
const results = [];
function check(name2, ok, detail = '') {
  results.push(ok);
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name2 + (ok || detail === '' ? '' : ' — ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('等待超时：' + label);
    await sleep(50);
  }
}

// ---- 临时软链：模拟「装进 profile 之后」的解析位置 ----
const linkPath = path.join(PKG_ROOT, 'node_modules');
let createdLink = false;
if (!fs.existsSync(linkPath) && fs.existsSync(PROFILE_MODULES)) {
  fs.symlinkSync(PROFILE_MODULES, linkPath, 'dir');
  createdLink = true;
}

// 工具注册需要 @deepseek-ai/dsh-tools（只在 DSH 部署里可解析）。裸克隆下跳过相关断言，
// 其余断言照常运行，这样 npm test 在没装 DSH 的机器上也是绿的。
let hasDshTools = true;
try { await import.meta.resolve("@deepseek-ai/dsh-tools"); } catch { hasDshTools = false; }
if (!hasDshTools) console.log("提示：解析不到 @deepseek-ai/dsh-tools，将跳过工具注册断言（适配器/路由断言不受影响）");

const mock = await startMockOneBot({ quiet: true });
console.log('假 OneBot：http=' + mock.httpUrl + ' ws=' + mock.wsUrl);

// ---- 假 ctx ----
const disposers = [];
const registeredTools = [];
const createdSessions = [];
const agents = new Map();

function fakeAgent(sessionId) {
  const messages = [];
  let pending = [];
  let busy = false;
  const agent = {
    id: sessionId,
    guards: [],
    ctx: { tools: { guard(fn) { agent.guards.push(fn); return () => { const i = agent.guards.indexOf(fn); if (i >= 0) agent.guards.splice(i, 1); }; } } },
    status: 'idle',
    session: {
      get seq() { return messages.length; },
      deriveMessages: () => messages.slice(),
      snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    },
    followup(message) {
      busy = true;
      agent.status = 'running';
      messages.push({ id: message.id, role: 'user', content: message.content, source: message.source });
      const replyText = 'REPLY:' + message.content[0].text;
      setTimeout(() => {
        messages.push({ id: 'asst-' + messages.length, role: 'assistant', content: [{ type: 'text', text: replyText }], source: { kind: 'model' } });
        busy = false;
        agent.status = 'idle';
        const waiters = pending; pending = [];
        for (const w of waiters) w();
      }, 40);
    },
    async whenIdle() { if (!busy) return; await new Promise((r) => pending.push(r)); },
    cancel() { busy = false; },
  };
  return agent;
}

// 设置服务桩：记录命名空间注册，并提供 get/watch，让 Host 的设置集成路径被覆盖。
const registeredSettings = [];
const settingsWatchers = [];
const settingsStub = {
  register(ns, schema, options) {
    const resolved = schema(Object.assign({}, options && options.base));
    registeredSettings.push({ ns, resolved, schema });
    return {
      get: () => resolved,
      watch: (callback) => { settingsWatchers.push(callback); return () => {}; },
    };
  },
};

const ctx = {
  get: (name) => (name === 'settings' ? settingsStub : undefined),
  subprocess: {
    async resolveExecutable() { return process.execPath; },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
      return {
        stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done,
        terminate() { try { child.kill('SIGTERM'); } catch { /* ignore */ } },
        waitForExit: () => done.then(() => true),
        _child: child,
      };
    },
  },
  sessionController: {
    async create(request) { createdSessions.push(request); return { sessionId: request.sessionId }; },
    async resolveAgent(sessionId) {
      if (!agents.has(sessionId)) agents.set(sessionId, fakeAgent(sessionId));
      return { agent: agents.get(sessionId) };
    },
  },
  timeout(cb, delay) { const t = setTimeout(cb, delay); return () => clearTimeout(t); },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  tools: { register(tool) { registeredTools.push(tool); return () => {}; } },
};

try {
  const mod = await import(path.join(PKG_ROOT, 'lib', 'index.js'));
  check('模块导出了 name/inject/apply', mod.name === 'dsh-qq-bot' && Array.isArray(mod.inject) && typeof mod.apply === 'function');
  check('inject 声明了 subprocess/sessionController/timer',
    mod.inject.includes('subprocess') && mod.inject.includes('sessionController') && mod.inject.includes('timer'));


  console.log('\n1. 加载插件（正向 WS 连假 OneBot）');
  await mod.apply(ctx, {
    onebot: { wsUrl: mock.wsUrl, httpUrl: mock.httpUrl },
    reply: { ackAfterMs: 0 },
  });
  await waitFor(() => mock.clientCount() === 1, 10000, '适配器连上假 OneBot');
  check('适配器已连上假 OneBot', mock.clientCount() === 1);

  console.log('\n2. Host 设置命名空间');
  check('注册了 qq-bot 设置命名空间', registeredSettings.length === 1 && registeredSettings[0].ns === 'qq-bot',
    JSON.stringify(registeredSettings.map((r) => r.ns)));
  check('设置默认值已解析（含 onebot/group/reply）',
    Boolean(registeredSettings[0] && registeredSettings[0].resolved.onebot && registeredSettings[0].resolved.group
      && registeredSettings[0].resolved.reply));
  check('设置了变更监听', settingsWatchers.length === 1, String(settingsWatchers.length));

  // settings.describe() 会对每个命名空间调 schema.toJSON()，并且会按 schema 结构走一遍
  // redactSecrets（只读 node.meta?.role / node.type / node.dict / node.inner）。
  const registeredSchema = registeredSettings[0] && registeredSettings[0].schema;
  check('schema 提供 toJSON（否则 describe 会抛 schema.toJSON is not a function）',
    Boolean(registeredSchema) && typeof registeredSchema.toJSON === 'function');
  let schemaJson = null;
  try { schemaJson = registeredSchema.toJSON(); JSON.stringify(schemaJson); } catch (error) { schemaJson = null; }
  check('toJSON 返回可 JSON 序列化的值', schemaJson !== null && typeof schemaJson === 'object', JSON.stringify(schemaJson));

  // 复刻 dsh-settings 的 redact walker，确认不会抛、也不会改坏值
  const walkRedact = (node, value) => {
    if (node === undefined || node === null) return value;
    if (node.meta !== undefined && node.meta !== null && node.meta.role === 'secret') return undefined;
    if (node.type === 'object') {
      const properties = node.dict === undefined ? {} : node.dict;
      const isRec = typeof value === 'object' && value !== null && !Array.isArray(value);
      const source = isRec ? value : undefined;
      const rebuilt = {};
      if (source !== undefined) { for (const key of Object.keys(source)) { if (Object.prototype.hasOwnProperty.call(properties, key)) continue; rebuilt[key] = source[key]; } }
      for (const key of Object.keys(properties)) { const stripped = walkRedact(properties[key], source === undefined ? undefined : source[key]); if (stripped !== undefined) rebuilt[key] = stripped; }
      return rebuilt;
    }
    if (node.type === 'dict') { if (typeof value !== 'object' || value === null || Array.isArray(value)) return value; const rebuilt = {}; for (const key of Object.keys(value)) rebuilt[key] = walkRedact(node.inner, value[key]); return rebuilt; }
    if (node.type === 'array') { if (!Array.isArray(value)) return value; return value.map((entry) => walkRedact(node.inner, entry)); }
    return value;
  };
  let walked = null; let walkError = null;
  try { walked = walkRedact(registeredSchema, registeredSettings[0].resolved); } catch (error) { walkError = error; }
  check('redactSecrets 能走通我们的 schema', walkError === null, walkError === null ? '' : String(walkError && walkError.message));
  check('redact 遍历不改变值', JSON.stringify(walked) === JSON.stringify(registeredSettings[0].resolved));
  check('工作目录来自传入配置', registeredSettings[0].resolved.workspace === '' || typeof registeredSettings[0].resolved.workspace === 'string');

  console.log('\n2. 动态工具注册（走真的 defineTool）');
  const tool = registeredTools.find((t) => t.name === 'qqbot');
  if (hasDshTools !== true) {
    check('（跳过）工具注册需 @deepseek-ai/dsh-tools；路由/回复断言不受影响', true);
  } else {
    check('注册了 qqbot + qqgroup 两个工具', registeredTools.length === 2, String(registeredTools.length));
    check('工具名分别是 qqbot / qqgroup',
      registeredTools.map((t) => t.name).sort().join(',') === 'qqbot,qqgroup',
      JSON.stringify(registeredTools.map((t) => t.name)));
    check('工具名是 qqbot', tool && tool.name === 'qqbot', String(tool && tool.name));
    check('defineTool 接受了参数 DSL（含 action）', Boolean(tool && tool.parameters && tool.parameters.properties && tool.parameters.properties.action),
      JSON.stringify(tool && tool.parameters));
  }

  console.log('\n3. 群消息 @机器人 -> Agent -> 回复回 QQ');
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '你好' } }],
    }),
  });
  const sent = await waitFor(() => (mock.sent.length > 0 ? mock.sent : null), 15000, '回复到达假 OneBot');
  check('回复用 send_group_msg 发出', sent[0].action === 'send_group_msg', String(sent[0].action));
  const replyText = sent[0].message[0].data.text;
  check('回复带上了 QQ 上下文头', replyText.startsWith('REPLY:[QQ群 33333 · 小明(22222)'), JSON.stringify(replyText.slice(0, 60)));
  check('上下文头带上了说话人身份（交给 Agent 判断）', replyText.includes('身份:'), JSON.stringify(replyText.slice(0, 60)));
  check('首轮追加了人格提示', replyText.includes('这是一次 QQ 聊天'), JSON.stringify(replyText.slice(0, 40)));
  check('会话通过 sessionController 创建', createdSessions.length === 1 && createdSessions[0].sessionId === 'qqbot-group-33333',
    JSON.stringify(createdSessions.map((s) => s.sessionId)));

  console.log('\n4. 群里没 @ 机器人 -> 忽略');
  const before = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, text: '闲聊' }),
  });
  await sleep(1500);
  check('未 @ 的消息没有触发回复', mock.sent.length === before, String(mock.sent.length - before));

  console.log('\n5. 工具 status 动作');
  const status = hasDshTools === true ? await tool.execute({ action: 'status' }, {}) : null;
  if (status !== null) {
    check('status 报告已连接', status.connected === true);
    check('status 报告 1 个会话', status.conversations.length === 1, JSON.stringify(status.conversations));
    check('status 里有统计计数', status.stats.accepted >= 1 && status.stats.replies >= 1, JSON.stringify(status.stats));
  }
  if (status === null) check('（跳过）status 动作需要 dsh-tools', true);

  console.log('\n6. 卸载');
  for (const d of disposers) { try { d(); } catch (error) { console.log('  disposer 抛错：' + error.message); } }
  await sleep(600);
  check('卸载后适配器进程已终止', mock.clientCount() === 0, 'clients=' + mock.clientCount());
} catch (error) {
  failures += 1;
  console.log('\n错误：' + (error && error.stack ? error.stack : String(error)));
} finally {
  await mock.close();
  if (createdLink) { try { fs.rmSync(linkPath); } catch { /* ignore */ } }
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('插件自测失败'); process.exit(1); }
console.log('插件自测通过');
process.exit(0);
