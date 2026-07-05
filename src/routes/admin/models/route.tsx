/**
 * Admin · Models (registry v2) — unified model + capability management.
 *
 * Catalog-first connections (pick a provider, paste an API key — sealed into the DB
 * via KIN_SECRET_KEY), per-capability default slots with per-project overrides,
 * immediate connection tests, capability-tagged models, health board. Legacy env
 * (tokenEnv) connections keep working and show their env status.
 * Admin access enforced by the parent /admin loader + every server fn.
 */

import { useMemo, useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { toast } from 'sonner';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  listRegistryAdminFn,
  listProjectsAdminFn,
  setModelEnabledFn,
  setDefaultSlotFn,
  setConnectionCredentialFn,
  testConnectionFn,
  reprobeModelsFn,
  upsertConnectionFn,
  deleteConnectionFn,
  upsertModelFn,
  deleteModelFn,
} from '~/server/function/models-admin.server';
import type { ModelCapability } from '~/server/models/registry';
import { Button } from '~/components/ui/button';
import { DefaultsPanel } from '~/components/admin/models/defaults-panel';
import { AddConnectionForm, type AddConnectionSubmit } from '~/components/admin/models/add-connection-form';
import { ConnectionSection, type TestResult } from '~/components/admin/models/connection-section';

export const Route = createFileRoute('/admin/models')({
  loader: async () => {
    const [registry, projects] = await Promise.all([listRegistryAdminFn(), listProjectsAdminFn()]);
    return { registry, projects };
  },
  component: AdminModelsPage,
});

function AdminModelsPage() {
  const { registry, projects } = Route.useLoaderData();
  const { connections, models, defaults, catalog, secretKeyConfigured } = registry;
  const router = useRouter();

  const setEnabled = useServerFn(setModelEnabledFn);
  const setSlot = useServerFn(setDefaultSlotFn);
  const setCredential = useServerFn(setConnectionCredentialFn);
  const testConn = useServerFn(testConnectionFn);
  const reprobe = useServerFn(reprobeModelsFn);
  const upsertConn = useServerFn(upsertConnectionFn);
  const delConn = useServerFn(deleteConnectionFn);
  const upsertMdl = useServerFn(upsertModelFn);
  const delMdl = useServerFn(deleteModelFn);

  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const modelsByConn = useMemo(() => {
    const map = new Map<string, typeof models>();
    for (const m of models) {
      const list = map.get(m.connectionId) ?? [];
      list.push(m);
      map.set(m.connectionId, list);
    }
    return map;
  }, [models]);

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

  const handleAddConnection = (data: AddConnectionSubmit) =>
    run(
      'add-conn',
      async () => {
        await upsertConn({ data: data.connection });
        if (data.credential) {
          await setCredential({ data: { id: data.connection.id, credential: data.credential } });
        }
        for (const m of data.models) {
          await upsertMdl({ data: { ...m, connectionId: data.connection.id } });
        }
        setShowAdd(false);
      },
      '连接已创建',
    );

  const handleTest = async (id: string): Promise<TestResult | null> => {
    setBusy(`test-${id}`);
    try {
      return (await testConn({ data: { connectionId: id } })) as TestResult;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '测试失败');
      return null;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">模型管理</h1>
          <p className="text-sm text-muted-foreground">
            对话 / 识图 / 生图 / 生视频 / 向量 统一在此配置。API key 在界面粘贴、加密保存，无需改 .env、无需重启。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? '收起' : '连接模型服务'}
          </Button>
          <Button variant="outline" size="sm" disabled={busy === 'all'} onClick={() => run('all', () => reprobe({ data: {} }), '已触发全部重测')}>
            {busy === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            全部重测
          </Button>
        </div>
      </div>

      {showAdd && (
        <AddConnectionForm
          catalog={catalog}
          secretKeyConfigured={secretKeyConfigured}
          busy={busy === 'add-conn'}
          onSubmit={handleAddConnection}
        />
      )}

      {models.length > 0 && (
        <DefaultsPanel
          models={models}
          defaults={defaults}
          projects={projects}
          busy={busy === 'slot'}
          onSet={(capability: ModelCapability, modelId, projectId) =>
            run('slot', () => setSlot({ data: { capability, modelId, projectId } }), '默认已更新')}
        />
      )}

      {connections.length === 0 && !showAdd && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          还没有连接任何模型服务。点右上「连接模型服务」，选择服务商并粘贴 API key 即可开始。
        </div>
      )}

      {connections.map((conn) => (
        <ConnectionSection
          key={conn.id}
          conn={conn}
          models={modelsByConn.get(conn.id) ?? []}
          busy={busy}
          secretKeyConfigured={secretKeyConfigured}
          onSaveCredential={(id, credential) =>
            run(`cred-${id}`, () => setCredential({ data: { id, credential } }), credential ? '密钥已保存' : '密钥已清除')}
          onTest={handleTest}
          onDeleteConn={(id) => run(id, () => delConn({ data: { id } }), '连接已删除')}
          onToggleModel={(id, enabled) => run(id, () => setEnabled({ data: { id, enabled } }), enabled ? '已启用' : '已停用')}
          onReprobe={(modelId) => run(modelId, () => reprobe({ data: { modelId } }), '已触发重测')}
          onDeleteModel={(id) => run(id, () => delMdl({ data: { id } }), '模型已删除')}
          onAddModel={(m) => run('add-model', () => upsertMdl({ data: m }), '模型已添加')}
        />
      ))}
    </div>
  );
}
