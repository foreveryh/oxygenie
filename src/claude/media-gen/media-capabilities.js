/**
 * Provider-neutral media capability contract.
 *
 * Model manifests describe stable user intent (generation modes, reference slots and
 * parameter combinations). Provider adapters remain responsible for translating that
 * intent to their wire format. The legacy firstFrame/lastFrame flags are normalized
 * into modes so existing model rows keep working.
 */

const TEXT_TO_VIDEO_MODE = { id: 'text_to_video', label: '文生视频', inputs: [], aspectBehavior: 'select' };

const H3_MODES = [
  TEXT_TO_VIDEO_MODE,
  {
    id: 'first_last_frame', label: '首尾帧', aspectBehavior: 'input',
    inputs: [
      { role: 'first_frame', accepts: ['image'], min: 1, max: 1, maxFileSizeMb: 30 },
      { role: 'last_frame', accepts: ['image'], min: 0, max: 1, maxFileSizeMb: 30 },
    ],
  },
  {
    id: 'reference', label: '参考素材', aspectBehavior: 'select',
    inputs: [
      { role: 'reference_image', accepts: ['image'], min: 0, max: 9, maxFileSizeMb: 30 },
      { role: 'reference_video', accepts: ['video'], min: 0, max: 3, maxFileSizeMb: 50, minDurationSec: 2, maxDurationSec: 15, maxTotalDurationSec: 15 },
      { role: 'reference_audio', accepts: ['audio'], min: 0, max: 3, maxFileSizeMb: 15, minDurationSec: 2, maxDurationSec: 15, maxTotalDurationSec: 15 },
    ],
    minInputs: 1,
  },
];

const GROK_VIDEO_MODES = [
  TEXT_TO_VIDEO_MODE,
  {
    id: 'first_last_frame', label: '首帧', aspectBehavior: 'select',
    inputs: [{ role: 'first_frame', accepts: ['image'], min: 1, max: 1 }],
  },
  {
    id: 'reference', label: '参考素材', aspectBehavior: 'select', minInputs: 1,
    inputs: [{ role: 'reference_image', accepts: ['image'], min: 1, max: 7 }],
  },
];

const VIDEO_BASELINES = {
  'google-veo': {
    aspects: ['16:9', '9:16'], durationSeconds: [4, 6, 8], resolutions: ['720p', '1080p'], firstFrame: true, lastFrame: false,
  },
  'minimax-video': {
    aspects: ['16:9', '9:16'], durationSeconds: [6], resolutions: ['1080p'], firstFrame: true, lastFrame: false,
  },
  'minimax-h3-video': {
    aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    durationSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: ['768p', '2k'], firstFrame: true, lastFrame: true,
    aspectFromFirstFrame: true, modes: H3_MODES,
  },
  // Gateways differ materially. Model rows must explicitly declare their limits.
  'seedance-video': { aspects: [], durationSeconds: [], resolutions: [], firstFrame: false, lastFrame: false },
  'grok-imagine-video': {
    aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: ['480p', '720p', '1080p'], firstFrame: true, lastFrame: false,
    modes: GROK_VIDEO_MODES,
    parameterCombinations: [
      { mode: 'text_to_video', resolution: '480p', durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      { mode: 'text_to_video', resolution: '720p', durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      { mode: 'text_to_video', resolution: '1080p', durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      { mode: 'first_last_frame', resolution: '480p', durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      { mode: 'first_last_frame', resolution: '720p', durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      { mode: 'first_last_frame', resolution: '1080p', durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      { mode: 'reference', resolution: '480p', durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      { mode: 'reference', resolution: '720p', durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
    ],
  },
};

const EMPTY_VIDEO_BASELINE = { aspects: [], durationSeconds: [], resolutions: [], firstFrame: false, lastFrame: false };
const IMAGE_BASELINE = { aspects: ['1:1', '3:4', '4:3', '9:16', '16:9'], count: [1, 2, 3, 4], referenceImage: false };

function strings(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))] : [];
}

function numbers(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => Number.isFinite(item) && item > 0))] : [];
}

function supplied(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

function positiveNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : undefined;
}

function normalizeSlot(slot) {
  if (!slot || typeof slot !== 'object' || typeof slot.role !== 'string') return null;
  const accepts = strings(slot.accepts).filter((item) => ['image', 'video', 'audio'].includes(item));
  if (accepts.length === 0) return null;
  return {
    role: slot.role,
    accepts,
    min: positiveNumber(slot.min) ?? 0,
    max: positiveNumber(slot.max) ?? 1,
    ...(positiveNumber(slot.maxFileSizeMb) !== undefined ? { maxFileSizeMb: Number(slot.maxFileSizeMb) } : {}),
    ...(positiveNumber(slot.minDurationSec) !== undefined ? { minDurationSec: Number(slot.minDurationSec) } : {}),
    ...(positiveNumber(slot.maxDurationSec) !== undefined ? { maxDurationSec: Number(slot.maxDurationSec) } : {}),
    ...(positiveNumber(slot.maxTotalDurationSec) !== undefined ? { maxTotalDurationSec: Number(slot.maxTotalDurationSec) } : {}),
  };
}

function normalizeModes(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((mode) => {
    if (!mode || typeof mode !== 'object' || typeof mode.id !== 'string') return [];
    const inputs = Array.isArray(mode.inputs) ? mode.inputs.map(normalizeSlot).filter(Boolean) : [];
    return [{
      id: mode.id,
      label: typeof mode.label === 'string' && mode.label ? mode.label : mode.id,
      inputs,
      aspectBehavior: ['select', 'input', 'adaptive'].includes(mode.aspectBehavior) ? mode.aspectBehavior : 'select',
      ...(positiveNumber(mode.minInputs) !== undefined ? { minInputs: Number(mode.minInputs) } : {}),
    }];
  });
}

function legacyModes(firstFrame, lastFrame, aspectFromFirstFrame) {
  const modes = [TEXT_TO_VIDEO_MODE];
  if (firstFrame || lastFrame) {
    modes.push({
      id: 'first_last_frame',
      label: lastFrame ? '首尾帧' : '首帧',
      aspectBehavior: aspectFromFirstFrame ? 'input' : 'select',
      inputs: [
        { role: 'first_frame', accepts: ['image'], min: 1, max: 1 },
        ...(lastFrame ? [{ role: 'last_frame', accepts: ['image'], min: 0, max: 1 }] : []),
      ],
    });
  }
  return modes;
}

function normalizeParameterCombinations(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const normalized = {
      ...(typeof item.mode === 'string' ? { mode: item.mode } : {}),
      ...(typeof item.resolution === 'string' ? { resolution: item.resolution } : {}),
      ...(strings(item.aspects).length ? { aspects: strings(item.aspects) } : {}),
      ...(numbers(item.durationSeconds).length ? { durationSeconds: numbers(item.durationSeconds) } : {}),
    };
    return Object.keys(normalized).length ? [normalized] : [];
  });
}

export function resolveMediaCapabilities(route, capability) {
  const requested = route?.config?.capabilities?.[capability] || {};
  if (capability === 'image') {
    return {
      aspects: supplied(requested, 'aspects') ? strings(requested.aspects) : IMAGE_BASELINE.aspects,
      count: supplied(requested, 'count') ? numbers(requested.count) : IMAGE_BASELINE.count,
      referenceImage: requested.referenceImage === true,
    };
  }

  const baseline = VIDEO_BASELINES[route?.adapter] || EMPTY_VIDEO_BASELINE;
  const firstFrame = requested.firstFrame === undefined ? baseline.firstFrame === true : requested.firstFrame === true;
  const lastFrame = requested.lastFrame === undefined ? baseline.lastFrame === true : requested.lastFrame === true;
  const aspectFromFirstFrame = requested.aspectFromFirstFrame === undefined
    ? baseline.aspectFromFirstFrame === true
    : requested.aspectFromFirstFrame === true;
  const explicitModes = supplied(requested, 'modes') ? normalizeModes(requested.modes) : null;
  const baselineModes = normalizeModes(baseline.modes);

  return {
    aspects: supplied(requested, 'aspects') ? strings(requested.aspects) : baseline.aspects,
    durationSeconds: supplied(requested, 'durationSeconds') ? numbers(requested.durationSeconds) : baseline.durationSeconds,
    resolutions: supplied(requested, 'resolutions') ? strings(requested.resolutions) : baseline.resolutions,
    firstFrame,
    lastFrame,
    aspectFromFirstFrame,
    modes: explicitModes ?? (baselineModes.length ? baselineModes : legacyModes(firstFrame, lastFrame, aspectFromFirstFrame)),
    parameterCombinations: normalizeParameterCombinations(requested.parameterCombinations ?? baseline.parameterCombinations),
  };
}

export function modeSupportsMediaTypes(mode, mediaTypes) {
  if (!mode || !Array.isArray(mediaTypes)) return false;
  if (mediaTypes.length === 0) {
    return (mode.inputs || []).every((slot) => (slot.min || 0) === 0) && (mode.minInputs || 0) === 0;
  }
  const remainingByRole = new Map((mode.inputs || []).map((slot) => [slot.role, slot.max ?? 1]));
  for (const mediaType of mediaTypes) {
    const slot = (mode.inputs || []).find((candidate) => candidate.accepts.includes(mediaType) && (remainingByRole.get(candidate.role) || 0) > 0);
    if (!slot) return false;
    remainingByRole.set(slot.role, (remainingByRole.get(slot.role) || 0) - 1);
  }
  return (mode.inputs || []).every((slot) => {
    const used = (slot.max ?? 1) - (remainingByRole.get(slot.role) || 0);
    return used >= (slot.min || 0);
  }) && mediaTypes.length >= (mode.minInputs || 0);
}

export function isMediaParameterCombinationAllowed(capabilities, input) {
  const combinations = capabilities?.parameterCombinations || [];
  if (combinations.length === 0) return true;
  return combinations.some((rule) => {
    if (rule.mode && input.mode && rule.mode !== input.mode) return false;
    if (rule.resolution && input.resolution && rule.resolution !== input.resolution) return false;
    if (rule.durationSeconds?.length && input.durationSeconds && !rule.durationSeconds.includes(input.durationSeconds)) return false;
    if (rule.aspects?.length && input.aspect && !rule.aspects.includes(input.aspect)) return false;
    return true;
  });
}

function normalizedReferences(input) {
  if (Array.isArray(input.references)) return input.references;
  return [
    ...(input.imagePath ? [{ role: 'first_frame', mediaType: 'image', path: input.imagePath }] : []),
    ...(input.lastImagePath ? [{ role: 'last_frame', mediaType: 'image', path: input.lastImagePath }] : []),
  ];
}

function inferredMode(input, references) {
  if (input.mode) return input.mode;
  if (references.some((item) => String(item.role).startsWith('reference_'))) return 'reference';
  if (references.some((item) => item.role === 'first_frame' || item.role === 'last_frame')) return 'first_last_frame';
  return 'text_to_video';
}

function validateReferences(route, mode, references) {
  if (!mode) throw new Error(`Model "${route.id}" does not support the requested generation mode`);
  if (references.length < (mode.minInputs || 0)) throw new Error(`Mode "${mode.label}" requires at least ${mode.minInputs} reference item(s)`);
  const byRole = new Map();
  for (const reference of references) {
    const slot = (mode.inputs || []).find((candidate) => candidate.role === reference.role);
    if (!slot) throw new Error(`Model "${route.id}" does not accept role ${reference.role} in mode ${mode.id}`);
    if (!slot.accepts.includes(reference.mediaType)) throw new Error(`Role ${reference.role} does not accept ${reference.mediaType}`);
    const items = byRole.get(slot.role) || [];
    items.push(reference);
    byRole.set(slot.role, items);
  }
  for (const slot of mode.inputs || []) {
    const items = byRole.get(slot.role) || [];
    if (items.length < (slot.min || 0)) throw new Error(`Mode "${mode.label}" requires ${slot.role}`);
    if (items.length > (slot.max ?? 1)) throw new Error(`Mode "${mode.label}" accepts at most ${slot.max ?? 1} ${slot.role} item(s)`);
    let totalDuration = 0;
    for (const item of items) {
      if (slot.maxFileSizeMb && item.sizeBytes && item.sizeBytes > slot.maxFileSizeMb * 1024 * 1024) {
        throw new Error(`${slot.role} exceeds the ${slot.maxFileSizeMb} MB file limit`);
      }
      if (item.durationSec !== undefined) {
        if (slot.minDurationSec !== undefined && item.durationSec < slot.minDurationSec) throw new Error(`${slot.role} must be at least ${slot.minDurationSec}s`);
        if (slot.maxDurationSec !== undefined && item.durationSec > slot.maxDurationSec) throw new Error(`${slot.role} must be at most ${slot.maxDurationSec}s`);
        totalDuration += item.durationSec;
      }
    }
    if (slot.maxTotalDurationSec !== undefined && totalDuration > slot.maxTotalDurationSec) {
      throw new Error(`${slot.role} total duration must be at most ${slot.maxTotalDurationSec}s`);
    }
  }
}

export function validateMediaInput({ capability, route, input }) {
  const caps = resolveMediaCapabilities(route, capability);
  if (capability === 'image') {
    if (input.aspect && !caps.aspects.includes(input.aspect)) throw new Error(`Model "${route.id}" does not support image aspect ${input.aspect}`);
    if (input.count && !caps.count.includes(input.count)) throw new Error(`Model "${route.id}" does not support generating ${input.count} images at once`);
    return caps;
  }

  if (input.aspect && !caps.aspects.includes(input.aspect)) throw new Error(`Model "${route.id}" does not support video aspect ${input.aspect}`);
  if (input.durationSeconds && !caps.durationSeconds.includes(input.durationSeconds)) throw new Error(`Model "${route.id}" does not support ${input.durationSeconds}s video`);
  if (input.resolution && !caps.resolutions.includes(input.resolution)) throw new Error(`Model "${route.id}" does not support video resolution ${input.resolution}`);
  // Preserve the established error contract for legacy Agent/adapter callers.
  if (input.imagePath && !caps.firstFrame) throw new Error(`Model "${route.id}" does not support a first-frame image`);
  if (input.lastImagePath && !caps.lastFrame) throw new Error(`Model "${route.id}" does not support a last-frame image`);

  const references = normalizedReferences(input);
  const modeId = inferredMode(input, references);
  const mode = caps.modes.find((candidate) => candidate.id === modeId);
  validateReferences(route, mode, references);
  if (!isMediaParameterCombinationAllowed(caps, { ...input, mode: modeId })) {
    throw new Error(`Model "${route.id}" does not support the selected resolution, duration, aspect and mode combination`);
  }
  return caps;
}
