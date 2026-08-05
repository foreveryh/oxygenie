# Media Generation Adapter Architecture

Status: implementation baseline (2026-08-05)

## Goal

Allow Kin canvas image/video generation to switch between already-installed
providers from Admin · Models, while making a future provider integration a bounded
adapter addition rather than a canvas/Agent/queue rewrite.

## Decisions

1. `protocol` describes a connection's broad wire family; it is not a media driver.
2. Each media-capable model may declare `mediaAdapter` and adapter-owned
   `mediaConfig`. The adapter belongs to the model because one connection can host
   models with different endpoint shapes (for example Imagen and Veo).
3. Canvas orchestration uses one provider-neutral `generateMedia` contract.
4. Provider credentials are resolved server-side and passed as typed route context;
   adapters do not query the database or mutate global process environment.
5. Existing Gemini rows with no adapter remain compatible through deterministic
   legacy inference (`image → google-imagen`, `video → google-veo`).
6. Direct generation freezes the chosen model id on `generation_task.model_slug` at
   task creation, so changing a default does not reroute an already queued task.

## Extension contract

A new provider integration owns:

- request validation/translation;
- endpoint paths and authentication headers;
- synchronous response handling or asynchronous submit/poll/download flow;
- provider status/error normalization;
- normalized local file output.

It registers an adapter with `{ id, capabilities, generate }`. Existing canvas task,
asset placement, quota, Agent frames and queue code remain unchanged.

```js
registerMediaAdapter({
  id: 'vendor-video',
  capabilities: ['video'],
  async generate({ route, input, outputDir }) {
    // route: model/baseUrl/apiKey/authStyle/customHeaders/config
    // input: prompt/mode/references/aspect/durationSeconds/resolution
    // This module owns submit → poll/webhook wait → download.
    return { files: [{ id, relPath, width, height, durationSec }] };
  },
});
```

After the adapter is installed, add a `custom-media` connection, create a model with
the adapter id, mark it `image` or `video`, and select it in the capability default
slot. No canvas or Agent code changes are required.

## Implemented video providers

`minimax-video` implements the MiniMax/Hailuo submit → poll → file retrieval flow.
Its default paths match MiniMax's public API, but the connection's `baseUrl` is used
for every request, so a compatible relay only requires changing that field. Path and
polling overrides are available in `mediaConfig`.

`minimax-h3-video` is a separate V2 adapter for `MiniMax-H3`: it submits the
multimodal `content[]` payload to `/v2/video_generation`, polls
`/v2/query/video_generation/{taskId}`, and downloads `task.content.url`. It must not
reuse the legacy MiniMax adapter because its endpoint, payload and result shape are
different. H3 exposes 768P/2K, 4–15 seconds, concrete T2V ratios, first/last frames,
up to 9 reference images, and up to 3 reference videos/audio clips. First/last-frame
and reference modes are mutually exclusive. Local media is serialized by role into
`image_url` / `video_url` / `audio_url`; the adapter enforces a safe inline-body cap.

`seedance-video` uses the prevalent asynchronous Seedance gateway shape. Since
Seedance is commonly sold through gateways with different URL prefixes and response
envelopes, `mediaConfig` can override `submitPath`, `statusPathTemplate`, task/status
JSON paths, result JSON path, and terminal status names. The model code remains the
same when moving between an official endpoint and a relay.

`grok-imagine-video` implements xAI's `/v1/videos/generations` submit and
`/v1/videos/{requestId}` poll flow. It supports text-to-video, a single image-to-video
source, and up to 7 reference images. Grok's preset `voice_id` feature is deliberately
not represented as a canvas audio reference: the public API does not accept uploaded
audio clips for that field. Base URL, paths and response paths remain configurable.

## Capability contract and UI compatibility

`mediaConfig.capabilities.video` is the model's public constraint manifest. Its
values are intentionally model-level rather than provider-level: a fast tier and a
quality tier from the same provider can have different durations or frame controls.
The normalized contract exposes provider-neutral `modes`, semantic input slots and
`parameterCombinations`. Legacy `firstFrame` / `lastFrame` flags are translated into
modes, so old rows and tasks remain valid.
The direct-generation bar reads the current default model's manifest and renders only
the allowed options. It also receives all enabled models for that capability and
builds one union option list: unsupported values remain visible but disabled, with
the model labels that unlock them. For example, `30s（需 Seedance 2.5）` stays visible
while Seedance 2.0 is selected. Changing the model recalculates duration, resolution,
aspect, first frame and last frame from the same manifest; there are no provider-name
branches in the component. The server validates the request before creating a task
and the worker validates again immediately before the provider request. Thus a stale
browser, Agent tool call, or handcrafted HTTP request cannot turn an unsupported
`30s` choice into a billable provider call.

```json
{
  "capabilities": {
    "video": {
      "durationSeconds": [6, 10],
      "resolutions": ["768p", "1080p"],
      "modes": [
        { "id": "text_to_video", "inputs": [] },
        { "id": "first_last_frame", "inputs": [
          { "role": "first_frame", "accepts": ["image"], "min": 1, "max": 1 }
        ] }
      ],
      "parameterCombinations": [
        { "resolution": "768p", "durationSeconds": [6, 10] },
        { "resolution": "1080p", "durationSeconds": [6] }
      ]
    }
  }
}
```

An empty option list means "do not expose/send this parameter"; Kin lets the provider
apply its own default. This is the safe default for an unprofiled relay. Canvas
selection becomes per-request References; the UI only asks for a material purpose when
more than one mode can consume the same selection. Provider names never appear in the
component's branching logic.

For example, a relay returning `{ data: { id, state, videos: [{ uri }] } }` uses:

```json
{
  "submitPath": "/gateway/generate",
  "statusPathTemplate": "/gateway/jobs/{taskId}",
  "taskIdPath": "data.id",
  "statusPath": "data.state",
  "resultUrlsPath": "data.videos",
  "successStatuses": ["SUCCEEDED"]
}
```

## Follow-ups

- Split long-running adapters into resumable `submit/poll/collect` phases and persist
  the remote task id when restart recovery becomes a product requirement.
- Add provider-discovered model manifests when upstream APIs expose reliable
  capabilities; configured manifests remain authoritative for relays.
