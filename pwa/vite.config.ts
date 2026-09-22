import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    // sw.js 必须以固定文件名落在站点根（其默认最大 scope = 脚本所在目录，
    // 注册 scope /s/<port>/ 时 Chrome 要求 scope ⊆ 脚本目录，除非响应带
    // Service-Worker-Allowed 头；放根目录即可绕开，无需自定义响应头）。
    rollupOptions: {
      input: {
        main: 'index.html',
        sw: 'src/sw.ts',
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
