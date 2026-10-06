import { defineConfig } from 'tsdown'

// host 半边 -> lib/index.mjs（ESM，宿主加载）；client 半边由 scripts/build-client.mjs 单独构建为
// __ModuleLoader__.load 包裹的 CJS bundle -> lib/client.js
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  deps: { neverBundle: ['@deepseek-ai/dsh-llm'] },
  target: 'node20',
  outDir: 'lib',
  clean: true,
})