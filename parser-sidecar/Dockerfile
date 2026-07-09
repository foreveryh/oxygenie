# Parser sidecar — owns the Java dependency so app/worker images stay slim
# (ingest-UX spec §7; future OCR engine plugs in here as another route).
FROM node:22-slim
# openjdk = opendataloader-pdf (text-layer parse); poppler-utils = pdftoppm (PDF→PNG).
# poppler-data = CJK CMap/CID maps (Adobe-CNS1/GB1/…) — WITHOUT it pdftoppm drops all
# Chinese glyphs even from embedded fonts (blank render → garbage OCR). fonts-noto-cjk =
# CJK fallback glyphs for any non-embedded text. Both required for Chinese PDFs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     openjdk-17-jre-headless poppler-utils poppler-data fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/parser
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.mjs ./
EXPOSE 7800
USER node
CMD ["node", "server.mjs"]
