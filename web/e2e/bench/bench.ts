// Mede a latência de modelos ONNX no ONNX Runtime Web (WASM) do próprio navegador — o mesmo backend do app.
// Usado só por e2e/wasm-bench.spec.ts (BENCH=1); não faz parte do build de produção.
import * as ort from 'onnxruntime-web/wasm';

interface Row { model: string; threads: number; medianMs: number; p95Ms: number; runs: number }

async function bench(url: string, threads: number, runs: number): Promise<Row> {
  ort.env.wasm.numThreads = threads;
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const s = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const size = Number((s.inputMetadata[0] as unknown as { shape: readonly number[] }).shape[2]);
  const data = new Float32Array(3 * size * size).map(() => Math.random());
  const feed = { [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, size, size]) };
  for (let i = 0; i < 3; i++) await s.run(feed);
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await s.run(feed);
    t.push(performance.now() - t0);
  }
  await s.release();
  t.sort((a, b) => a - b);
  return { model: url.split('/').pop()!, threads, medianMs: t[Math.floor(t.length / 2)], p95Ms: t[Math.floor(t.length * 0.95)], runs };
}

(window as unknown as { runBench: unknown }).runBench = async (urls: string[], threads: number, runs: number) => {
  const rows: Row[] = [];
  for (const u of urls) rows.push(await bench(u, threads, runs));
  return { crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent, rows };
};
document.getElementById('out')!.textContent = 'pronto';
