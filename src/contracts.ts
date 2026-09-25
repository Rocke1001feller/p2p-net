import { readFileSync } from 'node:fs';
import type { PortContract } from './ports.js';

// Node 侧端口契约读取（浏览器侧走 ./ports.js 的 JSON import——readFileSync 进不了
// 浏览器 bundle；本路径不碰 import attributes 以兼容 engines 声明的 Node 20.0）。
export const PORTS = JSON.parse(
  readFileSync(new URL('../contracts/ports.json', import.meta.url), 'utf8'),
) as PortContract;
