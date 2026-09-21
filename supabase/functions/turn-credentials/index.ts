// turn-credentials — TURN REST API 临时凭据（coturn use-auth-secret 语义）
// 契约：POST /functions/v1/turn-credentials（要登录态 JWT）
//   200 {iceServers:[stun,turn-udp,turn-tcp]×每个host, username, credential, ttlSeconds}
//   401 not_authenticated / 405 method_not_allowed / 500 secret_missing / 500 TURN_HOSTS not configured
// 凭据算法：username = `<unix到期>:<uid前8位>`，credential = base64(HMAC-SHA1(secret, username))
// 密钥来源：`supabase secrets set TURN_STATIC_AUTH_SECRET`（与各 TURN 服务器 /etc/turnserver.conf 的 static-auth-secret 同值）
// host 列表来源：`supabase secrets set TURN_HOSTS`（JSON 数组，如 ["1.2.3.4","5.6.7.8"]）
import { createHmac } from "node:crypto";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // 直连 /auth/v1/user 校验调用方 JWT（不引 supabase-js，少一层行为面）
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "not_authenticated" });
  const uRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { authorization: auth, apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! },
  });
  if (!uRes.ok) return json(401, { error: "not_authenticated" });
  const { id: uid } = await uRes.json();
  if (!uid) return json(401, { error: "not_authenticated" });

  const secret = Deno.env.get("TURN_STATIC_AUTH_SECRET");
  if (!secret) return json(500, { error: "secret_missing" });

  const hosts: string[] = JSON.parse(Deno.env.get('TURN_HOSTS') ?? '[]');
  if (hosts.length === 0) return new Response('TURN_HOSTS not configured', { status: 500 });

  const ttl = 3600 * 6;
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${uid.slice(0, 8)}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  const iceServers = hosts.flatMap((h) => [
    { urls: [`stun:${h}:3478`] },
    { urls: [`turn:${h}:3478?transport=udp`, `turn:${h}:3478?transport=tcp`], username, credential },
  ]);
  return json(200, {
    iceServers,
    username,
    credential,
    ttlSeconds: ttl,
  });
});
