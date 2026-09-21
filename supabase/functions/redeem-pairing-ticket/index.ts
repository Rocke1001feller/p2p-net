// supabase/functions/redeem-pairing-ticket/index.ts
// 扫码登录兑换：pairing_ticket（桌面二维码，120s 一次性）→ Auth 会话材料。
// 安全边界：service_role 只在 Edge Runtime；ticket 是 122bit UUID + 短 TTL + 原子单次消费；
// 返回的 token_hash 同样一次性（verifyOtp 后即失效）。端侧只持有 publishable key。
import { createClient } from "jsr:@supabase/supabase-js@2";

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

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // 原子消费：只有 pending 且未过期的票能被兑现（条件更新自带防双花）
  const update: Record<string, string> = {
    status: "redeemed",
    redeemed_at: new Date().toISOString(),
  };
  if (deviceLabel) update.device_label = deviceLabel;
  const { data: rows, error } = await admin
    .from("pairing_tickets")
    .update(update)
    .eq("id", ticket)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("user_id");
  if (error) return json(500, { error: "db_error", message: error.message });
  if (!rows || rows.length === 0) return json(410, { error: "ticket_invalid_or_expired" });

  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(rows[0].user_id);
  if (userErr || !userData.user?.email) return json(500, { error: "user_lookup_failed" });

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: userData.user.email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    return json(500, { error: "link_failed", message: linkErr?.message ?? "no hashed_token" });
  }

  return json(200, { token_hash: tokenHash, type: "magiclink" });
});
