import test from 'node:test';
import assert from 'node:assert/strict';
import { setExperimentMode, setProbeDown, setStatus } from './ui.js';

/**
 * ui.ts 的最小 DOM 桩：只覆盖 setStatus 触达的面
 * （connDot/connTitle/connRtt/btnDisconnect + document.createElement('span')）。
 */
class FakeEl {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  children: unknown[] = [];
  private classSet = new Set<string>();
  classList = {
    add: (...cs: string[]) => cs.forEach((c) => this.classSet.add(c)),
    remove: (...cs: string[]) => cs.forEach((c) => this.classSet.delete(c)),
    contains: (c: string) => this.classSet.has(c),
  };
  set innerHTML(v: string) { if (v === '') this.children = []; }
  get innerHTML(): string { return ''; }
  append(...nodes: unknown[]): void { this.children.push(...nodes); }
}

const els = new Map<string, FakeEl>();
function el(id: string): FakeEl {
  let e = els.get(id);
  if (!e) { e = new FakeEl(); els.set(id, e); }
  return e;
}

(globalThis as { document?: unknown }).document = {
  getElementById: (id: string) => el(id),
  createElement: () => new FakeEl(),
};

/** 最近一次 setStatus connected 画出的徽章（connTitle 里 className 含 badge 的 span）。 */
function lastBadge(): FakeEl {
  const badge = el('connTitle').children.find(
    (c): c is FakeEl => c instanceof FakeEl && c.className.includes('badge'),
  );
  assert.ok(badge, 'connected 分支必须画出徽章');
  return badge;
}

test('实验徽章：relay/tunnel 强制模式下徽章带「（实验）」标注', () => {
  setExperimentMode('relay');
  setStatus({ state: 'connected', pairType: 'relay', mode: 'turn' }, '桌面A');
  assert.equal(lastBadge().textContent, '中继（实验）');

  setExperimentMode('tunnel');
  setStatus({ state: 'connected', pairType: null, mode: 'tunnel' }, '桌面A');
  assert.equal(lastBadge().textContent, '隧道（实验）');
});

test('非实验（null）：徽章保持现状（诚实落点，无标注）', () => {
  setExperimentMode(null);
  setStatus({ state: 'connected', pairType: 'relay', mode: 'turn' }, '桌面A');
  assert.equal(lastBadge().textContent, '中继');
  setStatus({ state: 'connected', pairType: null, mode: 'tunnel' }, '桌面A');
  assert.equal(lastBadge().textContent, '隧道');
  setStatus({ state: 'connected', pairType: 'p2p', mode: 'p2p' }, '桌面A');
  assert.equal(lastBadge().textContent, '直连');
});

test('生产链路锁定：setExperimentMode 后经过 connecting 再 connected，实验标注不得被抹掉', () => {
  // 评审 Critical（2026-09-26）：生产时序是 setExperimentMode → setStatus(connecting)（startConnect
  // 顶部刚写入的 lastStatus 全权重绘 + 级联阶段 connecting 帧）→ setStatus(connected)。
  // 复位条件若写成「非 connected 即复位」，实验标注在建连期被两处叠加清零，徽章恒为裸落点。
  setExperimentMode('tunnel');
  setStatus({ state: 'connecting', pairType: null, stage: 'tunnel' }, '桌面A'); // 建连期帧（两处叠加路径的代表）
  setStatus({ state: 'connecting', pairType: null, stage: 'tunnel' }, '桌面A'); // 级联阶段帧再来一拍，确保不是单次侥幸
  setStatus({ state: 'connected', pairType: null, mode: 'tunnel' }, '桌面A');
  assert.equal(lastBadge().textContent, '隧道（实验）', 'connecting 不得复位实验标注（仅 off/failed 可复位）');
  setStatus({ state: 'off', pairType: null }, '桌面A'); // 收尾复位，别污染后续用例
});

test('disconnected 复位实验模式为 null：断开后重连不再带实验标注', () => {
  setExperimentMode('relay');
  setStatus({ state: 'connected', pairType: 'relay', mode: 'turn' }, '桌面A');
  assert.equal(lastBadge().textContent, '中继（实验）');
  setStatus({ state: 'off', pairType: null }, '桌面A'); // 断开 → 复位
  setStatus({ state: 'connected', pairType: 'relay', mode: 'turn' }, '桌面A');
  assert.equal(lastBadge().textContent, '中继', '断开后实验标注必须已复位');
});

test('探活黄灯优先级高于实验徽章（probeDown 覆盖文案不变）', () => {
  setExperimentMode('tunnel');
  setStatus({ state: 'connected', pairType: null, mode: 'tunnel' }, '桌面A');
  setProbeDown(true);
  assert.equal(lastBadge().textContent, '连接待恢复，点我重试');
  setProbeDown(false);
  setStatus({ state: 'off', pairType: null }, '桌面A'); // 收尾复位，别污染后续用例
});
