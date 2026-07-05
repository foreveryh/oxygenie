/**
 * Admin · Global variables (registry v2) — env-style variables/secrets managed in
 * the UI instead of `.env`: API keys for MCP servers / skills / external tools.
 * Values are sealed at rest (KIN_SECRET_KEY) and injected into the agent worker env
 * at spawn when 注入 is on. Secrets display masked; the sandboxed bash the model
 * drives does NOT inherit these (minimal env by design).
 */

import { useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import {
  listGlobalVarsFn,
  upsertGlobalVarFn,
  deleteGlobalVarFn,
} from '~/server/function/global-vars.server';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Switch } from '~/components/ui/switch';
import { Input } from '~/components/ui/input';

export const Route = createFileRoute('/admin/variables')({
  loader: async () => await listGlobalVarsFn(),
  component: AdminVariablesPage,
});

const emptyForm = { key: '', value: '', description: '', isSecret: true, injectWorker: true };

function AdminVariablesPage() {
  const { vars, secretKeyConfigured } = Route.useLoaderData();
  const router = useRouter();
  const upsert = useServerFn(upsertGlobalVarFn);
  const del = useServerFn(deleteGlobalVarFn);

  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const run = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    try {
      await fn();
      await router.invalidate();
      toast.success(okMsg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">全局变量</h1>
        <p className="text-sm text-muted-foreground">
          MCP / 工具 / 技能需要的 API key 与环境变量在此配置（加密保存）。开启「注入」后，新会话的
          Agent 运行环境即可读取——无需改 .env、无需重启。模型服务的 key 请在「Models」页配置。
        </p>
      </div>

      {!secretKeyConfigured ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          服务器尚未配置 <code>KIN_SECRET_KEY</code>（加密主密钥），无法保存变量。
          部署时生成一次即可：<code>openssl rand -hex 32</code> 写入部署环境变量后重启。
        </div>
      ) : (
        <>
          <form
            className="mb-6 space-y-2 rounded-lg border bg-muted/20 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                'form',
                () =>
                  upsert({
                    data: {
                      key: form.key.trim(),
                      value: form.value,
                      description: form.description.trim() || null,
                      isSecret: form.isSecret,
                      injectWorker: form.injectWorker,
                    },
                  }),
                '变量已保存',
              ).then(() => setForm({ ...emptyForm }));
            }}
          >
            <div className="text-xs font-semibold">新增 / 更新变量</div>
            <div className="grid gap-2 md:grid-cols-2">
              <Input required placeholder="变量名，如 TAVILY_API_KEY（大写+下划线）" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} />
              <Input required={!vars.some((v) => v.key === form.key.trim())} type={form.isSecret ? 'password' : 'text'} autoComplete="off" placeholder="值（更新已有变量时留空=保持原值）" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            </div>
            <Input placeholder="备注（可选）：给谁用的、去哪申请" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <label className="flex items-center gap-1.5">
                <Switch checked={form.isSecret} onCheckedChange={(v) => setForm({ ...form, isSecret: v })} />
                按秘密处理（界面只显示尾四位）
              </label>
              <label className="flex items-center gap-1.5">
                <Switch checked={form.injectWorker} onCheckedChange={(v) => setForm({ ...form, injectWorker: v })} />
                注入 Agent 运行环境
              </label>
              <Button type="submit" size="sm" disabled={busy === 'form'} className="ml-auto">保存</Button>
            </div>
          </form>

          {vars.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              暂无变量。例如把 <code>TAVILY_API_KEY</code> 配在这里，Agent 里的搜索类 MCP 即可直接使用。
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {vars.map((v) => (
                <div key={v.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-48 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium">{v.key}</span>
                      {v.isSecret && <Badge variant="secondary">秘密</Badge>}
                      {!v.injectWorker && <Badge variant="outline">不注入</Badge>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      <span className="font-mono">{v.display}</span>
                      {v.description ? ` · ${v.description}` : ''}
                    </div>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch
                      checked={v.injectWorker}
                      disabled={busy === v.key}
                      onCheckedChange={(injectWorker) =>
                        run(v.key, () => upsert({ data: { key: v.key, injectWorker } }), injectWorker ? '已开启注入' : '已关闭注入')}
                    />
                    注入
                  </label>
                  <Button
                    variant="ghost" size="sm" className="text-red-600" disabled={busy === v.key}
                    onClick={() => { if (confirm(`删除变量「${v.key}」？`)) void run(v.key, () => del({ data: { key: v.key } }), '变量已删除'); }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
