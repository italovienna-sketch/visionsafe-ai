import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// Benchmark do ONNX Runtime Web no Chrome real (backend WASM do app). Execute com:
//   BENCH=1 BENCH_MODELS=models/bench/a.onnx,models/bench/b.onnx BENCH_THREADS=4 npx playwright test wasm-bench --project=desktop-chrome
// A thread number deve ser repetida por execução: o ONNX Runtime fixa numThreads na primeira sessão.
test('latência WASM por modelo', async ({ page }, info) => {
  test.skip(!process.env.BENCH, 'Defina BENCH=1');
  test.setTimeout(600_000);
  const models = (process.env.BENCH_MODELS ?? 'models/best.onnx,models/ppe4_crop.onnx').split(',');
  const threads = Number(process.env.BENCH_THREADS ?? 4);
  const runs = Number(process.env.BENCH_RUNS ?? 20);
  await page.goto('./e2e/bench/bench.html');
  await expect(page.locator('#out')).toHaveText('pronto');
  const res = await page.evaluate(
    ([m, t, r]) => (window as unknown as { runBench: (a: string[], b: number, c: number) => Promise<unknown> }).runBench(m as string[], t as number, r as number),
    [models.map((m) => new URL(m, page.url().replace(/e2e\/bench\/.*/, '')).href), threads, runs] as const,
  );
  console.log(JSON.stringify(res));
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify({ project: info.project.name, threads, ...(res as object) }, null, 2));
});
