import { useMemo } from 'react';
import { Metric, Notice, fmt, pct } from '../components/Common';
import { computeMetrics, isInsufficient, latencyStats, MIN_SAMPLES, MIN_SCENARIOS, samplesToCsv } from '../core/evaluation';
import { supportedTargets } from '../core/manifest';
import { PPE_INFO } from '../core/ppe';
import { PPE_CLASSES, type PpeClass } from '../core/types';
import { useController, useMonitor } from '../controller/context';

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TruthToggle({ cls, value, onChange, disabled }: { cls: PpeClass; value: boolean | null; onChange: (v: boolean | null) => void; disabled: boolean }) {
  const opts: { v: boolean | null; label: string }[] = [
    { v: true, label: 'Usando' },
    { v: false, label: 'Sem EPI' },
    { v: null, label: 'Não avaliar' },
  ];
  return (
    <fieldset className="truth" disabled={disabled}>
      <legend>{PPE_INFO[cls].label}</legend>
      <div className="seg">
        {opts.map((o) => (
          <button key={String(o.v)} type="button" className={value === o.v ? 'active' : ''} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function ResultsPage() {
  const c = useController();
  const snap = useMonitor();
  const ev = snap.evaluation;
  const metrics = useMemo(() => computeMetrics(ev.samples), [ev.samples]);
  const lat = useMemo(() => latencyStats(ev.latencies), [ev.latencies]);
  const supported = snap.model.manifest ? supportedTargets(snap.model.manifest) : new Set<PpeClass>();
  const anyTruth = PPE_CLASSES.some((cls) => ev.truth[cls] !== null);
  const canRecord = snap.camera.state === 'running' && snap.model.state === 'ready' && anyTruth;

  return (
    <div className="page">
      <h1>Resultados de teste</h1>
      <p className="muted">
        Compare a decisão do sistema com o gabarito informado por você durante a demonstração. Cada amostra é registrada uma
        vez por segundo, apenas com o status (sem imagens), e fica salva só neste aparelho.
      </p>

      <section className="card">
        <h2>1. Gabarito da pessoa em cena</h2>
        <p className="small muted">Informe o que a pessoa realmente está usando. Mudar o gabarito inicia um novo cenário.</p>
        {PPE_CLASSES.map((cls) => (
          <TruthToggle key={cls} cls={cls} value={ev.truth[cls]} onChange={(v) => c.setTruth(cls, v)} disabled={!supported.has(cls)} />
        ))}
        {supported.size === 0 && <p className="small muted">O modelo atual não suporta nenhuma classe de EPI; não há o que avaliar.</p>}
        <div className="controls">
          <button className={`btn ${ev.recording ? 'btn-danger' : 'btn-primary'}`} disabled={!ev.recording && !canRecord} onClick={() => c.setRecording(!ev.recording)}>
            {ev.recording ? 'Parar registro' : 'Iniciar registro'}
          </button>
          {ev.recording && <span className="rec">● Registrando cenário {ev.scenario}</span>}
        </div>
        {!canRecord && !ev.recording && (
          <p className="small muted">Para registrar: câmera ligada, modelo de EPI carregado e ao menos um item do gabarito definido.</p>
        )}
      </section>

      <section className="card">
        <h2>2. Desempenho por classe</h2>
        <div className="table-wrap">
          <table className="results">
            <thead>
              <tr>
                <th scope="col">Classe</th>
                <th scope="col">Amostras</th>
                <th scope="col">Cenários</th>
                <th scope="col" title="Usando EPI e sistema disse Detectado">Acertos (VP)</th>
                <th scope="col" title="Sem EPI e sistema disse Não confirmado">Acertos (VN)</th>
                <th scope="col" title="Usando EPI e sistema disse Não confirmado">Perdidas (FN)</th>
                <th scope="col" title="Sem EPI e sistema disse Detectado">Falso positivo</th>
                <th scope="col">Incerto</th>
                <th scope="col">Precisão</th>
                <th scope="col">Revocação</th>
                <th scope="col">Cobertura</th>
              </tr>
            </thead>
            <tbody>
              {PPE_CLASSES.map((cls) => {
                const m = metrics[cls];
                return (
                  <tr key={cls}>
                    <th scope="row">{PPE_INFO[cls].short}</th>
                    <td>{m.samples}</td>
                    <td>{m.scenarios}</td>
                    <td>{m.tp}</td>
                    <td>{m.tn}</td>
                    <td>{m.fn}</td>
                    <td>{m.fp}</td>
                    <td>{m.uncertain + m.unavailable}</td>
                    <td>{pct(m.precision)}</td>
                    <td>{pct(m.recall)}</td>
                    <td>{pct(m.coverage)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {PPE_CLASSES.some((cls) => isInsufficient(metrics[cls])) && (
          <Notice tone="warn" title="Dados de avaliação insuficientes">
            Resultados só são indicativos com pelo menos {MIN_SAMPLES} amostras e {MIN_SCENARIOS} cenários por classe (pessoas,
            iluminação, distâncias e modelos de EPI diferentes). Amostras consecutivas são muito correlacionadas — trate estes
            números como teste de bancada, não como acurácia do sistema.
          </Notice>
        )}
      </section>

      <section className="card">
        <h2>3. Latência de processamento</h2>
        {lat ? (
          <div className="metrics-row">
            <Metric label="Quadros" value={lat.count} />
            <Metric label="Média" value={fmt(lat.mean)} unit="ms" />
            <Metric label="Mediana" value={fmt(lat.p50)} unit="ms" />
            <Metric label="P95" value={fmt(lat.p95)} unit="ms" />
          </div>
        ) : (
          <p className="muted">Nenhum quadro processado nesta sessão.</p>
        )}
        <p className="small muted">Latência de ponta a ponta (captura → resultado) medida neste aparelho, nesta sessão.</p>
      </section>

      <div className="controls">
        <button className="btn" disabled={!ev.samples.length} onClick={() => download('visionsafe-amostras.csv', samplesToCsv(ev.samples), 'text/csv')}>
          Exportar CSV
        </button>
        <button
          className="btn"
          disabled={!ev.samples.length}
          onClick={() => download('visionsafe-resumo.json', JSON.stringify({ model: snap.model.manifest, settings: snap.settings, metrics, latency: lat }, null, 2), 'application/json')}
        >
          Exportar resumo
        </button>
        <button
          className="btn btn-danger-outline"
          disabled={!ev.samples.length && !ev.latencies.length}
          onClick={() => window.confirm('Apagar todas as amostras de teste deste aparelho?') && c.clearEvaluation()}
        >
          Apagar dados
        </button>
      </div>
    </div>
  );
}
