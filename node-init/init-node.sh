#!/usr/bin/env bash
# p2p-net VPS 初始化：coturn + caddy（钉版官方二进制）+ p2p-net-tunnel + PWA 托管。
# 幂等，可重跑：全部配置整文件覆盖写入（> 而非 >>），安装/enable 天然幂等。
#
# 入参（环境变量）：
#   TURN_SECRET    必填，coturn static-auth-secret（TURN REST 临时凭据 HMAC 密钥）
#   TUNNEL_SECRET  必填，隧道 token HMAC 密钥（注入 p2p-net-tunnel.service）
#   PWA_DIR        可选，PWA 静态文件目录，默认 /opt/p2p-net/pwa
#   P2PNET_VERSION 可选，npm 安装的 p2p-net 版本，默认 latest
#   P2PNET_PUBLIC_IP / P2PNET_PRIVATE_IP  可选，跳过 IP 自动探测
#   P2PNET_DRYRUN=1  只渲染三份配置到 stdout，不安装（供测试/审阅）
#
# 仅支持 Ubuntu 22.04/24.04、Debian 12；配置事实源：coturn-relay-ops.md §1（生产实机）。
set -euo pipefail

CADDY_VERSION=2.11.4   # apt 源版本过老无 ACME profile，需 >=2.10 才签得出 LE IP 证书
NODE_VERSION=22.20.0   # p2p-net 要求 node>=20，apt 源版本过老

die() { echo "init-node: 错误：$*" >&2; exit 1; }
log() { echo "init-node: $*"; }

: "${TURN_SECRET:?必须设置环境变量 TURN_SECRET（coturn static-auth-secret）}"
: "${TUNNEL_SECRET:?必须设置环境变量 TUNNEL_SECRET（隧道 HMAC 密钥）}"
PWA_DIR="${PWA_DIR:-/opt/p2p-net/pwa}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_IP=""
PRIVATE_IP=""

# 多源兜底：单一出口探测站在跨境链路抖动时偶发超时（E2E 实测 ifconfig.me 同一分钟内一成一败）
detect_public_ip() {
  local url got
  for url in https://ifconfig.me https://api.ipify.org https://ip.sb; do
    got="$(curl -4 -fsSL --max-time 5 "$url" 2>/dev/null || true)"
    if [ -n "$got" ]; then printf '%s' "$got"; return 0; fi
  done
  return 1
}

detect_ips() {
  # NAT 机型关键：公网 IP 经外网服务探测，内网 IP 取默认路由网卡；两者成对写入 external-ip
  # 强制 -4：全链路（creds.host、PWA URL、LE IP 证书、coturn external-ip）都是 IPv4 语义，双栈机若探到 v6 会全线错配
  PUBLIC_IP="${P2PNET_PUBLIC_IP:-${P2PNET_TEST_PUBLIC_IP:-$(detect_public_ip || true)}}"
  PRIVATE_IP="${P2PNET_PRIVATE_IP:-${P2PNET_TEST_PRIVATE_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || true)}}"
  [ -n "$PUBLIC_IP" ] || die "无法探测公网 IP，请设 P2PNET_PUBLIC_IP 重跑"
  [ -n "$PRIVATE_IP" ] || die "无法探测内网 IP，请设 P2PNET_PRIVATE_IP 重跑"
}

render_turnserver_conf() {
  cat <<EOF
listening-port=3478
external-ip=${PUBLIC_IP}/${PRIVATE_IP}
min-port=50000
max-port=50019
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=p2p-net
fingerprint
verbose
no-cli
no-multicast-peers
EOF
}

render_caddyfile() {
  cat <<EOF
{
    default_sni ${PUBLIC_IP}
}

https://${PUBLIC_IP} {
    root * ${PWA_DIR}
    file_server
    reverse_proxy /tunnel/* 127.0.0.1:19700
    tls {
        issuer acme {
            profile shortlived
        }
    }
}
EOF
}

render_tunnel_service() {
  cat <<EOF
[Unit]
Description=p2p-net tunnel relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/p2p-net/tunnel-relay-entry.mjs
Environment=TUNNEL_SECRET=${TUNNEL_SECRET}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

render_all() {
  echo "=== /etc/turnserver.conf ==="
  render_turnserver_conf
  echo "=== /etc/caddy/Caddyfile ==="
  render_caddyfile
  echo "=== /etc/systemd/system/p2p-net-tunnel.service ==="
  render_tunnel_service
}

unsupported_os() {
  die "unsupported OS：暂不支持 $1，仅支持 Ubuntu 22.04/24.04 与 Debian 12"
}

check_os_real() {
  [ -r /etc/os-release ] || die "无法读取 /etc/os-release"
  # shellcheck disable=SC1091
  . /etc/os-release
  # shellcheck disable=SC2154
  case "${ID}" in
    ubuntu) [ "${VERSION_ID}" = "22.04" ] || [ "${VERSION_ID}" = "24.04" ] || unsupported_os "Ubuntu ${VERSION_ID}" ;;
    debian) [ "${VERSION_ID}" = "12" ] || unsupported_os "Debian ${VERSION_ID}" ;;
    *) unsupported_os "${ID}" ;;
  esac
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y coturn curl ca-certificates xz-utils || die "apt 安装基础组件失败"
  # caddy 先走 apt：拿到官方 unit、caddy 用户与 /etc/caddy 目录；二进制随后替换为钉版。
  # Ubuntu 22.04 发行版源（含腾讯云镜像）没有 caddy 包 → 回退手工等价物（user+dirs+unit），
  # 二进制同样由 install_caddy_binary 钉版，两条路径殊途同归。
  if ! apt-get install -y caddy; then
    log "发行版源无 caddy 包（如 Ubuntu 22.04），改用手工 bootstrap（user+dirs+unit）"
    getent group caddy >/dev/null || groupadd --system caddy || die "创建 caddy 组失败"
    getent passwd caddy >/dev/null || useradd --system --gid caddy --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy || die "创建 caddy 用户失败"
    mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
    chown caddy:caddy /var/lib/caddy /var/log/caddy
    cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
  fi
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$major" -ge 20 ]; then
      log "node $(node -v) 已满足 >=20，跳过安装"
      return
    fi
    log "系统 node $(node -v) 低于 v20，改装官方 v${NODE_VERSION}"
  fi
  local arch
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64) arch=x64 ;;
    arm64) ;;
    *) die "不支持的 CPU 架构：$arch" ;;
  esac
  curl -fsSL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
  ln -sf /usr/local/bin/node /usr/bin/node
  hash -r
  log "node $(/usr/bin/node -v) 安装完成"
}

install_caddy_binary() {
  if /usr/bin/caddy version 2>/dev/null | grep -q "v${CADDY_VERSION}"; then
    log "caddy v${CADDY_VERSION} 已就位，跳过下载"
    return
  fi
  local arch
  arch="$(dpkg --print-architecture)"
  curl -fsSL --retry 3 "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${arch}.tar.gz" -o /tmp/caddy.tar.gz
  tar -xzf /tmp/caddy.tar.gz -C /tmp caddy
  install -m 0755 /tmp/caddy /usr/bin/caddy
  rm -f /tmp/caddy.tar.gz /tmp/caddy
  /usr/bin/caddy version | grep -q "v${CADDY_VERSION}" || die "caddy 二进制替换失败"
  log "caddy 已替换为官方 v${CADDY_VERSION}"
}

install_tunnel() {
  mkdir -p /opt/p2p-net "$PWA_DIR"
  [ -f "$SCRIPT_DIR/tunnel-relay-entry.mjs" ] || die "缺少 $SCRIPT_DIR/tunnel-relay-entry.mjs（需整目录上传后执行）"
  install -m 0644 "$SCRIPT_DIR/tunnel-relay-entry.mjs" /opt/p2p-net/tunnel-relay-entry.mjs
  printf '{"name":"p2p-net-vps","private":true,"type":"module"}\n' > /opt/p2p-net/package.json
  command -v npm >/dev/null 2>&1 || die "npm 不可用（node 安装异常）"
  (cd /opt/p2p-net && npm install --omit=dev --no-fund --no-audit "p2p-net@${P2PNET_VERSION:-latest}")
}

write_configs() {
  # 含密文件经 mktemp（0600）中转 + install -m 落盘，全程无 0644 窗口；
  # turnserver.conf 须被 turnserver 组读（apt unit User=turnserver），不能 0600 root:root
  getent group turnserver >/dev/null || die "turnserver 组不存在（coturn 安装异常）"
  local tmp
  tmp="$(mktemp)"
  render_turnserver_conf > "$tmp"
  install -m 0640 -o root -g turnserver "$tmp" /etc/turnserver.conf
  render_caddyfile > "$tmp"
  install -m 0644 -o root -g root "$tmp" /etc/caddy/Caddyfile
  render_tunnel_service > "$tmp"
  install -m 0600 -o root -g root "$tmp" /etc/systemd/system/p2p-net-tunnel.service
  rm -f "$tmp"
}

enable_services() {
  systemctl daemon-reload
  systemctl enable coturn caddy p2p-net-tunnel
  # 用 restart 而非 enable --now 的 start：重跑时让新配置生效；首跑效果相同
  systemctl restart coturn caddy p2p-net-tunnel
}

main() {
  if [ "${P2PNET_DRYRUN:-0}" = "1" ]; then
    case "${P2PNET_TEST_OS:-ubuntu}" in
      ubuntu | debian) ;;
      *) unsupported_os "${P2PNET_TEST_OS}" ;;
    esac
    detect_ips
    render_all
    exit 0
  fi

  [ "$(id -u)" = "0" ] || die "请以 root 运行本脚本"
  check_os_real
  detect_ips
  install_packages
  install_node
  install_caddy_binary
  install_tunnel
  write_configs
  enable_services
  log "完成：coturn(3478) + caddy(80/443 → https://${PUBLIC_IP}) + p2p-net-tunnel(127.0.0.1:19700)，PWA_DIR=${PWA_DIR}"
}

main "$@"
