#!/usr/bin/env node
/** p2p-net CLI 入口：util.parseArgs 分发 init|login|start|service|status|doctor。
 *  init/login/start/service/status 已可用（Task 13/17/18/19）；doctor 为「后续阶段提供」的明确占位。
 *  无参/--help → 帮助（exit 0）；未知命令 → stderr 提示 + 帮助（exit 1）。
 *  strict: false：子命令各自的选项归各命令自行解析（如 start --foreground），入口不抢先拒绝。
 *
 *  start 是长驻前台进程：runStart 装配完成后进程靠控制面/发现端点 server handle 存活；
 *  SIGINT/SIGTERM → handle.stop() 干净收尾（配对环/HostAgent/隧道/scanner/server）后退出。
 *  service install 装的常驻单元正是以 start --foreground 拉起本入口。
 */

import { parseArgs } from 'node:util';

import { runInit } from './init.js';
import { runLogin } from './login.js';
import { runService } from './service.js';
import { runStart } from './start.js';
import { runStatus } from './status.js';

const HELP = `p2p-net — Self-hosted WebRTC remote-access data plane

用法：p2p-net <command> [options]

命令：
  init      初始化部署（Supabase 引导 + 逐台 VPS 编排）
  login     登录并保存凭据（auth.json，0600）
  start     前台启动桌面端代理（--foreground 由常驻服务调用，抑制提示横幅）
  service   常驻服务管理 install|uninstall|status|logs（崩溃自愈 + 开机自启）
  status    查看运行状态（设备/活跃会话/链路模式/平均 RTT/服务数）
  doctor    分层诊断（后续阶段提供 / coming in a later phase）

选项：
  -h, --help  显示本帮助
`;

const COMING_SOON = new Set(['doctor']);

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

  if (cmd === 'login') {
    try {
      await runLogin();
      return 0;
    } catch (e) {
      // AuthError/ConfigError 的 message 已是人话（含 p2p-net login / init 指引），不甩堆栈
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }

  if (cmd === 'start') {
    try {
      const handle = await runStart({ foreground: values.foreground === true });
      const shutdown = () => {
        void handle.stop().finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return 0; // 进程靠控制面/发现端点 server handle 存活
    } catch (e) {
      // 预期失败（ConfigError/AuthError/未登录/端口被占）message 已是人话，不甩堆栈
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }

  if (cmd === 'service') {
    try {
      // 原始 argv 切片透传：logs -f 等子命令选项由 runService 自行解析
      return await runService(argv.slice(argv.indexOf(cmd) + 1));
    } catch (e) {
      // ServiceError 的 message 已是人话（含用法/下一步指引），不甩堆栈
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }

  if (cmd === 'status') {
    // runStatus 内部已把不可达/非 2xx/畸形响应全部折成人话 + exit 1，不会抛堆栈
    return await runStatus();
  }

  if (COMING_SOON.has(cmd)) {
    console.log(`「p2p-net ${cmd}」尚未实现，将在后续阶段提供（coming in a later phase）。`);
    console.log('当前可用命令：p2p-net init / login / start / service');
    return 0;
  }

  console.error(`未知命令：${cmd}`);
  console.error(HELP);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
