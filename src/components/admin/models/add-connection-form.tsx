/**
 * Add-connection form (registry v2) — catalog-first UX for non-technical admins:
 * pick a provider → baseUrl/protocol/auth prefill → paste the API key → tick the
 * suggested models. Custom entries fall back to manual base URL. Submission is
 * orchestrated by the route (connection → credential → models, then invalidate).
 */

import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Input } from '~/components/ui/input';
import type { CatalogProvider } from '~/server/models/provider-catalog';
import type { ModelCapability } from '~/server/models/registry';
import type { ModelMediaConfig } from '~/db/schema/model.schema';
import { CAPABILITY_LABELS } from './defaults-panel';

export type AddConnectionSubmit = {
  connection: {
    id: string;
    label: string;
    baseUrl: string;
    authStyle: 'bearer' | 'x-api-key';
    protocol: CatalogProvider['protocol'];
    aliasHaiku?: string | null;
  };
  credential: string | null;
  models: Array<{
    id: string;
    label: string;
    model: string;
    capabilities: ModelCapability[];
    mediaAdapter?: string | null;
    mediaConfig?: ModelMediaConfig;
  }>;
};

type Props = {
  catalog: CatalogProvider[];
  secretKeyConfigured: boolean;
  busy: boolean;
  onSubmit: (data: AddConnectionSubmit) => void;
};

export function AddConnectionForm({ catalog, secretKeyConfigured, busy, onSubmit }: Props) {
  const [slug, setSlug] = useState('');
  const provider = catalog.find((p) => p.slug === slug);
  const [connId, setConnId] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [aliasHaiku, setAliasHaiku] = useState('');
  const [checkedModels, setCheckedModels] = useState<Set<string>>(new Set());

  const pick = (nextSlug: string) => {
    setSlug(nextSlug);
    const p = catalog.find((x) => x.slug === nextSlug);
    if (p) {
      setConnId(p.slug);
      setLabel(p.label.split('（')[0]);
      setBaseUrl(p.baseUrl ?? '');
      setCheckedModels(new Set(p.knownModels.map((m) => m.model)));
    }
  };

  if (!secretKeyConfigured) {
    return (
      <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
        服务器尚未配置 <code>KIN_SECRET_KEY</code>（凭据加密主密钥），无法在界面中保存 API key。
        部署时生成一次即可：<code>openssl rand -hex 32</code> 写入部署环境变量后重启。
        在此之前仍可用旧方式（连接的 tokenEnv 指向 .env 变量名）。
      </div>
    );
  }

  return (
    <form
      className="mb-6 space-y-3 rounded-lg border bg-muted/20 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!provider || !connId || !baseUrl) return;
        onSubmit({
          connection: {
            id: connId.trim(),
            label: label.trim() || provider.label,
            baseUrl: baseUrl.trim(),
            authStyle: provider.authStyle,
            protocol: provider.protocol,
            aliasHaiku: aliasHaiku.trim() || null,
          },
          credential: credential.trim() || null,
          models: provider.knownModels
            .filter((m) => checkedModels.has(m.model))
            .map((m) => ({
              id: `${connId.trim()}/${m.model}`,
              label: m.label,
              model: m.model,
              capabilities: m.capabilities,
              mediaAdapter: m.mediaAdapter,
              mediaConfig: m.mediaConfig,
            })),
        });
      }}
    >
      <div className="text-xs font-semibold">连接模型服务（选择服务商 → 粘贴 API key）</div>

      <select
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={slug}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="">选择服务商…</option>
        {catalog.map((p) => (
          <option key={p.slug} value={p.slug}>{p.label}</option>
        ))}
      </select>

      {provider && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{provider.protocol}</Badge>
            {provider.protocol === 'anthropic'
              ? <Badge variant="outline" className="text-emerald-600">可作对话（Agent）模型</Badge>
              : <Badge variant="outline">仅生成/识别/向量类能力</Badge>}
            {provider.keyUrl && (
              <a className="underline" href={provider.keyUrl} target="_blank" rel="noreferrer">获取 API key ↗</a>
            )}
            {provider.note && <span>{provider.note}</span>}
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <Input required placeholder="连接 ID（唯一，如 openai）" value={connId} onChange={(e) => setConnId(e.target.value)} />
            <Input required placeholder="显示名" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <Input
            required
            placeholder="Base URL"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="off"
            placeholder="API key（加密保存，仅显示尾四位；也可留空稍后再填）"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          />
          {provider.protocol === 'anthropic' && (
            <Input
              placeholder="aliasHaiku（可选：后台/廉价档模型串，如 doubao-seed-2.0-lite）"
              value={aliasHaiku}
              onChange={(e) => setAliasHaiku(e.target.value)}
            />
          )}

          {provider.knownModels.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">常用模型（参考建议，可后续增删）：</div>
              <div className="flex flex-wrap gap-3">
                {provider.knownModels.map((m) => (
                  <label key={m.model} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={checkedModels.has(m.model)}
                      onChange={(e) => {
                        const next = new Set(checkedModels);
                        if (e.target.checked) next.add(m.model);
                        else next.delete(m.model);
                        setCheckedModels(next);
                      }}
                    />
                    {m.label}
                    <span className="text-muted-foreground">({m.capabilities.map((c) => CAPABILITY_LABELS[c]).join('/')})</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <Button type="submit" size="sm" disabled={busy}>创建连接</Button>
        </>
      )}
    </form>
  );
}
