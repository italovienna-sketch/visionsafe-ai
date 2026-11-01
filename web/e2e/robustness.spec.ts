import { expect, test as base, type Page } from '@playwright/test';

// Privacidade (nenhuma imagem sai do aparelho), falhas de inicialização, desconexão da câmera e uso offline.

type Snap = {
  camera: { state: string };
  model: { state: string; errorCode: string | null };
  frame: unknown;
  decisions: Record<string, { status: string; reason?: string }>;
};
const snapshot = (page: Page) =>
  page.evaluate(() => (window as unknown as { __visionsafe: { getSnapshot(): Snap } }).__visionsafe.getSnapshot()) as Promise<Snap>;

const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(String(e)));
      await use(errors);
    },
    { auto: true },
  ],
});

async function hasModel(page: Page) {
  const res = await page.request.get('models/manifest.json');
  return res.ok() && (res.headers()['content-type'] ?? '').includes('json');
}

test('durante a análise nenhuma requisição de rede é feita (imagens não saem do aparelho)', async ({ page, consoleErrors }, info) => {
  const all: { url: string; method: string; phase: string }[] = [];
  let phase = 'carga';
  page.on('request', (r) => all.push({ url: r.url(), method: r.method(), phase }));
  await page.goto('./?e2e=1#/live');
  test.skip(!(await hasModel(page)), 'Sem modelo instalado');
  await expect.poll(async () => (await snapshot(page)).model.state, { timeout: 60_000 }).toBe('ready');
  await page.getByRole('button', { name: 'Iniciar câmera' }).click();
  await expect.poll(async () => (await snapshot(page)).frame !== null, { timeout: 60_000 }).toBe(true);
  phase = 'inferência';
  await page.waitForTimeout(8000);

  const origin = new URL(page.url()).origin;
  const external = all.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  const during = all.filter((r) => r.phase === 'inferência');
  console.log(
    `[${info.project.name}] requisições na carga: ${all.length - during.length} (todas do mesmo domínio: ${external.length === 0}); ` +
      `durante 8 s de análise: ${during.length}`,
  );
  expect(external, 'requisições para outros domínios').toEqual([]);
  expect(during, 'requisições durante a análise').toEqual([]);
  expect(all.filter((r) => r.method !== 'GET'), 'envios (POST/PUT)').toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('falha na inicialização do modelo aparece como erro, sem estado falso', async ({ page }) => {
  await page.route('**/models/manifest.json', (r) => r.fulfill({ status: 500, body: 'erro' }));
  await page.goto('./?e2e=1#/live');
  await expect(page.getByText('Falha ao carregar o modelo').first()).toBeVisible();
  for (const cls of ['safety_glasses', 'hearing_protection', 'hairnet']) {
    await expect(page.getByTestId(`status-${cls}`)).toHaveAttribute('data-status', 'CAMERA_UNAVAILABLE');
  }
});

test('arquivo .onnx corrompido: erro claro e nenhuma decisão de EPI', async ({ page }) => {
  await page.goto('./?e2e=1#/live');
  test.skip(!(await hasModel(page)), 'Sem modelo instalado');
  await page.route('**/*.onnx*', (r) => r.fulfill({ status: 200, body: Buffer.from('nao e um modelo onnx'), contentType: 'application/octet-stream' }));
  await page.reload();
  await expect.poll(async () => (await snapshot(page)).model.state, { timeout: 60_000 }).toBe('error');
  await expect(page.getByText('Falha ao carregar o modelo').first()).toBeVisible();
  expect((await snapshot(page)).decisions.hairnet.status).toBe('CAMERA_UNAVAILABLE');
});

test('desconexão da câmera durante o uso: aviso e EPIs "Não avaliável"', async ({ page }) => {
  await page.goto('./?e2e=1#/live');
  await page.getByRole('button', { name: 'Iniciar câmera' }).click();
  await expect.poll(async () => (await snapshot(page)).camera.state).toBe('running');
  await page.evaluate(() => {
    const v = (window as unknown as { __visionsafe: { video: HTMLVideoElement } }).__visionsafe.video;
    const track = (v.srcObject as MediaStream).getVideoTracks()[0];
    track.stop();
    track.dispatchEvent(new Event('ended')); // stop() não dispara "ended"; o navegador dispara ao desconectar
  });
  await expect.poll(async () => (await snapshot(page)).camera.state).toBe('error');
  await expect(page.getByText('Não foi possível abrir a câmera').or(page.getByText('A câmera está em uso por outro aplicativo')).first()).toBeVisible();
  const s = await snapshot(page);
  for (const cls of ['safety_glasses', 'hearing_protection', 'hairnet']) expect(s.decisions[cls].status).toBe('CAMERA_UNAVAILABLE');
});

test('funciona sem internet depois da primeira visita (servidor desligado)', async ({ browser }, info) => {
  test.skip(!process.env.OFFLINE_TEST, 'Defina OFFLINE_TEST=1 depois de npm run build (usa o build de produção em dist/)');
  test.setTimeout(240_000);
  // Servidor próprio, desligado de verdade no meio do teste (a emulação offline do DevTools não passa pelo
  // service worker nas importações feitas dentro do Web Worker, e não representa a situação real).
  const { preview } = await import('vite');
  const port = 4180;
  const server = await preview({ preview: { port, strictPort: true }, logLevel: 'silent' });
  const context = await browser.newContext({ ...info.project.use, permissions: ['camera'] });
  const page = await context.newPage();
  const base = `http://localhost:${port}/?e2e=1#/live`;
  try {
    await page.goto(base);
    test.skip(!(await hasModel(page)), 'Sem modelo instalado');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(async () => (await snapshot(page)).model.state, { timeout: 60_000 }).toBe('ready');

    await server.close();
    const down = await page.request.get(`http://localhost:${port}/`).then(() => false, () => true);
    expect(down, 'servidor deveria estar fora do ar').toBe(true);

    await page.reload();
    await expect.poll(async () => (await snapshot(page)).model.state, { timeout: 60_000 }).toBe('ready');
    await page.getByRole('button', { name: 'Iniciar câmera' }).click();
    await expect.poll(async () => (await snapshot(page)).frame !== null, { timeout: 60_000 }).toBe(true);
    console.log(`[${info.project.name}] offline: modelo carregado do cache e quadros analisados com o servidor desligado`);
  } finally {
    await context.close();
    await server.close().catch(() => undefined);
  }
});

test('operação prolongada: memória e latência estáveis (SOAK_MS)', async ({ page }, info) => {
  const total = Number(process.env.SOAK_MS ?? 0);
  test.skip(!total, 'Defina SOAK_MS (ex.: 600000 = 10 min)');
  test.setTimeout(total + 180_000);
  await page.goto('./?e2e=1#/live');
  test.skip(!(await hasModel(page)), 'Sem modelo instalado');
  await expect.poll(async () => (await snapshot(page)).model.state, { timeout: 60_000 }).toBe('ready');
  await page.getByRole('button', { name: 'Iniciar câmera' }).click();
  await expect.poll(async () => (await snapshot(page)).frame !== null, { timeout: 60_000 }).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heapMb = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1e6;
  };
  const sample = async () => {
    const s = (await page.evaluate(() =>
      (window as unknown as { __visionsafe: { getSnapshot(): { evaluation: { latencies: number[] }; camera: { state: string } } } }).__visionsafe.getSnapshot(),
    )) as { evaluation: { latencies: number[] }; camera: { state: string } };
    const l = s.evaluation.latencies.slice(-20).sort((a, b) => a - b);
    return { heap: await heapMb(), median: l[Math.floor(l.length / 2)] ?? NaN, frames: s.evaluation.latencies.length, camera: s.camera.state };
  };
  const rows: { t: number; heap: number; median: number; frames: number }[] = [];
  const step = Math.min(30_000, total / 4);
  for (let t = 0; t <= total; t += step) {
    if (t) await page.waitForTimeout(step);
    const s = await sample();
    expect(s.camera).toBe('running');
    rows.push({ t: t / 1000, heap: Math.round(s.heap), median: Math.round(s.median), frames: s.frames });
  }
  console.log(`[${info.project.name}] prolongado: ` + rows.map((r) => `${r.t}s heap ${r.heap}MB lat ${r.median}ms`).join(' | '));
  // Heap do JS (página) não pode crescer sem limite; o worker tem heap próprio e é medido pela latência estável.
  expect(rows.at(-1)!.heap).toBeLessThan(rows[0].heap * 2 + 20);
  expect(rows.at(-1)!.median).toBeLessThan(rows[1]?.median * 2 || Infinity);
});
