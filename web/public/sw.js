// Service worker mínimo: permite instalar o app (PWA) e usá-lo sem internet depois da primeira visita
// (runtime WASM, modelos e manifesto ficam no cache). Nenhum dado de câmera passa por aqui.
const CACHE = 'visionsafe-v2';
// O servidor pode mandar "Vary: Origin": scripts de módulo pedem com Origin, a pré-carga não. Ignorar o Vary
// é seguro aqui (mesma origem, arquivos estáticos) e é o que permite abrir o app sem internet.
const MATCH = { ignoreVary: true };

/**
 * Instalação: guarda o app inteiro (lista gerada no build) e os modelos indicados pelo manifesto, para que a
 * segunda abertura funcione sem internet. Falhas aqui não impedem o uso online.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  const list = await fetch('./precache.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : []));
  await cache.addAll(list);
  const mres = await fetch('./models/manifest.json', { cache: 'no-cache' });
  if (!mres.ok) return;
  const text = await mres.text();
  const m = JSON.parse(text);
  await cache.put('./models/manifest.json', new Response(text, { headers: { 'Content-Type': 'application/json' } }));
  const models = [[m.file, m.version], m.cropModel && [m.cropModel.file, m.cropModel.version]].filter(Boolean);
  for (const [file, version] of models) {
    const url = `./models/${file}?v=${encodeURIComponent(version)}`;
    if (await cache.match(url, MATCH)) continue;
    const res = await fetch(url, { cache: 'reload' });
    if (res.ok) await store(new Request(url), res);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => undefined).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Guarda a resposta; para modelos versionados (?v=), remove as versões anteriores do mesmo arquivo. */
async function store(req, res) {
  const cache = await caches.open(CACHE);
  const url = new URL(req.url);
  if (url.pathname.endsWith('.onnx')) {
    for (const old of await cache.keys()) {
      const o = new URL(old.url);
      if (o.pathname === url.pathname && o.search !== url.search) await cache.delete(old);
    }
  }
  await cache.put(req, await buffered(res));
}

/**
 * Lê o corpo inteiro antes de gravar: gravar o fluxo direto falhou com arquivos grandes (.onnx de 10 MB) no
 * Chrome ("Cache.put() encountered a network error"), medido no teste offline.
 */
async function buffered(res) {
  const type = res.headers.get('Content-Type') || 'application/octet-stream';
  return new Response(await res.arrayBuffer(), { status: res.status, headers: { 'Content-Type': type } });
}

function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res.ok) store(req, res.clone());
      return res;
    })
    .catch(() => caches.match(req, MATCH).then((hit) => hit || caches.match('./', MATCH)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const path = new URL(req.url).pathname;
  // manifest.json do modelo: rede primeiro (troca de modelo vale na hora); sem rede, a última cópia.
  if (path.endsWith('/models/manifest.json')) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) store(req, res.clone());
      return res;
    }).catch(() => caches.match(req, MATCH).then((hit) => hit || Response.error())));
    return;
  }

  const heavy = path.includes('/ort/') || path.endsWith('.onnx') || path.endsWith('.wasm') || path.includes('/assets/');
  if (heavy) {
    // Cache-first: arquivos versionados (hash no nome ou ?v=) e pesados.
    event.respondWith(
      caches.match(req, MATCH).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) store(req, res.clone());
            return res;
          }),
      ),
    );
    return;
  }
  // Network-first para páginas e demais arquivos (com fallback offline).
  event.respondWith(networkFirst(req));
});
