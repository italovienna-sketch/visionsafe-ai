/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Lista dos arquivos do build (com hash) para o service worker guardar na instalação. Sem ela, o runtime
 * do ONNX importado dentro do Web Worker só entraria no cache por acaso, e o app não abriria offline.
 */
function precacheList(): Plugin {
  return {
    name: 'visionsafe-precache',
    apply: 'build',
    generateBundle(_, bundle) {
      // O runtime WebGPU (asyncify, ~25 MB) só é usado se o usuário escolher WebGPU: fica fora da pré-carga.
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !/asyncify|webgpu/.test(f));
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify(['./', ...files]) });
    },
    writeBundle(options, bundle) {
      // Nome do cache muda a cada build: o navegador reinstala o service worker e descarta arquivos antigos.
      const sw = join(options.dir!, 'sw.js');
      const hash = createHash('sha256').update(Object.keys(bundle).sort().join()).digest('hex').slice(0, 10);
      writeFileSync(sw, readFileSync(sw, 'utf8').replace("'visionsafe-v2'", `'visionsafe-${hash}'`));
    },
  };
}

// COOP/COEP habilitam crossOriginIsolated -> SharedArrayBuffer -> WASM multithread no ONNX Runtime.
// Sem eles a inferência continua funcionando, porém em uma única thread.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), precacheList(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: { headers: isolationHeaders, port: 5173 },
  preview: { headers: isolationHeaders, port: 4173 },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
