/** qrcode-terminal 无官方类型包，此为最小声明（Task 17 配对 QR 打印消费）。
 *  运行时为 CJS（module.exports = {...}），NodeNext ESM 的 default 导入互操作恰好命中 module.exports。
 */
declare module 'qrcode-terminal' {
  interface QrGenerateOptions {
    small?: boolean;
  }
  interface QrCodeTerminal {
    generate(text: string, opts?: QrGenerateOptions, cb?: (qr: string) => void): void;
    setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void;
  }
  const qrcode: QrCodeTerminal;
  export default qrcode;
}
