/**
 * 端口契约的浏览器安全视图：值唯一事实源是 contracts/ports.json，本模块经
 * JSON import attributes 直读它（tsc emit 保留 import 语句、类型内联进 .d.ts；
 * vite/tsx 原生消化；Node 运行时按相对路径加载包内 shipped 的 contracts/）。
 *
 * 为什么不复用 ./contracts.js：它 readFileSync(node:fs)，进不了浏览器 bundle。
 * 为什么 Node 侧（contracts.ts）不反过来复用本模块：import attributes 语法要求
 * Node >=20.10，而包 engines 声明 >=20——CLI 路径必须兼容到 20.0，故 Node 侧
 * 维持 readFileSync 读同一个文件。两侧读的是同一物理文件，无双份事实。
 *
 * parity 门禁：src/contracts.test.ts（Node 侧 PORTS === ports.json）与
 * pwa/src/constants.test.ts（PWA 侧导出 === ports.json）。
 */
import ports from '../contracts/ports.json' with { type: 'json' };

export type PortContract = typeof ports;

export const PORTS: PortContract = ports;
