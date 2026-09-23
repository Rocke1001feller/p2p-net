# p2p-net ROADMAP

> 一期（v0.1.0 MVP）已完成并验收；本文件追踪二期及以后的所有计划，防止遗忘。
> 每条注明来源（用户反馈 / 实测发现 / 遗留项）。完成即勾选并注明版本。

## 一期 v0.1.0（已完成）

- A类入口（VPS + Caddy + https://IP + 扫码/URL）、supabase 账号体系（signup/login）
- WebRTC 数据面（P2P 优先 / TURN 中继兜底）、服务清单转发（svc=N）
- launchd/systemd 服务化（install 必选）、结构化日志 + 事件流（events.jsonl）+ 19727/status + p2p-net bench
- 验收：296 单测全绿、bench 达标、60min 浸泡 4 次掉线全自愈（e2e/real-service-soak.md）、
  Android 蜂窝真机 E2E（e2e/android-cellular.md）、真人实测（e2e/human-live-2026-09-23.md）

## 二期（发布后第一批）

### 网络与性能（来源：真人实测新发现）
- [ ] **队头阻塞优化**：隧道响应 gzip/br 压缩（JSON 可 -85%）+ 大 payload 分页/增量 + 小请求优先级。实测依据：human-live 报告 §3.1
- [ ] **「绿点假象」**：健康指示改为「在飞请求时长」驱动，stall 期如实显示黄/红
- [ ] **TURN/NAT 路径回收**（浸泡遗留#1）：会话以 ~15min 周期死亡重建的根因排查
- [ ] LIVENESS 45s 阈值用更多真实数据复评（当日 stall 中位 30s，4 次 >50s 判死）
- [ ] 网络质量测评 case 库：横向对比指标（RTT 分布/吞吐/stall 频率/自愈时长），形成「选宽带」式标尺（来源：用户验收反馈第六条）

### 产品能力（来源：用户脑暴与反馈）
- [ ] B类入口：Cloudflare Pages 部署 PWA（xxx.pages.dev，每账号一个）
- [ ] Windows 服务化（当前仅 launchd/systemd）
- [ ] TURN secret 轮换命令
- [ ] 多 Server 聚合 UI（S1/S2 互联、服务清单按 server 分组 tab）
- [ ] 设备生命周期命令补全：`p2p-net uninstall`（干净卸载）、`status`（含未登录时引导）、`version`、`update`（覆盖式升级，任何时刻单实例单版本）（来源：用户验收反馈第二/四条）
- [ ] dva-* 多平台安装测试矩阵（dva-win / dva-mac / dva-linux / dva-mac-arm64 self-hosted runners），接入后验证 server↔server 互通（来源：用户验收反馈第一/三条）
- [ ] PWA「添加到主屏幕」引导 + 设备卡「上次连接」时间戳刷新修复

### 账号与生态（来源：用户脑暴，明确二期）
- [ ] **扫码即登录延续到所有接入服务**：p2p-net 账号一次扫码，服务清单内所有服务免单独登录（统一 token 注入/代理鉴权接口设计）

## 三期+（远期构思，仅备忘）
- CloudCLI 等更多服务清单项接入打磨；10 万用户容量规划（docs/capacity-plan-100k.md 延续）
- P2P 直连率提升（NAT 打洞成功率统计与优化）

## 发布当日 checklist（一期收尾）
1. [x] 真机 E2E + 真人实测（本目录两份报告）
2. [x] ~~确认 npm 名字 `p2p-net` 可用~~ → 裸名被占位保护拦截（与 p2pnet 相似），更名 `@rocke1001feller/p2p-net`（bin 仍为 p2p-net）
3. [x] `gh repo create p2p-net --public --source=. --push` → https://github.com/Rocke1001feller/p2p-net
4. [x] `npm publish --access public` → **@rocke1001feller/p2p-net@0.1.0 已发布**（2026-09-23，注册表传播 ~8min，npx 冒烟通过）
5. [x] `git tag v0.1.0 && git push origin main --tags`
6. [x] T9 env-gated 真 sshd 测试——已由当日真 VPS init/deploy/验收合并认定
