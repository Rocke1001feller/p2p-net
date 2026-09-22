#!/usr/bin/env node
/** p2p-net CLI 入口：util.parseArgs 分发 init|login|start|service|doctor|status。
 *  当前只有 init 可用（Task 13）；其余命令为「后续阶段提供」的明确占位（人话提示，exit 0）。
 *  无参/--help → 帮助（exit 0）；未知命令 → stderr 提示 + 帮助（exit 1）。
 *  strict: false：子命令各自的选项归各阶段自行解析，入口不抢先拒绝。
 */

import { parseArgs } from 'node:util';

import { runInit } from './init.js';

const HELP = `p2p-net — Self-hosted WebRTC remote-access data plane

用法：p2p-net <command> [options]

命令：
  init      初始化部署（Supabase 引导 + 逐台 VPS 编排）
  login     登录并保存凭据（后续阶段提供 / coming in a later phase）
  start     前台启动桌面端代理（后续阶段提供 / coming in a later phase）
  service   常驻服务管理 install|start|stop|status（后续阶段提供 / coming in a later phase）
  doctor    分层诊断（后续阶段提供 / coming in a later phase）
  status    查看运行状态（后续阶段提供 / coming in a later phase）

选项：
  -h, --help  显示本帮助
`;

const COMING_SOON = new Set(['login', 'start', 'service', 'doctor', 'status']);

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: { help: { type: 'boolean', short: 'h', default: false } },
  });

  const cmd = positionals[0];
  if (values.help || cmd === undefined || cmd === 'help') {
    console.log(HELP);
    return 0;
  }

  if (cmd === 'init') {
    try {
      await runInit();
      return 0;
    } catch (e) {
      // InitError/ConfigError 的 message 已是"说人话+可操作"文案，直接呈现
      console.error(`init 失败：${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  if (COMING_SOON.has(cmd)) {
    console.log(`「p2p-net ${cmd}」尚未实现，将在后续阶段提供（coming in a later phase）。`);
    console.log('当前可用命令：p2p-net init');
    return 0;
  }

  console.error(`未知命令：${cmd}`);
  console.error(HELP);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
