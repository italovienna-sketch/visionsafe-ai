import { useMonitor } from '../controller/context';

export function AboutPage() {
  const { model } = useMonitor();
  const m = model.manifest;
  return (
    <div className="page">
      <h1>Sobre o protótipo</h1>

      <section className="card">
        <h2>Finalidade</h2>
        <p>
          Prova de conceito independente para explorar a verificação de EPIs por visão computacional em ambiente industrial,
          usando apenas a câmera de um celular. <strong>Não é um sistema oficial de nenhuma empresa</strong>, não é certificado e não
          substitui a supervisão de segurança. Qualquer uso operacional exige validação das regras por um profissional de
          segurança do trabalho.
        </p>
      </section>

      <section className="card">
        <h2>Como decide</h2>
        <ol className="list">
          <li>Cada quadro passa por um detector de objetos (YOLO em ONNX) executado no navegador, dentro de um Web Worker.</li>
          <li>
            Cada EPI detectado é atribuído à pessoa cuja região da cabeça o contém. Se a peça couber em duas pessoas sem
            margem clara, não é atribuída a ninguém e a leitura fica ambígua — nunca vira ausência.
          </li>
          <li>Imagens borradas, escuras, distantes ou cortadas viram observações “inobserváveis”, nunca “ausência”.</li>
          <li>
            Uma janela de verificação acumula observações: <em>Detectado</em> exige várias confirmações;{' '}
            <em>Não confirmado</em> exige a janela completa, muitas observações válidas e poucas ambíguas, e significa
            apenas que o EPI não apareceu na imagem — não prova que a pessoa está sem ele (pode estar oculto, fora do
            ângulo ou não ser reconhecido pelo modelo).
          </li>
          <li>
            <em>Não avaliável</em> é tudo o que não permite decidir: verificando, pessoa distante ou cortada, imagem
            escura ou borrada, confiança abaixo do limiar, câmera desligada, monitoramento pausado, modelo ausente ou
            classe que o modelo não reconhece. O motivo aparece no cartão. Nunca é tratado como infração.
          </li>
          <li>Alertas são locais (tela, som opcional e vibração) e têm supressão de repetição.</li>
        </ol>
      </section>

      <section className="card">
        <h2>Modelo em uso</h2>
        {m ? (
          <dl className="kv">
            <dt>Nome</dt>
            <dd>
              {m.name} v{m.version}
              {m.cropModel && ` (rosto) + ${m.cropModel.name} v${m.cropModel.version} (EPIs no recorte da cabeça)`}
            </dd>
            <dt>Finalidade</dt>
            <dd>{m.purpose === 'diagnostic' ? 'Diagnóstico do pipeline (não detecta EPIs)' : 'Detecção de EPIs'}</dd>
            <dt>Classes</dt>
            <dd className="mono small">
              {m.classes.length > 12 ? `${m.classes.length} classes` : m.classes.join(', ')}
              {m.cropModel && ` · recorte: ${m.cropModel.classes.join(', ')}`}
            </dd>
            <dt>Licença do modelo</dt>
            <dd>{m.license ?? 'não informada'}</dd>
            <dt>Modelo base</dt>
            <dd>{m.training?.baseModel ?? '—'}</dd>
            <dt>Dataset</dt>
            <dd>
              {m.training?.dataset ?? '—'}
              {m.training?.datasetLicense && ` (${m.training.datasetLicense})`}
            </dd>
            {m.proxyClasses && Object.keys(m.proxyClasses).length > 0 && (
              <>
                <dt>Aproximações</dt>
                <dd>
                  <ul className="list small">
                    {Object.entries(m.proxyClasses).map(([k, v]) => (
                      <li key={k}>{v}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {m.metrics && typeof m.metrics === 'object' && 'per_class' in m.metrics && (
              <>
                <dt>Métricas (teste)</dt>
                <dd className="mono small" data-testid="model-metrics">
                  {Object.entries(m.metrics.per_class as Record<string, { precision?: number; recall?: number; mAP50?: number; instances?: number }>)
                    .map(([k, v]) => `${k}: P ${v.precision ?? '—'} · R ${v.recall ?? '—'} · mAP50 ${v.mAP50 ?? '—'} (n=${v.instances ?? '?'})`)
                    .join(' | ')}
                </dd>
              </>
            )}
            {m.training?.notes && (
              <>
                <dt>Notas</dt>
                <dd>{m.training.notes}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="muted">Nenhum modelo carregado. Veja docs/MODELO_E_DATASET.md para treinar e instalar um.</p>
        )}
      </section>

      <section className="card">
        <h2>Limitações conhecidas</h2>
        <ul className="list">
          <li>Não existe modelo público que cubra exatamente os três EPIs-alvo; é necessário treinar com imagens do EPI real.</li>
          <li>Óculos de segurança podem ser confundidos com óculos comuns; protetores de inserção são pequenos e frequentemente ocultos pelo cabelo.</li>
          <li>Desempenho varia com iluminação, distância, ângulo, oclusão e com o celular usado.</li>
          <li>Os resultados da tela “Testes” são de bancada e não estimam a acurácia em operação.</li>
          <li>Sem integração com CFTV, cadastro de funcionários ou qualquer sistema da empresa.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Software e licenças</h2>
        <ul className="list small">
          <li>ONNX Runtime Web — MIT (Microsoft)</li>
          <li>React — MIT (Meta)</li>
          <li>Vite — MIT</li>
          <li>
            Ultralytics YOLO (treinamento/exportação) — AGPL-3.0. Pesos derivados herdam a AGPL; uso comercial requer licença
            Enterprise da Ultralytics ou troca por detector com licença permissiva. Detalhes em docs/DECISAO_TECNOLOGICA.md.
          </li>
          <li>
            Dataset SH17 (Ahmad &amp; Rahimi, 2024) — CC BY-NC-SA 4.0: modelos treinados com ele são apenas para avaliação
            não comercial, com atribuição e compartilhamento pela mesma licença.
          </li>
        </ul>
      </section>
    </div>
  );
}
