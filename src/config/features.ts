/**
 * Feature Toggle Configuration
 *
 * Controls which features are visible in the navigation.
 * Set to false to hide features temporarily, but keep the code for future use.
 */

export const FEATURE_CONFIG = {
  // Section 1: Claude Agent SDK
  claudeChat: true,       // Claude Chat page - enabled
  projects: true,         // Projects (项目 + 最近) IA - enabled
  skills: true,           // Skills Store page - enabled
  mcpStore: true,         // MCP Store page - enabled

  // Section 2: Other
  documents: true,        // Documents / KB page - enabled
  ocr: true,              // OCR 文字识别 standalone converter (OCR module O2) - enabled
  canvas: true,           // 画布 Agent (D5: independent top-level entity, not a Project) - enabled
  dashboard: false,       // Dashboards page - hidden

  // Cloud features (navClouds section)
  capture: false,          // Capture feature - hidden
  proposal: false,         // Proposal feature - hidden
  prompts: false,          // Prompts feature - hidden
} as const;

export type FeatureKey = keyof typeof FEATURE_CONFIG;

/**
 * Check if a feature is enabled
 */
export function isFeatureEnabled(feature: FeatureKey): boolean {
  return FEATURE_CONFIG[feature] === true;
}

/**
 * Get enabled features
 */
export function getEnabledFeatures(): FeatureKey[] {
  return Object.keys(FEATURE_CONFIG).filter(
    (key) => FEATURE_CONFIG[key as FeatureKey] === true
  ) as FeatureKey[];
}
