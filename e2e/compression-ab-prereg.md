# 压缩 A/B 预注册（spec D6，2026-09-23 开跑前固定，不许后改）

- 假设 H6：大 payload（≥16KB 文本类）期，1KB 探测排队时延 p50 降 ≥30%，且中继线字节量降 ≥20%。
- 唯一变量：host 进程 env P2P_NET_GZIP（off / on）。
- 设计：A(off) → B(on) → A(反转) 三段，真机蜂窝强制 TURN（?transport=relay）；
  每段跑同一 payload 清单（devanywhere-ui 首屏 + /size/1MiB ×3），记录：探测 p50/p95、
  /status dataPlane.totals.bytesSent 增量、__p2pNetDebug().frames.bytesRecv 增量。
- 判定：两假设同时成立 → 默认开（下版本改 DEFAULT）；任一不成立 → 保持实验档关闭。
- 撤退线：任一指标劣化 >5%（含小请求路径）→ 立即关并记结论。
- 执行窗口：Task 13 真机门禁同一连接窗口内完成（不重开连接）。
