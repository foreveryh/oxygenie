/**
 * Connection section (registry v2) — one card per connection: credential status
 * (DB mask / env name / missing) + paste-to-replace, immediate "测试连接", and the
 * connection's model rows (enable / capabilities / re-probe / delete) with an
 * inline add-model form. Rendered from connections (not model groups) so fresh,
 * model-less catalog adds stay visible.
 */

import { useState } from 'react';
import { Loader2, RefreshCw, Star, Trash2 } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Switch } from '~/components/ui/switch';
import { Input } from '~/components/ui/input';
import type { AdminConnectionRow, AdminModelRow, ModelCapability } from '~/server/models/registry';
import type { ModelMediaConfig } from '~/db/schema/model.schema';
import { CAPABILITY_LABELS, CAPABILITIES } from './defaults-panel';

const HEALTH_STYLE: Record<AdminModelRow['health'], string> = {
  healthy: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  unhealthy: 'bg-red-500/15 text-red-600 border-red-500/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};

function fmtWhen(d: Date | string | null): string {
  if (!d) return '从未';
  const t = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString();
}

export type TestResult = { health: 'healthy' | 'unhealthy'; probeError: string | null; latencyMs: number };

type Props = {
  conn: AdminConnectionRow;
  models: AdminModelRow[];
  busy: string | null;
  secretKeyConfigured: boolean;
  onSaveCredential: (id: string, credential: string | null) => Promise<void>;
  onTest: (id: string) => Promise<TestResult | null>;
  onDeleteConn: (id: string) => void;
  onToggleModel: (id: string, enabled: boolean) => void;
  onReprobe: (modelId: string) => void;
  onDeleteModel: (id: string) => void;
  onAddModel: (m: {
    id: string;
    label: string;
    connectionId: string;
    model: string;
    capabilities: ModelCapability[];
    mediaAdapter?: string | null;
    mediaConfig?: ModelMediaConfig;
  }) => void;
};

export function ConnectionSection({
  conn, models, busy, secretKeyConfigured,
  onSaveCredential, onTest, onDeleteConn, onToggleModel, onReprobe, onDeleteModel, onAddModel,
}: Props) {
  const [credInput, setCredInput] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [mForm, setMForm] = useState({
    model: '',
    label: '',
    caps: new Set<ModelCapability>(conn.protocol === 'anthropic' ? ['chat'] : []),
    mediaAdapter: '',
    mediaConfig: '{}',
  });

  const credBadge =
    conn.credentialSource === 'db' ? (
      <Badge variant="outline" className="text-emerald-600">密钥 {conn.credentialMask ?? '••••'} ✓</Badge>
    ) : conn.credentialSource === 'env' ? (
      <Badge variant="outline" className="text-emerald-600">env:{conn.tokenEnv} ✓</Badge>
    ) : (
      <Badge variant="outline" className="text-red-600">未配置密钥</Badge>
    );

  return (
    <div className="mb-6 rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
        <span className="font-semibold text-foreground">{conn.label}</span>
        <span className="text-muted-foreground">{conn.baseUrl}</span>
        <Badge variant="outline">{conn.protocol}</Badge>
        {credBadge}
        {testResult && (
          <Badge variant="outline" className={testResult.health === 'healthy' ? 'text-emerald-600' : 'text-red-600'}>
            {testResult.health === 'healthy' ? `连接正常 · ${testResult.latencyMs}ms` : `失败: ${testResult.probeError}`}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={busy === `test-${conn.id}`}
            onClick={async () => setTestResult(await onTest(conn.id))}
          >
            {busy === `test-${conn.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : '测试连接'}
          </Button>
          <Button
            variant="ghost" size="sm" className="text-red-600" disabled={busy === conn.id}
            onClick={() => { if (confirm(`删除连接「${conn.label}」及其所有模型？`)) onDeleteConn(conn.id); }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {secretKeyConfigured && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <Input
            type="password"
            autoComplete="off"
            className="h-8 max-w-md text-xs"
            placeholder={conn.credentialSource === 'db' ? '粘贴新 API key 以替换…' : '粘贴 API key（加密保存）…'}
            value={credInput}
            onChange={(e) => setCredInput(e.target.value)}
          />
          <Button
            size="sm" variant="outline" disabled={!credInput.trim() || busy === `cred-${conn.id}`}
            onClick={async () => { await onSaveCredential(conn.id, credInput.trim()); setCredInput(''); }}
          >
            保存密钥
          </Button>
          {conn.credentialSource === 'db' && (
            <Button
              size="sm" variant="ghost" className="text-red-600" disabled={busy === `cred-${conn.id}`}
              onClick={() => { if (confirm('清除已保存的密钥？（若配置了 tokenEnv 将回退到 env）')) void onSaveCredential(conn.id, null); }}
            >
              清除
            </Button>
          )}
        </div>
      )}

      <div className="divide-y">
        {models.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-40 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{m.label}</span>
                {m.isDefault && <Badge className="gap-1"><Star className="h-3 w-3" />默认</Badge>}
                {m.capabilities.map((c) => <Badge key={c} variant="secondary">{CAPABILITY_LABELS[c]}</Badge>)}
                {m.mediaAdapter && <Badge variant="outline">adapter:{m.mediaAdapter}</Badge>}
                {m.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{m.id} · {m.model}</div>
            </div>

            <div className="min-w-44 text-[11px] text-muted-foreground">
              <Badge variant="outline" className={HEALTH_STYLE[m.health]}>{m.health}</Badge>
              {m.probeError && <span className="ml-1 text-red-600">{m.probeError}</span>}
              <div className="mt-0.5">探活: {fmtWhen(m.lastProbeAt)}{m.latencyMs != null ? ` · ${m.latencyMs}ms` : ''}</div>
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch checked={m.enabled} disabled={busy === m.id} onCheckedChange={(v) => onToggleModel(m.id, v)} />
                启用
              </label>
              <Button variant="ghost" size="sm" disabled={busy === m.id} onClick={() => onReprobe(m.id)}>
                {busy === m.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost" size="sm" className="text-red-600" disabled={busy === m.id}
                onClick={() => { if (confirm(`删除模型「${m.label}」？`)) onDeleteModel(m.id); }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}

        <div className="px-4 py-2">
          {showAdd ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!mForm.model.trim()) return;
                if (mForm.caps.size === 0) {
                  alert('请至少选择一个模型能力');
                  return;
                }
                let mediaConfig: ModelMediaConfig = {};
                try {
                  const parsed = JSON.parse(mForm.mediaConfig || '{}');
                  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('必须是 JSON 对象');
                  mediaConfig = parsed as ModelMediaConfig;
                } catch (error) {
                  alert(`Adapter 配置无效：${error instanceof Error ? error.message : String(error)}`);
                  return;
                }
                onAddModel({
                  id: `${conn.id}/${mForm.model.trim()}`,
                  label: mForm.label.trim() || mForm.model.trim(),
                  connectionId: conn.id,
                  model: mForm.model.trim(),
                  capabilities: [...mForm.caps],
                  mediaAdapter: mForm.mediaAdapter.trim() || null,
                  mediaConfig,
                });
                setMForm({
                  model: '',
                  label: '',
                  caps: new Set<ModelCapability>(conn.protocol === 'anthropic' ? ['chat'] : []),
                  mediaAdapter: '',
                  mediaConfig: '{}',
                });
                setShowAdd(false);
              }}
            >
              <Input required className="h-8 w-44 text-xs" placeholder="模型串（服务商认的）" value={mForm.model} onChange={(e) => setMForm({ ...mForm, model: e.target.value })} />
              <Input className="h-8 w-36 text-xs" placeholder="显示名（可选）" value={mForm.label} onChange={(e) => setMForm({ ...mForm, label: e.target.value })} />
              <Input
                className="h-8 w-40 text-xs"
                placeholder="Media adapter（如 google-veo）"
                value={mForm.mediaAdapter}
                onChange={(e) => setMForm({ ...mForm, mediaAdapter: e.target.value })}
              />
              <Input
                className="h-8 w-44 font-mono text-xs"
                placeholder='Adapter JSON（默认 {}）'
                value={mForm.mediaConfig}
                onChange={(e) => setMForm({ ...mForm, mediaConfig: e.target.value })}
              />
              {CAPABILITIES.map((c) => (
                <label key={c} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={mForm.caps.has(c)}
                    onChange={(e) => {
                      const caps = new Set(mForm.caps);
                      if (e.target.checked) caps.add(c);
                      else caps.delete(c);
                      setMForm({ ...mForm, caps });
                    }}
                  />
                  {CAPABILITY_LABELS[c]}
                </label>
              ))}
              <Button type="submit" size="sm" variant="outline">添加</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)}>取消</Button>
            </form>
          ) : (
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setShowAdd(true)}>
              + 添加模型
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
