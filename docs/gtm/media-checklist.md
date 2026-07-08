# GTM Media Checklist

This is the capture plan for the README, launch page, Product Hunt gallery, and short demo
videos. Use a clean demo deployment with fake data only. Never show real API keys, customer
documents, email addresses, tokens, internal domains, or Cloudflare account details.

## Capture Setup

- Browser: Chrome, 1440x900 or 1512x982 viewport, 100% zoom, light or dark theme consistent
  across every shot.
- Demo host: use the public demo/staging domain selected for launch, not localhost.
- Demo user: create a disposable admin account such as `demo-admin@deeptoai.com`.
- Demo model: use a healthy model row in `/admin/models`; mask or blur API key fields.
- Demo prompt theme: choose one story and reuse it everywhere, for example "build a private
  client intake tracker" for law-firm positioning or "build a research paper triage board"
  for research-lab positioning.
- Output folder: put final assets under `docs/gtm/media/`.

## README Assets

| Priority | Asset | File / link | Exact capture |
|----------|-------|-------------|---------------|
| P0 | Hero GIF | `docs/gtm/media/kin-hero-agent-preview.gif` | `/agents/c`: prompt Kin to build a small multi-file app. Record from prompt send through visible tool calls, generated files, and the preview becoming ready. Keep it 10-25s and silent. |
| P0 | Agent workspace screenshot | `docs/gtm/media/01-agent-workspace.png` | `/agents/c`: left side shows a completed agent turn with tool-call timeline; right side shows files/workbench and a ready preview. |
| P0 | Model admin screenshot | `docs/gtm/media/02-admin-models.png` | `/admin/models`: show one provider connection, healthy model status, default slots, and the API-key paste/test area. Mask secrets. |
| P0 | Canvas workspace screenshot | `docs/gtm/media/03-canvas-workspace.png` | `/agents/canvas/<canvasId>`: show chat on the left and canvas nodes on the right. Include at least one text note, one image/video node, and the bottom toolbar. |
| P1 | Online update screenshot | `docs/gtm/media/04-online-update.png` | `/admin/updates` or the sidebar update prompt: show running build, latest published build, and update state. |
| P1 | Knowledge base screenshot | `docs/gtm/media/05-knowledge-base.png` | Documents / knowledge-base surface with fake PDFs and citations visible in an answer. Only capture if RAG is enabled and stable on the demo instance. |

## Product Video

Target: 60-90 seconds. One take is fine if the screen is clean.

1. 0-8s: Open with the finished workspace, not a title slide. Show the agent workbench and say
   Kin is a self-hosted team AI workspace where documents, conversations, audit logs, and
   runtime state stay on your infrastructure.
2. 8-18s: Show `/admin/models`: provider-neutral model setup and healthy model checks.
3. 18-45s: In `/agents/c`, ask for the demo app. Show tool calls, generated files, and the
   model doing real work.
4. 45-65s: Click **运行预览 / Run preview**. Show the live preview subdomain loading.
5. 65-78s: Show `/agents/canvas/<canvasId>` briefly if canvas is part of the launch story.
6. 78-90s: Show `/admin/updates` and close with the two install paths: VPS one-command install
   and Mac/workstation Cloudflare Tunnel install.

Do not claim air-gapped or fully local inference. The honest line is: workspace data stays on
your host; model calls go to the endpoint you choose.

## Install Video

Target: 4-6 minutes. This is for users who already decided to try Kin.

1. Show prerequisites: Ubuntu/Debian VPS, Cloudflare-managed domain, `A` records for
   `APP_HOSTNAME` and `*.APP_HOSTNAME`, Cloudflare token with Zone:Read + DNS:Edit, model
   gateway key.
2. Run:

```bash
git clone https://github.com/deeptoai-com/kin.git
cd kin
sudo bash scripts/install-vps.sh
```

3. Show the installer generating secrets, pulling GHCR images, and waiting for trusted HTTPS.
4. Open `https://<domain>`, register the first user, and note that it becomes admin.
5. Open `/admin/models`, test the default model, and confirm health is healthy.
6. Ask for a tiny web app, run preview, and show `https://<preview-id>.<domain>/`.
7. Open `/admin/updates` and show the update status check.

## Product Hunt / Gallery Crop

Use the same screenshots, but crop them for legibility:

- Gallery 1: agent workspace + live preview.
- Gallery 2: model admin / provider-neutral setup.
- Gallery 3: canvas workspace if launched.
- Gallery 4: deployment paths / one-command install terminal.
- Gallery 5: online update or admin overview.

Keep UI text large enough to read in a 1270x760 gallery image.
