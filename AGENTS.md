# 协作原则

## 先自测，后邀请（2026-10-01 用户确立）

Agent 交付任何功能/修复前，**必须先用可用仪器自行完成实测与调试**，全链路跑通、证据在档之后，才可邀请用户做人工确认测试。禁止让用户在中间传话（「你帮我看看手机上显示什么」）。

本仓可用的自测仪器：

- **iPhone**：`ios-webkit-debug-proxy`（本机已装）→ CDP 驱动 Safari（DOM 读取/Runtime.evaluate/导航），PWA 内有 `__p2pNetDebug()` 调试钩子；
- **Android**：`adb` + **CDP**（MIUI 浏览器暴露 `browser_webview_devtools_remote_<pid>` socket：`adb shell cat /proc/net/unix | grep devtools` 找到 socket 名，`adb forward tcp:9334 localabstract:<名>`，即可用通用 CDP 驱动 DOM/JS）——2026-10-03 实证打通，此前的「Android 无 CDP」判断作废；辅以 `adb exec-out screencap` 截图取证、`adb shell input tap/swipe` 触控（注意：抽屉等动画完成前点击会落在遮罩上；`input text` 会过中文 IME 拼音重组且遇 `&` 截断——先切键盘「中/英」到英文模式，URL 只用无 `&` 形态）；
- **host 侧**：`~/.p2p-net/logs/events.jsonl`（会话事件）/ `current.jsonl`（运行日志）/ `curl 127.0.0.1:19727/status`；
- **单元/契约**：`npm test`（lint:twins + lint:docs + parallel + serial + parity）。

仅当步骤在物理上无法自动化（如 iPhone 切 WiFi/蜂窝）时，才把该步留给用户，且须把其余全部验完、把留给用户的步骤压缩到最小。
