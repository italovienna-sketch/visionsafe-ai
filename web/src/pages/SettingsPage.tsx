import { useRef, useState, type ReactNode } from 'react';
import { Notice } from '../components/Common';
import { DiagnosticPanel } from '../components/DiagnosticPanel';
import { PPE_INFO } from '../core/ppe';
import { ANALYSIS_MODES, currentMode, DEFAULT_SETTINGS, type AnalysisMode, type Settings } from '../core/settings';
import { PPE_CLASSES } from '../core/types';
import { useController, useMonitor } from '../controller/context';

function Slider(props: { id: string; label: string; value: number; min: number; max: number; step: number; format?: (v: number) => string; onChange: (v: number) => void; help?: ReactNode }) {
  const { id, label, value, min, max, step, format = String, onChange, help } = props;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <output className="mono">{format(value)}</output>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {help && <p className="help">{help}</p>}
    </div>
  );
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field field-row">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

const p100 = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;

export function SettingsPage() {
  const c = useController();
  const snap = useMonitor();
  const s = snap.settings;
  const set = (patch: Partial<Settings>) => c.updateSettings(patch);
  const mode = currentMode(s);
  const rec = snap.model.manifest?.thresholds;
  const onnxRef = useRef<HTMLInputElement>(null);
  const manRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const loadFiles = () => {
    const onnx = onnxRef.current?.files?.[0];
    const man = manRef.current?.files?.[0];
    if (!onnx || !man) {
      setFileError('Selecione o arquivo .onnx e o manifest.json correspondente.');
      return;
    }
    setFileError(null);
    void c.loadLocalModel(onnx, man);
  };

  return (
    <div className="page">
      <h1>Ajustes</h1>

      <section className="card">
        <h2>Modo de análise</h2>
        <div className="segmented" role="radiogroup" aria-label="Modo de análise">
          {(Object.keys(ANALYSIS_MODES) as AnalysisMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? 'active' : undefined}
              onClick={() => set(ANALYSIS_MODES[m].patch)}
            >
              {ANALYSIS_MODES[m].label}
            </button>
          ))}
        </div>
        <p className="muted small" data-testid="mode-description">
          {mode ? ANALYSIS_MODES[mode].description : 'Personalizado: os ajustes de refinamento ou de intervalo foram alterados manualmente.'}
        </p>
      </section>

      <section className="card">
        <h2>Limiares de confiança por classe</h2>
        <p className="small muted">
          Acima do limiar a observação conta como “presente”. Entre o piso e o limiar ela é <em>ambígua</em> e nunca conta
          como ausência.
        </p>
        {rec && (
          <>
            <Toggle id="model-th" label="Usar limiares recomendados pelo modelo" checked={s.useModelThresholds} onChange={(v) => set({ useModelThresholds: v })} />
            <p className="muted small">
              Escolhidos na validação do treino:{' '}
              {PPE_CLASSES.filter((c) => rec[c] !== undefined).map((c) => `${PPE_INFO[c].short} ${p100(rec[c]!)}`).join(' · ')}. Desligue para
              ajustar manualmente.
            </p>
          </>
        )}
        {PPE_CLASSES.map((cls) => (
          <div key={cls} className="subfield">
            <h3>{PPE_INFO[cls].label}</h3>
            {s.useModelThresholds && rec?.[cls] !== undefined ? (
              <p className="small" data-testid={`model-th-${cls}`}>
                Limiar do modelo: <strong className="mono">{p100(rec[cls]!)}</strong>
              </p>
            ) : (
              <Slider
                id={`th-${cls}`}
                label="Limiar"
                value={s.classes[cls].threshold}
                min={0.1}
                max={0.95}
                step={0.05}
                format={p100}
                onChange={(v) => set({ classes: { ...s.classes, [cls]: { ...s.classes[cls], threshold: v } } })}
              />
            )}
            <Slider
              id={`fl-${cls}`}
              label="Piso de ambiguidade"
              value={s.classes[cls].ambiguousFloor}
              min={0.05}
              max={s.classes[cls].threshold}
              step={0.05}
              format={p100}
              onChange={(v) => set({ classes: { ...s.classes, [cls]: { ...s.classes[cls], ambiguousFloor: v } } })}
            />
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Detector</h2>
        <Slider
          id="floor"
          label="Escore mínimo do detector"
          value={s.detectorScoreFloor}
          min={0.05}
          max={0.5}
          step={0.05}
          format={p100}
          onChange={(v) => set({ detectorScoreFloor: v })}
          help="Caixas abaixo deste escore são descartadas antes de tudo. Deve ficar abaixo do piso de ambiguidade das classes."
        />
        <Slider
          id="nms"
          label="Sobreposição para fusão (NMS IoU)"
          value={s.nmsIou}
          min={0.2}
          max={0.9}
          step={0.05}
          format={p100}
          onChange={(v) => set({ nmsIou: v })}
          help="Caixas da mesma classe com sobreposição acima deste valor são consideradas o mesmo objeto."
        />
        {snap.model.manifest?.proxyClasses && Object.keys(snap.model.manifest.proxyClasses).length > 0 && (
          <div className="subfield">
            <h3>Classes aproximadas do modelo atual</h3>
            {PPE_CLASSES.filter((cls) => snap.model.manifest?.proxyClasses?.[cls]).map((cls) => (
              <div key={cls}>
                <Toggle
                  id={`proxy-${cls}`}
                  label={`Usar ${PPE_INFO[cls].label.toLowerCase()} (aproximado)`}
                  checked={s.allowProxy[cls]}
                  onChange={(v) => set({ allowProxy: { ...s.allowProxy, [cls]: v } })}
                />
                <p className="help">{snap.model.manifest!.proxyClasses![cls]}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Verificação</h2>
        <Slider id="win" label="Janela de verificação" value={s.windowMs} min={2000} max={30000} step={500} format={sec} onChange={(v) => set({ windowMs: v })} help="“Não confirmado” só é declarado após observar a pessoa durante toda a janela." />
        <Slider id="minobs" label="Observações válidas mínimas" value={s.minObservations} min={2} max={60} step={1} onChange={(v) => set({ minObservations: v })} />
        <Slider id="minpos" label="Positivas mínimas para “Detectado”" value={s.minPositive} min={1} max={20} step={1} onChange={(v) => set({ minPositive: v })} />
        <Slider id="absent" label="Proporção mínima de ausências" value={s.absentRatio} min={0.5} max={1} step={0.05} format={p100} onChange={(v) => set({ absentRatio: v })} />
        <Slider id="ambig" label="Máximo de observações ambíguas" value={s.maxAmbiguousRatio} min={0} max={0.8} step={0.05} format={p100} onChange={(v) => set({ maxAmbiguousRatio: v })} />
        <Toggle id="countdown" label="Mostrar contagem regressiva" checked={s.showCountdown} onChange={(v) => set({ showCountdown: v })} />
      </section>

      <section className="card">
        <h2>Qualidade de imagem (estado “Não avaliável”)</h2>
        <Slider id="minh" label="Altura mínima do rosto/cabeça" value={s.minSubjectPx} min={0} max={200} step={4} format={(v) => `${v} px`} onChange={(v) => set({ minSubjectPx: v })} help="Em pixels da câmera. Abaixo disso a pessoa fica “Não avaliável — distante”: há poucos pixels para ver o EPI." />
        <Slider id="sharp" label="Nitidez mínima" value={s.minSharpness} min={0} max={300} step={5} onChange={(v) => set({ minSharpness: v })} help="Variância do Laplaciano no recorte. Ative o diagnóstico para ver o valor medido e calibrar." />
        <Slider id="minb" label="Brilho mínimo" value={s.minBrightness} min={0} max={120} step={5} onChange={(v) => set({ minBrightness: v })} />
        <Slider id="maxb" label="Brilho máximo" value={s.maxBrightness} min={150} max={255} step={5} onChange={(v) => set({ maxBrightness: v })} />
        <Slider id="subj" label="Confiança mínima da pessoa/cabeça" value={s.subjectThreshold} min={0.1} max={0.9} step={0.05} format={p100} onChange={(v) => set({ subjectThreshold: v })} />
        <Toggle id="refine" label="Refinar na região da cabeça (2ª passada)" checked={s.headRefine} onChange={(v) => set({ headRefine: v })} />
        <p className="muted small">
          Analisa de novo a região da cabeça na resolução nativa da câmera, sem a redução do quadro inteiro para a entrada do modelo.
          Melhora a detecção de EPIs pequenos/distantes; custa uma inferência extra por pessoa.
        </p>
        {s.headRefine && (
          <Slider id="crops" label="Pessoas refinadas por quadro" value={s.refineMaxCrops} min={1} max={4} step={1} onChange={(v) => set({ refineMaxCrops: v })} />
        )}
        <Toggle id="adaptive" label="Pular passada redundante no recorte" checked={s.adaptiveRefine} onChange={(v) => set({ adaptiveRefine: v })} />
        <p className="muted small">
          Quando os óculos já foram confirmados no quadro inteiro para aquela pessoa, não roda de novo o detector genérico
          no recorte: a decisão é a mesma e a análise fica mais rápida.
        </p>
      </section>

      <section className="card">
        <h2>Câmera e desempenho</h2>
        <dl className="kv" style={{ marginBottom: '12px' }}>
          <dt>Status da câmera</dt>
          <dd data-testid="camera-state">
            {{ idle: 'Desligada', requesting: 'Solicitando permissão…', running: 'Ativa', error: 'Erro' }[snap.camera.state]}
            {snap.camera.state === 'running' && snap.camera.width > 0 && ` (${snap.camera.width}×${snap.camera.height})`}
          </dd>
          <dt>Dispositivo ativo</dt>
          <dd>
            {snap.camera.state === 'running'
              ? `${snap.camera.label || 'Câmera padrão'} · ${snap.camera.facing === 'environment' ? 'Traseira' : snap.camera.facing === 'user' ? 'Frontal' : 'Orientação não informada'}`
              : '—'}
          </dd>
          <dt>Conexão segura</dt>
          <dd>{window.isSecureContext ? 'HTTPS / localhost (câmera liberada)' : 'Insegura — requer HTTPS'}</dd>
        </dl>
        <div className="field">
          <label htmlFor="cam">Câmera</label>
          <select id="cam" value={s.deviceId ?? ''} onChange={(e) => set({ deviceId: e.target.value || null })} onFocus={() => c.refreshDevices()}>
            <option value="">Automática ({s.preferredFacing === 'environment' ? 'traseira' : 'frontal'})</option>
            {snap.camera.devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          {snap.camera.devices.length === 0 && <p className="help">Os nomes das câmeras aparecem após conceder a permissão.</p>}
        </div>
        <div className="field">
          <label htmlFor="facing">Preferência</label>
          <select id="facing" value={s.preferredFacing} onChange={(e) => set({ preferredFacing: e.target.value as Settings['preferredFacing'] })}>
            <option value="environment">Câmera traseira</option>
            <option value="user">Câmera frontal</option>
          </select>
        </div>
        <Slider id="interval" label="Intervalo mínimo entre inferências" value={s.inferenceIntervalMs} min={0} max={1000} step={25} format={(v) => `${v} ms`} onChange={(v) => set({ inferenceIntervalMs: v })} help="Aumente para poupar bateria e evitar aquecimento do celular." />
        <div className="field">
          <label htmlFor="backend">Execução do modelo</label>
          <select id="backend" value={s.backend} onChange={(e) => set({ backend: e.target.value as Settings['backend'] })}>
            <option value="wasm">WebAssembly (CPU) — recomendado</option>
            <option value="webgpu">WebGPU (experimental, recai para CPU)</option>
          </select>
        </div>
        <Toggle id="debug" label="Mostrar diagnóstico técnico" checked={s.showDebug} onChange={(v) => set({ showDebug: v })} />
      </section>

      <section className="card">
        <h2>Som e alertas</h2>
        <Toggle id="sound" label="Aviso sonoro" checked={s.soundEnabled} onChange={(v) => (v ? c.enableSound() : c.disableSound())} />
        <Slider id="vol" label="Volume" value={s.soundVolume} min={0} max={1} step={0.1} format={p100} onChange={(v) => set({ soundVolume: v })} />
        <Toggle id="vib" label="Vibrar no alerta" checked={s.vibrate} onChange={(v) => set({ vibrate: v })} />
        <Slider id="cool" label="Repetir alerta da mesma pessoa/EPI após" value={s.alertCooldownMs} min={0} max={120000} step={5000} format={sec} onChange={(v) => set({ alertCooldownMs: v })} />
        <Slider id="gap" label="Intervalo mínimo entre sons" value={s.alertGlobalGapMs} min={0} max={20000} step={500} format={sec} onChange={(v) => set({ alertGlobalGapMs: v })} />
        <button className="btn" onClick={() => c.testSound()}>
          Testar som
        </button>
      </section>

      <section className="card">
        <h2>Modelo e execução</h2>
        <dl className="kv">
          <dt>Estado</dt>
          <dd data-testid="model-state">
            {{ none: 'Não configurado', loading: 'Carregando…', ready: 'Pronto', error: 'Erro' }[snap.model.state]}
          </dd>
          <dt>Modelo</dt>
          <dd>{snap.model.manifest ? `${snap.model.manifest.name} v${snap.model.manifest.version} (${snap.model.source === 'file' ? 'arquivo local' : 'servidor'})` : '—'}</dd>
          <dt>Entrada</dt>
          <dd>
            {snap.model.manifest
              ? `${snap.model.manifest.inputSize}×${snap.model.manifest.inputSize} (${snap.model.manifest.resize === 'stretch' ? 'esticado' : 'letterbox'})`
              : '—'}
          </dd>
          <dt>Saída</dt>
          <dd className="mono small">{snap.model.info ? `[${snap.model.info.outputDims.join(', ')}] ${snap.model.info.format}` : '—'}</dd>
          <dt>Classes</dt>
          <dd className="small">
            {snap.model.manifest
              ? snap.model.manifest.classes.length > 12
                ? `${snap.model.manifest.classes.length} classes`
                : snap.model.manifest.classes.join(', ')
              : '—'}
          </dd>
          <dt>Mapeamento</dt>
          <dd className="small" data-testid="class-map">
            {snap.model.manifest && Object.keys(snap.model.manifest.ppeClassMap).length
              ? Object.entries(snap.model.manifest.ppeClassMap)
                  .map(([k, v]) => `${k} → ${PPE_INFO[v!].short}`)
                  .join(' · ')
              : 'nenhuma classe de EPI'}
          </dd>
          <dt>Runtime</dt>
          <dd>
            {snap.model.info
              ? `${snap.model.info.backend}, ${snap.model.info.threads || 1} thread(s), carregado em ${Math.round(snap.model.info.loadMs)} ms`
              : '—'}
          </dd>
          <dt>Isolamento</dt>
          <dd>{window.crossOriginIsolated ? 'Ativo (multithread disponível)' : 'Inativo (1 thread)'}</dd>
        </dl>
        {snap.model.error && <Notice tone="error" title="Erro do modelo">{snap.model.error}</Notice>}
        <h3>Carregar modelo do aparelho</h3>
        <p className="small muted">Os arquivos são lidos localmente pelo navegador e não são enviados para nenhum servidor.</p>
        <div className="field">
          <label htmlFor="onnx">Arquivo .onnx</label>
          <input id="onnx" ref={onnxRef} type="file" accept=".onnx" />
        </div>
        <div className="field">
          <label htmlFor="man">manifest.json</label>
          <input id="man" ref={manRef} type="file" accept=".json,application/json" />
        </div>
        {fileError && <p className="help error">{fileError}</p>}
        <div className="controls">
          <button className="btn btn-primary" onClick={loadFiles}>
            Carregar arquivos
          </button>
          <button className="btn" onClick={() => c.loadServerModel()}>
            Recarregar do servidor
          </button>
        </div>
      </section>

      <DiagnosticPanel />

      <section className="card">
        <h2>Privacidade</h2>
        <ul className="list">
          <li>As imagens da câmera são processadas apenas na memória deste aparelho e descartadas a cada quadro.</li>
          <li>Nenhuma imagem é enviada, gravada ou armazenada. Não há reconhecimento facial nem identificação de pessoas.</li>
          <li>“Pessoa 1”, “Pessoa 2”… são rótulos temporários que somem quando a pessoa sai de cena.</li>
          <li>Ficam salvos localmente apenas: estes ajustes e, se você registrar testes, status com data/hora (sem imagens).</li>
          <li>Use somente com pessoas que consentiram em participar da demonstração.</li>
        </ul>
      </section>

      <button className="btn btn-danger-outline" onClick={() => window.confirm('Restaurar todos os ajustes padrão?') && set({ ...DEFAULT_SETTINGS })}>
        Restaurar padrões
      </button>
    </div>
  );
}
