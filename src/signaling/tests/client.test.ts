import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalingClient, type FetchLike } from '../client.js';
import type { SigMessage } from '../protocol.js';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

type Handler = (url: string, init: RequestInit) => Response;

function stubFetch(handler: Handler): { restore: () => void } {
  const original = globalThis.fetch;
  const fake: FetchLike = async (url: any, init: any = {}) => handler(String(url), init);
  (globalThis as any).fetch = fake;
  return { restore: () => { (globalThis as any).fetch = original; } };
}

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const MSG: SigMessage = { type: 'offer', sid: 'sid-1' };

test('send 请求细节：body 含 room/sender/kind/payload/expires_at', async () => {
  let captured: RecordedCall | null = null;
  const { restore } = stubFetch((url, init) => {
    captured = { url, init };
    return new Response(null, { status: 201 });
  });
  try {
    const c = new SignalingClient({
      supabaseUrl: 'https://sb.example.com',
      accessToken: () => 'tok-1',
      publishableKey: 'pk-1',
    });
    await c.send('sig:u:d1', 'dev-2', MSG);
    assert.ok(captured);
    const { url, init } = captured as unknown as RecordedCall;
    assert.equal(url, 'https://sb.example.com/rest/v1/signaling_messages');
    assert.equal(init.method, 'POST');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['apikey'], 'pk-1');
    assert.equal(headers['authorization'], 'Bearer tok-1');
    assert.equal(headers['prefer'], 'return=minimal');
    const body = JSON.parse(String(init.body));
    assert.equal(body.room, 'sig:u:d1');
    assert.equal(body.sender, 'dev-2');
    assert.equal(body.kind, 'sig');
    assert.deepEqual(body.payload, MSG);
    assert.ok(!Number.isNaN(Date.parse(body.expires_at)));
  } finally {
    restore();
  }
});

test('send 可覆盖 kind 与 ttl', async () => {
  let captured: RecordedCall | null = null;
  const { restore } = stubFetch((_url, init) => {
    captured = { url: '', init };
    return new Response(null, { status: 201 });
  });
  try {
    const c = new SignalingClient({ supabaseUrl: 'https://sb.example.com', accessToken: () => null, publishableKey: 'pk' });
    await c.send('r', 's', MSG, 'data', 30);
    const body = JSON.parse(String((captured as unknown as RecordedCall).init.body));
    assert.equal(body.kind, 'data');
    const ttlMs = Date.parse(body.expires_at) - Date.now();
    assert.ok(ttlMs > 29_000 && ttlMs <= 30_500, `ttl 应约 30s，实际 ${ttlMs}ms`);
    const headers = (captured as unknown as RecordedCall).init.headers as Record<string, string>;
    assert.equal(headers['authorization'], undefined);
  } finally {
    restore();
  }
});

test('send 非 2xx 抛错且含状态码', async () => {
  const { restore } = stubFetch(() => new Response('{"message":"JWT expired"}', { status: 401 }));
  try {
    const c = new SignalingClient({ supabaseUrl: 'https://sb.example.com', accessToken: () => 'bad', publishableKey: 'pk' });
    await assert.rejects(c.send('r', 's', MSG), /401/);
  } finally {
    restore();
  }
});

test('poll 的 URL 含 id=gt.cursor 与 order=id.asc，cursor 前进', async () => {
  let captured: RecordedCall | null = null;
  const { restore } = stubFetch((url, init) => {
    captured = { url, init };
    return okJson([
      { id: 11, sender: 'dev-2', payload: MSG },
      { id: 12, sender: 'dev-2', payload: { type: 'ice', sid: 'sid-1' } },
    ]);
  });
  try {
    const c = new SignalingClient({ supabaseUrl: 'https://sb.example.com', accessToken: () => 'tok', publishableKey: 'pk' });
    const { msgs, cursor } = await c.poll('sig:u:d1', 10);
    const { url } = captured as unknown as RecordedCall;
    const q = new URL(url).searchParams;
    assert.equal(q.get('room'), 'eq.sig:u:d1');
    assert.ok((q.get('expires_at') ?? '').length > 0, 'poll 必须带 expires_at 过滤（防僵尸会话重放）');
    assert.equal(q.get('id'), 'gt.10');
    assert.equal(q.get('order'), 'id.asc');
    assert.equal(q.get('select'), 'id,sender,payload');
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], { id: 11, sender: 'dev-2', payload: MSG });
    assert.equal(cursor, 12);
  } finally {
    restore();
  }
});

test('poll 空结果 cursor 不回退', async () => {
  const { restore } = stubFetch(() => okJson([]));
  try {
    const c = new SignalingClient({ supabaseUrl: 'https://sb.example.com', accessToken: () => 'tok', publishableKey: 'pk' });
    const { msgs, cursor } = await c.poll('sig:u:d1', 42);
    assert.equal(msgs.length, 0);
    assert.equal(cursor, 42);
  } finally {
    restore();
  }
});

test('poll 非 2xx 抛错且含状态码', async () => {
  const { restore } = stubFetch(() => new Response('forbidden', { status: 403 }));
  try {
    const c = new SignalingClient({ supabaseUrl: 'https://sb.example.com', accessToken: () => 'tok', publishableKey: 'pk' });
    await assert.rejects(c.poll('sig:u:d1', 0), /403/);
  } finally {
    restore();
  }
});

test('purgeExpired 发 DELETE 且过滤过期行；失败静默', async () => {
  let captured: RecordedCall | null = null;
  const { restore } = stubFetch((url, init) => {
    captured = { url, init };
    return new Response(null, { status: 204 });
  });
  try {
    const c = new SignalingClient({ supabaseUrl: 'https://sb.example.com', accessToken: () => 'tok', publishableKey: 'pk' });
    await c.purgeExpired('sig:u:d1');
    const { url, init } = captured as unknown as RecordedCall;
    assert.equal(url.startsWith('https://sb.example.com/rest/v1/signaling_messages?'), true);
    assert.equal(init.method, 'DELETE');
    const q = new URL(url).searchParams;
    assert.equal(q.get('room'), 'eq.sig:u:d1');
    assert.ok((q.get('expires_at') ?? '').length > 0, 'poll 必须带 expires_at 过滤（防僵尸会话重放）');
    assert.ok((q.get('expires_at') || '').startsWith('lt.'));
  } finally {
    restore();
  }
  // 失败静默：fetch reject 不冒泡
  const original = globalThis.fetch;
  (globalThis as any).fetch = async () => { throw new Error('network down'); };
  try {
    const c = new SignalingClient({ supabaseUrl: 'https://sb.example.com', accessToken: () => 'tok', publishableKey: 'pk' });
    await c.purgeExpired('sig:u:d1');
  } finally {
    (globalThis as any).fetch = original;
  }
});
