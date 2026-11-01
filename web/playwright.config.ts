import { defineConfig, devices } from '@playwright/test';

/**
 * Testes E2E no Chrome real com câmera falsa.
 * - FAKE_VIDEO=<arquivo.y4m> usa um vídeo/imagem como câmera (ver e2e/make_fake_video.py);
 *   sem ele, o Chrome gera um padrão sintético (sem pessoas).
 * - PW_CHANNEL=chromium usa o Chromium do Playwright em vez do Chrome instalado.
 * - PW_TRACE=retain-on-failure grava o trace (deixa a inferência mais lenta durante o teste).
 */
const fakeVideo = process.env.FAKE_VIDEO;
const mediaArgs = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  ...(fakeVideo ? [`--use-file-for-fake-video-capture=${fakeVideo}`] : []),
];

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173/',
    channel: process.env.PW_CHANNEL ?? 'chrome',
    // O trace grava a tela continuamente e rouba CPU do modelo (latência medida 3–4× maior).
    // Ative só para depurar falhas: PW_TRACE=retain-on-failure.
    trace: (process.env.PW_TRACE as 'off' | 'on' | 'retain-on-failure' | undefined) ?? 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'android-chrome',
      use: { ...devices['Pixel 7'], channel: process.env.PW_CHANNEL ?? 'chrome', permissions: ['camera'], launchOptions: { args: mediaArgs } },
    },
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL ?? 'chrome', permissions: ['camera'], launchOptions: { args: mediaArgs } },
    },
  ],
  ...(process.env.BASE_URL
    ? {}
    : {
        webServer: {
          command: 'npx vite --port 5173 --strictPort',
          url: 'http://localhost:5173/',
          reuseExistingServer: true,
          timeout: 60_000,
        },
      }),
});
