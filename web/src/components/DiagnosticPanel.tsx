import { useEffect, useRef, useState } from 'react';
import type { FrameResult } from '../core/types';
import { PPE_INFO } from '../core/ppe';
import { useController, useMonitor } from '../controller/context';
import { fmt } from './Common';
import { IconImage } from './Icons';

/**
 * Teste com imagem conhecida: roda o modelo carregado uma única vez sobre uma imagem escolhida
 * e mostra a saída bruta (dimensões, escores máximos por classe) e as detecções decodificadas.
 * Serve para separar "o modelo não vê o EPI" de "o pipeline está quebrado".
 */
export function DiagnosticPanel() {
  const c = useController();
  const snap = useMonitor();
  const [result, setResult] = useState<FrameResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const m = snap.model.manifest;

  const run = async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const preview = await createImageBitmap(file);
      setImage((old) => {
        old?.close();
        return preview;
      });
      setResult(await c.diagnoseImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !image) return;
    cv.width = image.width;
    cv.height = image.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    if (!result || !m) return;
    const lw = Math.max(2, image.width / 300);
    ctx.font = `600 ${Math.max(12, image.width / 45)}px system-ui, sans-serif`;
    for (const d of result.detections) {
      const mapped = m.ppeClassMap[d.className];
      const color = mapped ? '#22d3ee' : d.className === m.subjectClass ? '#fbbf24' : '#94a3b8';
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.strokeRect(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
      const label = `${d.className} ${Math.round(d.score * 100)}%`;
      const h = Math.max(14, image.width / 40);
      ctx.fillStyle = color;
      ctx.fillRect(d.x1, Math.max(0, d.y1 - h), ctx.measureText(label).width + 8, h);
      ctx.fillStyle = '#05101f';
      ctx.fillText(label, d.x1 + 4, Math.max(h - 4, d.y1 - 4));
    }
  }, [image, result, m]);

  const raw = result?.raw;
  return (
    <section className="card" data-testid="diagnostic-panel">
      <h2>Teste com imagem conhecida</h2>
      <p className="badge-inline" data-testid="diag-not-live">IMAGEM ESTÁTICA — não é detecção da câmera ao vivo</p>
      <p className="small muted">
        Roda o modelo uma vez sobre uma foto escolhida por você e mostra a saída bruta e as detecções. A imagem é processada
        apenas neste aparelho e não é salva.
      </p>
      <div className="field">
        <label htmlFor="diag-img">Imagem de teste</label>
        <input
          id="diag-img"
          type="file"
          accept="image/*"
          disabled={snap.model.state !== 'ready' || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void run(f);
          }}
        />
        {snap.model.state !== 'ready' && <p className="help">Disponível quando houver um modelo carregado.</p>}
      </div>
      {busy && <p className="small muted">Processando…</p>}
      {error && <p className="help error">{error}</p>}
      {image && (
        <div className="diag-preview">
          <canvas ref={canvas} aria-label="Imagem de teste com as caixas detectadas" />
        </div>
      )}
      {result && m && (
        <div data-testid="diagnostic-result">
          <p className="mono small" style={{ marginTop: 10 }}>
            imagem {result.frameWidth}×{result.frameHeight} → entrada {m.inputSize}px ({m.resize ?? 'letterbox'}) · modelo{' '}
            {fmt(result.timings.inferenceMs)} ms · detecções ≥ {Math.round(snap.settings.detectorScoreFloor * 100)}%:{' '}
            <strong data-testid="diag-count">{result.detections.length}</strong>
          </p>
          {raw && (
            <p className="mono small" data-testid="diag-raw">
              saída bruta [{raw.dims.join('×')}] {raw.format} · valores {fmt(raw.valueRange[0], 2)}…{fmt(raw.valueRange[1], 2)} ·
              candidatos ≥25%: {raw.candidatesAbove025}
            </p>
          )}
          <div className="table-wrap">
            <table className="results">
              <thead>
                <tr>
                  <th>Classe do modelo</th>
                  <th>Uso no app</th>
                  <th>Escore máx. bruto</th>
                  <th>Detecções</th>
                </tr>
              </thead>
              <tbody>
                {/* Com modelo de recorte, os EPIs vêm dele: a saída bruta (maxPerClass) é só do modelo principal. */}
                {(m.cropModel ? [m.subjectClass!, ...(m.cropModel.keepMainClasses ?? []), ...m.cropModel.classes] : m.classes)
                  .map((name) => {
                    const i = m.classes.indexOf(name);
                    const fromMain = i >= 0 && (!m.cropModel || !m.cropModel.classes.includes(name));
                    return {
                      name,
                      max: fromMain && raw ? raw.maxPerClass[i] : null,
                      n: result.detections.filter((d) => d.className === name).length,
                    };
                  })
                  .filter((r) => r.n > 0 || m.ppeClassMap[r.name] || r.name === m.subjectClass)
                  .map((r) => (
                    <tr key={r.name}>
                      <th>{r.name}</th>
                      <td>{m.ppeClassMap[r.name] ? PPE_INFO[m.ppeClassMap[r.name]!].short : r.name === m.subjectClass ? 'sujeito' : '—'}</td>
                      <td>{r.max !== null ? `${Math.round(r.max * 100)}%` : '—'}</td>
                      <td>{r.n}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!result.detections.length && (
            <p className="help">
              Nenhuma caixa acima do piso. Se o escore máximo bruto do EPI também for baixo, o modelo não reconhece o objeto
              nesta imagem — não é falha de pipeline.
            </p>
          )}
        </div>
      )}
      <p className="help">
        <IconImage size={14} /> Dica: use uma foto nítida, de frente, com a pessoa ocupando boa parte da imagem.
      </p>
    </section>
  );
}
