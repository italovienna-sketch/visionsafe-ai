"""Converte uma imagem em vídeo .y4m para a câmera falsa do Chrome nos testes E2E.

Uso: python make_fake_video.py <imagem> <saida.y4m> [largura altura]
O Chrome lê o arquivo com --use-file-for-fake-video-capture=<saida.y4m>.
Use somente imagens com uso autorizado (ex.: amostras que acompanham bibliotecas, fotos de voluntários).
"""
import sys

import numpy as np
from PIL import Image


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    w, h = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (720, 960)
    img = Image.open(src).convert("RGB")
    # Recorte central na proporção desejada, depois redimensiona.
    sw, sh = img.size
    target = w / h
    if sw / sh > target:
        nw = int(sh * target)
        img = img.crop(((sw - nw) // 2, 0, (sw - nw) // 2 + nw, sh))
    else:
        nh = int(sw / target)
        img = img.crop((0, (sh - nh) // 2, sw, (sh - nh) // 2 + nh))
    ycbcr = np.asarray(img.resize((w, h), Image.BILINEAR).convert("YCbCr"))
    y = ycbcr[:, :, 0].tobytes()
    u = np.asarray(Image.fromarray(ycbcr[:, :, 1]).resize((w // 2, h // 2), Image.BILINEAR)).tobytes()
    v = np.asarray(Image.fromarray(ycbcr[:, :, 2]).resize((w // 2, h // 2), Image.BILINEAR)).tobytes()
    with open(dst, "wb") as f:
        f.write(f"YUV4MPEG2 W{w} H{h} F10:1 Ip A1:1 C420jpeg\n".encode())
        for _ in range(20):
            f.write(b"FRAME\n" + y + u + v)
    print(dst)


if __name__ == "__main__":
    main()
