// supabase/functions/redeem-pairing-ticket/index.ts
// 扫码登录兑换：pairing_ticket（桌面二维码，120s 一次性）→ Auth 会话材料。
// 安全边界：service_role 只在 Edge Runtime；ticket 是 122bit UUID + 短 TTL + 原子单次消费；
// 返回的 token_hash 同样一次性（verifyOtp 后即失效）。端侧只持有 publishable key。
// 硬约束（2026-09-22 真机实锤）：Management API 内联源码部署通道不解析远程 import
// （jsr:/https:/npm: 一律 BOOT_ERROR 503），故本函数必须零依赖，直接 fetch PostgREST/GoTrue。
// 回归守卫：src/cli/init/functions.test.ts「edge functions 禁止远程 import」。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 浏览器/WebView 跨域调用必须处理 OPTIONS 预检（手机端页面源是 https://tauri.localhost，
// 缺这些头时浏览器在预检阶段就掐掉请求，表现为“无法连接云端”——2026-07-31 真机实锤）
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// PostgREST 与 GoTrue 管理端点共用同一组 service_role 鉴权头
const ADMIN_HEADERS = {
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
  "content-type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  let body: { ticket?: unknown; device_label?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad_json" });
  }
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  if (!UUID_RE.test(ticket)) return json(400, { error: "bad_ticket" });
  const deviceLabel = typeof body.device_label === "string" ? body.device_label.slice(0, 64) : "";

  // 原子消费：只有 pending 且未过期的票能被兑现（条件 UPDATE 自带防双花，空数组即无效票）
  const now = new Date().toISOString();
  const update: Record<string, string> = { status: "redeemed", redeemed_at: now };
  if (deviceLabel) update.device_label = deviceLabel;
  let rows: { user_id: string }[];
  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/pairing_tickets` +
        `?id=eq.${ticket}&status=eq.pending&expires_at=gt.${encodeURIComponent(now)}&select=user_id`,
      {
        method: "PATCH",
        headers: { ...ADMIN_HEADERS, prefer: "return=representation" },
        body: JSON.stringify(update),
      },
    );
    if (!res.ok) return json(500, { error: "db_error", message: await res.text() });
    rows = await res.json();
  } catch (e) {
    return json(500, { error: "db_error", message: String(e) });
  }
  if (!rows || rows.length === 0) return json(410, { error: "ticket_invalid_or_expired" });

  let email: string | undefined;
  try {
    const res = await fetch(`${SUPA_URL}/auth/v1/admin/users/${rows[0].user_id}`, {
      headers: ADMIN_HEADERS,
    });
    if (!res.ok) return json(500, { error: "user_lookup_failed" });
    const user = await res.json();
    email = typeof user?.email === "string" ? user.email : undefined;
  } catch {
    return json(500, { error: "user_lookup_failed" });
  }
  if (!email) return json(500, { error: "user_lookup_failed" });

  // GoTrue generate_link 原始响应的 hashed_token 在顶层；properties 形态兜底（版本差异）
  try {
    const res = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ type: "magiclink", email }),
    });
    const data = await res.json().catch(() => ({}));
    const tokenHash = data?.hashed_token ?? data?.properties?.hashed_token;
    if (!res.ok || !tokenHash) {
      const message = data?.message ?? data?.msg ?? "no hashed_token";
      return json(500, { error: "link_failed", message });
    }
    return json(200, { token_hash: tokenHash, type: "magiclink" });
  } catch (e) {
    return json(500, { error: "link_failed", message: String(e) });
  }
});
