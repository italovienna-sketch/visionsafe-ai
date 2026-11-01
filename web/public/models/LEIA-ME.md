# Pasta de modelos

Coloque aqui o modelo exportado e o manifesto (gerados por `training/export_onnx.py`):

```
public/models/manifest.json
public/models/<nome-do-modelo>.onnx
```

Arquivos `.onnx` e `manifest.json` desta pasta **não são versionados** (ver `.gitignore`):
pesos podem ter restrições de licença (ex.: AGPL-3.0 da Ultralytics, CC BY-NC-SA do SH17).

Sem `manifest.json`, o aplicativo abre normalmente e exibe "Aguardando modelo compatível".
Veja `docs/MODELO_E_DATASET.md`.
