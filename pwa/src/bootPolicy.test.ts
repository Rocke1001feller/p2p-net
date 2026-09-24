import test from 'node:test';
import assert from 'node:assert/strict';
import { bootConnectTarget } from './bootPolicy.js';

// 2026-09-24 真机门禁 F6：boot() 只在 desk.id 存在时自动 startConnect，而 desk.id 只来自
// URL 票据（?t=&d=）。普通重进（无 ?t=）停在设备页等人点卡——已配对用户每次回来都要
// 手动点一次，与「扫码即登录」的产品形态矛盾。裁决：缺陷，修复为无票重进自动重连最近桌面。

test('已登录 + URL 票据 deskId：票据优先（扫码直达原行为不变）', () => {
  assert.equal(bootConnectTarget({ loggedIn: true, ticketDeskId: 'desk-ticket', lastDeskId: 'desk-last' }), 'desk-ticket');
});

test('已登录 + 无票据：自动重连最近桌面（F6 核心）', () => {
  assert.equal(bootConnectTarget({ loggedIn: true, ticketDeskId: '', lastDeskId: 'desk-last' }), 'desk-last');
});

test('已登录 + 无票据 + 无记忆：不自动连（首次使用，停设备页）', () => {
  assert.equal(bootConnectTarget({ loggedIn: true, ticketDeskId: '', lastDeskId: null }), null);
});

test('未登录：一律不自动连（走扫码/票据兑换路由，不在此决策）', () => {
  assert.equal(bootConnectTarget({ loggedIn: false, ticketDeskId: '', lastDeskId: 'desk-last' }), null);
  assert.equal(bootConnectTarget({ loggedIn: false, ticketDeskId: 'desk-ticket', lastDeskId: null }), null);
});
