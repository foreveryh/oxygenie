/**
 * Defaults panel (registry v2) — per-capability default slots: one global row of
 * pickers + a per-project override table (Owner decision: projects may override,
 * e.g. a canvas project uses image model A while others use B).
 *
 * Eligibility is enforced twice: options are filtered here for UX, and
 * setDefaultModelFor re-validates server-side (chat → anthropic protocol only).
 */

import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import type { AdminModelRow, DefaultSlotRow, ModelCapability } from '~/server/models/registry';

export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  chat: '对话（Agent）',
  vision: '识图（VLM）',
  image: '生图',
  video: '生视频',
  embedding: '向量',
};

// Client-safe capability list (registry.ts is server-only — don't value-import it here).
export const CAPABILITIES = Object.keys(CAPABILITY_LABELS) as ModelCapability[];

type Props = {
  models: AdminModelRow[];
  defaults: DefaultSlotRow[];
  projects: Array<{ id: string; name: string }>;
  busy: boolean;
  onSet: (capability: ModelCapability, modelId: string | null, projectId: string | null) => void;
};

function eligibleModels(models: AdminModelRow[], capability: ModelCapability): AdminModelRow[] {
  return models.filter(
    (m) => m.enabled && m.capabilities.includes(capability) && (capability !== 'chat' || m.protocol === 'anthropic'),
  );
}

export function DefaultsPanel({ models, defaults, projects, busy, onSet }: Props) {
  const globalSlots = new Map(defaults.filter((d) => !d.projectId).map((d) => [d.capability, d.modelId]));
  const overrides = defaults.filter((d) => d.projectId);
  const [ovForm, setOvForm] = useState({ projectId: '', capability: 'image' as ModelCapability, modelId: '' });

  return (
    <div className="mb-6 rounded-lg border">
      <div className="border-b bg-muted/40 px-4 py-2 text-xs font-semibold">默认模型（按能力）</div>

      <div className="grid gap-3 p-4 md:grid-cols-2 lg:grid-cols-3">
        {CAPABILITIES.map((cap) => {
          const options = eligibleModels(models, cap);
          const current = globalSlots.get(cap) ?? '';
          return (
            <label key={cap} className="space-y-1 text-xs">
              <span className="flex items-center gap-1 text-muted-foreground">
                {CAPABILITY_LABELS[cap]}
                {cap === 'chat' && <Badge variant="outline" className="text-[10px]">仅 Anthropic 兼容</Badge>}
              </span>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={current}
                disabled={busy}
                onChange={(e) => onSet(cap, e.target.value || null, null)}
              >
                <option value="">{options.length ? '未设置（自动选首个可用）' : '（无可用模型）'}</option>
                {options.map((m) => (
                  <option key={m.id} value={m.id}>{m.label} · {m.connectionLabel}</option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      <div className="border-t px-4 py-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">项目覆盖（项目内优先于全局默认）</div>
        {overrides.length > 0 && (
          <div className="mb-3 space-y-1">
            {overrides.map((o) => (
              <div key={`${o.capability}:${o.projectId}`} className="flex items-center gap-2 text-xs">
                <Badge variant="secondary">{o.projectName ?? o.projectId}</Badge>
                <span className="text-muted-foreground">{CAPABILITY_LABELS[o.capability]}</span>
                <span>→ {o.modelLabel}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-red-600"
                  disabled={busy}
                  onClick={() => onSet(o.capability, null, o.projectId)}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ovForm.projectId && ovForm.modelId) {
              onSet(ovForm.capability, ovForm.modelId, ovForm.projectId);
              setOvForm({ ...ovForm, modelId: '' });
            }
          }}
        >
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={ovForm.projectId}
            onChange={(e) => setOvForm({ ...ovForm, projectId: e.target.value })}
          >
            <option value="">选择项目…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={ovForm.capability}
            onChange={(e) => setOvForm({ ...ovForm, capability: e.target.value as ModelCapability, modelId: '' })}
          >
            {CAPABILITIES.map((c) => (
              <option key={c} value={c}>{CAPABILITY_LABELS[c]}</option>
            ))}
          </select>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={ovForm.modelId}
            onChange={(e) => setOvForm({ ...ovForm, modelId: e.target.value })}
          >
            <option value="">选择模型…</option>
            {eligibleModels(models, ovForm.capability).map((m) => (
              <option key={m.id} value={m.id}>{m.label} · {m.connectionLabel}</option>
            ))}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !ovForm.projectId || !ovForm.modelId}>
            添加覆盖
          </Button>
        </form>
      </div>
    </div>
  );
}
