import { expect, test as base, type Page } from '@playwright/test';

type Snap = {
  camera: { state: string; width: number; height: number };
  paused: boolean;
  model: { state: string; manifest: { purpose: string; name: string; ppeClassMap: Record<string, string> } | null; info: { backend: string; threads: number } | null };
  frame: {
    result: {
      detections: { className: string; score: number }[];
      frameWidth: number;
      frameHeight: number;
      timings: { preprocessMs: number; inferenceMs: number; postprocessMs: number; refineMs?: number };
      crops?: unknown[];
      mainCropSkipped?: number;
    };
    analysis: { subjects: unknown[] };
  } | null;
  latencyMs: number;
  evaluation: { latencies: number[] };
  decisions: Record<string, { status: string; reason?: string; lastScore: number }>;
};

// Toda página é vigiada: qualquer erro de console ou exceção não tratada reprova o teste.
const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(String(e)));
      await use(errors);
      expect(errors, 'erros no console do navegador').toEqual([]);
    },
    { auto: true },
  ],
});

const snapshot = (page: Page) =>
  page.evaluate(() => (window as unknown as { __visionsafe: { getSnapshot(): Snap } }).__visionsafe.getSnapshot()) as Promise<Snap>;

async function hasModel(page: Page) {
  const res = await page.request.get('models/manifest.json');
  return res.ok() && (res.headers()['content-type'] ?? '').includes('json');
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

const NO_MODEL = 'Modelo de IA ainda não configurado — câmera disponível para testes.';

test('layout responsivo: sem rolagem horizontal e alvos de toque grandes', async ({ page }) => {
  for (const route of ['overview', 'live', 'results', 'settings', 'about']) {
    await page.goto(`./?e2e=1#/${route}`);
    await expect(page.locator('main .page')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `rolagem horizontal em ${route}`).toBeLessThanOrEqual(0);
    const small = await page.$$eval('button:not([disabled]), nav a', (els) =>
      els.filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 44).map((e) => e.textContent),
    );
    expect(small, `alvos de toque < 44px em ${route}`).toEqual([]);
    // Nenhum elemento pode ultrapassar a largura do seu cartão.
    const clipped = await page.$$eval('.status-card *, .metric *, .panel *', (els) =>
      els
        .filter((e) => {
          const p = e.closest('.status-card, .metric, .panel')!.getBoundingClientRect();
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > p.right + 1;
        })
        .map((e) => `${e.tagName}.${e.className}`),
    );
    expect(clipped, `conteúdo transbordando em ${route}`).toEqual([]);
  }
});

test('câmera (falsa do Chrome): iniciar, pausar, retomar, parar e liberar', async ({ page }) => {
  await page.goto('./?e2e=1#/live');
  await page.getByRole('button', { name: 'Iniciar câmera' }).click();
  await expect(page.locator('.topbar .cam-indicator')).toHaveText('Câmera ativa');
  await expect(page.getByTestId('stage-chip')).toBeVisible();
  const s = await snapshot(page);
  expect(s.camera.state).toBe('running');
  expect(s.camera.width).toBeGreaterThan(0);

  if (s.model.state === 'ready' || (await hasModel(page))) {
    await expect.poll(async () => (await snapshot(page)).model.state, { timeout: 60_000 }).toBe('ready');
    await page.getByRole('button', { name: 'Pausar' }).click();
    await expect(page.getByTestId('stage-chip')).toHaveText('Pausado');
    expect((await snapshot(page)).camera.state).toBe('running');
    await expect(page.getByTestId('status-hairnet')).toHaveAttribute('data-status', 'CAMERA_UNAVAILABLE');
    await page.getByRole('button', { name: 'Retomar', exact: true }).click();
    await expect(page.getByTestId('stage-chip')).toContainText('Ao vivo');
  }

  await page.getByRole('button', { name: 'Parar' }).click();
  await expect(page.locator('.topbar .cam-indicator')).toHaveText('Câmera desligada');
  const released = await page.evaluate(() => (window as unknown as { __visionsafe: { video: HTMLVideoElement } }).__visionsafe.video.srcObject === null);
  expect(released).toBe(true);
});

test('inferência real no navegador com o modelo instalado', async ({ page }, info) => {
  if (process.env.SETTINGS_JSON) {
    // ex.: SETTINGS_JSON='{"headRefine":false}' — compara configurações no mesmo vídeo.
    const overrides = process.env.SETTINGS_JSON;
    await page.addInitScript((o) => localStorage.setItem('visionsafe.settings.v1', o), overrides);
  }
  await page.goto('./?e2e=1#/live');
  if (!(await hasModel(page))) {
    await expect(page.getByText(NO_MODEL).first()).toBeVisible();
    test.skip(true, 'Nenhum modelo em public/models — veja docs/MODELO_E_DATASET.md');
  }
  await expect.poll(async () => (await snapshot(page)).model.state, { timeout: 60_000 }).toBe('ready');
  await page.getByRole('button', { name: 'Iniciar câmera' }).click();

  // Aguarda quadros reais processados pelo modelo.
  await expect.poll(async () => (await snapshot(page)).frame !== null, { timeout: 60_000 }).toBe(true);
  // MEASURE_MS amplia a janela para medições de latência (padrão 6 s).
  await page.waitForTimeout(Number(process.env.MEASURE_MS ?? 6000));
  const s = await snapshot(page);
  expect(s.latencyMs).toBeGreaterThan(0);
  await expect(page.locator('.metric').filter({ hasText: 'Latência' })).toContainText(/\d+\s*ms/);

  const mapped = new Set(Object.values(s.model.manifest?.ppeClassMap ?? {}));
  for (const cls of ['safety_glasses', 'hearing_protection', 'hairnet']) {
    if (!mapped.has(cls)) expect(s.decisions[cls]).toMatchObject({ status: 'CAMERA_UNAVAILABLE', reason: 'class_unsupported' });
    else expect(s.decisions[cls].reason).not.toBe('class_unsupported');
  }
  if (s.model.manifest?.purpose === 'diagnostic') {
    await expect(page.getByText('Modelo de diagnóstico — não avalia EPIs')).toBeVisible();
  }
  if (process.env.FAKE_VIDEO) {
    // Com um vídeo contendo pessoas, o detector deve encontrar ao menos um sujeito.
    expect(s.frame!.analysis.subjects.length).toBeGreaterThan(0);
  }
  if (process.env.EXPECT_STATUS) {
    // ex.: EXPECT_STATUS="hearing_protection=DETECTED"
    for (const pair of process.env.EXPECT_STATUS.split(',')) {
      const [cls, status] = pair.split('=');
      await expect.poll(async () => (await snapshot(page)).decisions[cls].status, { timeout: 20_000 }).toBe(status);
    }
  }
  const t = s.frame!.result.timings;
  console.log(
    `[${info.project.name}] modelo=${s.model.manifest?.name} backend=${s.model.info?.backend}x${s.model.info?.threads} latência=${s.latencyMs.toFixed(0)}ms ` +
      `(mediana ${median(s.evaluation.latencies).toFixed(0)}ms em ${s.evaluation.latencies.length} quadros; último: pré ${t.preprocessMs.toFixed(0)} + modelo ${t.inferenceMs.toFixed(0)} + ` +
      `recortes ${s.frame!.result.crops?.length ?? 0}/${(t.refineMs ?? 0).toFixed(0)}ms (dispensadas ${s.frame!.result.mainCropSkipped ?? 0}) + pós ${t.postprocessMs.toFixed(0)}ms) ` +
      `quadro=${s.frame!.result.frameWidth}x${s.frame!.result.frameHeight} detecções=` +
      s.frame!.result.detections.map((d) => `${d.className}:${d.score.toFixed(2)}`).join(',') +
      ' decisões=' +
      Object.entries(s.decisions)
        .map(([k, d]) => `${k}:${d.status}${d.reason ? `(${d.reason})` : ''}`)
        .join(','),
  );
  await page.screenshot({ path: `test-results/live-${info.project.name}.png`, fullPage: true });
});

test('diagnóstico com imagem conhecida mostra saída bruta e detecções', async ({ page }, info) => {
  test.skip(!process.env.KNOWN_IMAGE, 'Defina KNOWN_IMAGE=<caminho da imagem> para este teste');
  await page.goto('./?e2e=1#/settings');
  test.skip(!(await hasModel(page)), 'Sem modelo instalado');
  await expect.poll(async () => (await snapshot(page)).model.state, { timeout: 60_000 }).toBe('ready');
  await page.locator('#diag-img').setInputFiles(process.env.KNOWN_IMAGE!);
  const result = page.getByTestId('diagnostic-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('diag-raw')).toContainText('saída bruta');
  const count = Number(await page.getByTestId('diag-count').textContent());
  expect(count).toBeGreaterThan(0);
  console.log(`[${info.project.name}] diagnóstico: ${(await result.innerText()).replace(/\s+/g, ' ')}`);
  await page.getByTestId('diagnostic-panel').screenshot({ path: `test-results/diagnostic-${info.project.name}.png` });
});
