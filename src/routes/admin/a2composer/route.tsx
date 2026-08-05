import { useEffect, useMemo, useState } from 'react';
import { useIntlayer } from 'react-intlayer';
import { createFileRoute } from '@tanstack/react-router';
import { toLocalizedString } from '~/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { AlertTriangle, Check } from 'lucide-react';
import { toast } from 'sonner';
import { requireSystemAdmin } from '~/server/admin.server';
import {
  getA2ComposerStoreFn,
  updateA2ComposerStoreFn,
  generateA2ComposerTemplateFn,
} from '~/server/function/a2composer.server';
import { listAllSkillsFn, getSkillSchemaFn } from '~/server/function/skills.server';
import type { A2ComposerStore, A2Category, A2Template } from '~/lib/a2composer/types';
import type { ExtendedSkillInfo } from '~/claude/skills';
import { extractVariables } from '~/lib/a2composer/template-utils';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Badge } from '~/components/ui/badge';
import { Switch } from '~/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '~/components/ui/command';

export const Route = createFileRoute('/admin/a2composer')({
  loader: async () => {
    await requireSystemAdmin();
    return {};
  },
  component: A2ComposerAdminPage,
});

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function A2ComposerAdminPage() {
  const content = useIntlayer('admin');
  const queryClient = useQueryClient();
  const getStore = useServerFn(getA2ComposerStoreFn);
  const updateStore = useServerFn(updateA2ComposerStoreFn);
  const generateTemplate = useServerFn(generateA2ComposerTemplateFn);
  const listAllSkills = useServerFn(listAllSkillsFn);
  const getSkillSchema = useServerFn(getSkillSchemaFn);
  const { data: storeData, isLoading } = useQuery<A2ComposerStore>({
    queryKey: ['a2composer-store'],
    queryFn: () => getStore(),
  });
  const { data: skillData, isLoading: isLoadingSkills } = useQuery({
    queryKey: ['a2composer-skills'],
    queryFn: () => listAllSkills(),
  });

  const [draft, setDraft] = useState<A2ComposerStore | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<string>('');
  const [activeTemplateId, setActiveTemplateId] = useState<string>('');
  const [localesTextById, setLocalesTextById] = useState<Record<string, string>>({});
  const [localesError, setLocalesError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isGeneratingTemplate, setIsGeneratingTemplate] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  useEffect(() => {
    if (!storeData) return;
    setDraft((prev) => prev ?? storeData);
  }, [storeData]);

  const categories = draft?.categories ?? [];
  const templates = draft?.templates ?? [];
  const skills = useMemo<ExtendedSkillInfo[]>(() => {
    if (!skillData) return [];
    return [...skillData.official, ...skillData.user];
  }, [skillData]);
  const skillGroups = useMemo(() => {
    const sortBySlug = (list: ExtendedSkillInfo[]) =>
      [...list].sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      official: skillData ? sortBySlug(skillData.official) : [],
      user: skillData ? sortBySlug(skillData.user) : [],
    };
  }, [skillData]);
  const skillBySlug = useMemo(() => {
    const map = new Map<string, ExtendedSkillInfo>();
    for (const skill of skills) {
      map.set(skill.slug, skill);
    }
    return map;
  }, [skills]);

  const categoryTemplates = useMemo(() => {
    return templates.filter((tpl) => tpl.categoryId === activeCategoryId);
  }, [templates, activeCategoryId]);

  const activeCategory = useMemo(() => {
    return categories.find((cat) => cat.id === activeCategoryId) ?? categories[0];
  }, [categories, activeCategoryId]);

  const activeTemplate = useMemo(() => {
    if (!activeTemplateId) {
      return categoryTemplates[0];
    }
    return categoryTemplates.find((tpl) => tpl.id === activeTemplateId) ?? categoryTemplates[0];
  }, [categoryTemplates, activeTemplateId]);

  useEffect(() => {
    if (!categories.length) {
      setActiveCategoryId('');
      return;
    }
    if (!activeCategoryId || !categories.some((cat) => cat.id === activeCategoryId)) {
      setActiveCategoryId(categories[0]?.id ?? '');
    }
  }, [activeCategoryId, categories]);

  useEffect(() => {
    if (!activeCategoryId) {
      setActiveTemplateId('');
      return;
    }
    if (categoryTemplates.length === 0) {
      setActiveTemplateId('');
      return;
    }
    if (!activeTemplateId || !categoryTemplates.some((tpl) => tpl.id === activeTemplateId)) {
      setActiveTemplateId(categoryTemplates[0]?.id ?? '');
    }
  }, [activeCategoryId, activeTemplateId, categoryTemplates]);
  const matchedSkill = useMemo(() => {
    if (!activeTemplate?.skillId) return null;
    return skillBySlug.get(activeTemplate.skillId) ?? null;
  }, [activeTemplate, skillBySlug]);
  const templateVariables = useMemo(() => {
    if (!activeTemplate?.template) return [];
    return extractVariables(activeTemplate.template);
  }, [activeTemplate?.template]);
  const activeCategoryTemplateCount = useMemo(() => {
    if (!activeCategory) return 0;
    return templates.filter((tpl) => tpl.categoryId === activeCategory.id).length;
  }, [activeCategory, templates]);
  const canDeleteCategory = Boolean(activeCategory) && activeCategoryTemplateCount === 0;

  const {
    data: schemaData,
    isLoading: isLoadingSchema,
    isError: isSchemaError,
    error: schemaError,
    refetch: refetchSchema,
  } = useQuery({
    queryKey: ['a2composer-skill-schema', activeTemplate?.skillId],
    queryFn: async () => {
      const skillSlug = activeTemplate?.skillId ?? '';
      console.log('[A2Composer] queryFn triggered for skill schema:', {
        skillId: skillSlug,
        templateId: activeTemplate?.id,
      });
      // P1 fix: Use { data: { skillSlug } } pattern for POST server functions
      const result = await getSkillSchema({ data: { skillSlug } });
      console.log('[A2Composer] getSkillSchema result:', {
        skillSlug: result?.skillSlug,
        hasSchema: Boolean(result?.schema),
      });
      return result;
    },
    enabled: Boolean(activeTemplate?.skillId),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const schemaInputs = useMemo(() => schemaData?.schema?.inputs ?? [], [schemaData]);
  const schemaInputsByName = useMemo(() => {
    const map = new Map<string, typeof schemaInputs[number]>();
    for (const field of schemaInputs) {
      map.set(field.name, field);
    }
    return map;
  }, [schemaInputs]);

  useEffect(() => {
    if (!activeTemplate) return;
    setLocalesError(null);
    setLocalesTextById((prev) => {
      if (prev[activeTemplate.id]) return prev;
      const initial = activeTemplate.locales
        ? JSON.stringify(activeTemplate.locales, null, 2)
        : '';
      return { ...prev, [activeTemplate.id]: initial };
    });
  }, [activeTemplate?.id]);

  const updateCategory = (categoryId: string, patch: Partial<A2Category>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        categories: prev.categories.map((cat) =>
          cat.id === categoryId ? { ...cat, ...patch } : cat
        ),
      };
    });
  };

  const addCategory = () => {
    const id = `category-${Date.now()}`;
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        categories: [
          ...prev.categories,
          {
            id,
            label: '新分类',
            description: '请填写描述',
            icon: '🗂️',
          },
        ],
      };
    });
    setActiveCategoryId(id);
    setActiveTemplateId('');
  };

  const deleteCategory = (categoryId: string) => {
    const hasTemplates = templates.some((tpl) => tpl.categoryId === categoryId);
    if (hasTemplates) {
      return;
    }
    setDraft((prev) => {
      if (!prev) return prev;
      const nextCategories = prev.categories.filter((cat) => cat.id !== categoryId);
      const nextTemplates = prev.templates.filter((tpl) => tpl.categoryId !== categoryId);
      return {
        ...prev,
        categories: nextCategories,
        templates: nextTemplates,
      };
    });
    if (activeCategoryId === categoryId) {
      setActiveCategoryId(categories[0]?.id ?? '');
      setActiveTemplateId('');
    }
  };

  const updateTemplate = (templateId: string, patch: Partial<A2Template>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        templates: prev.templates.map((tpl) =>
          tpl.id === templateId ? { ...tpl, ...patch } : tpl
        ),
      };
    });
  };

  const addTemplate = () => {
    if (!activeCategoryId) {
      return;
    }
    const baseId = slugify('new-template');
    const id = `${baseId}-${Date.now()}`;
    const newTemplate: A2Template = {
      id,
      categoryId: activeCategoryId,
      title: '新模板',
      summary: '请填写模板简介',
      template: '请输入模板内容，使用 {{variable}} 作为占位符。',
    };
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        templates: [...prev.templates, newTemplate],
      };
    });
    setActiveTemplateId(id);
  };

  const persistDraft = async (nextDraft: A2ComposerStore) => {
    setIsSaving(true);
    try {
      const saved = await updateStore({ data: nextDraft });
      queryClient.setQueryData(['a2composer-store'], saved);
      setDraft(saved);
      return saved;
    } finally {
      setIsSaving(false);
    }
  };

  const deleteTemplate = async (templateId: string) => {
    if (!draft) return;
    const nextDraft = {
      ...draft,
      templates: draft.templates.filter((tpl) => tpl.id !== templateId),
    };
    try {
      await persistDraft(nextDraft);
      if (activeTemplateId === templateId) {
        setActiveTemplateId('');
      }
      toast.success('模板已删除');
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败';
      toast.error(message);
    }
  };

  const toggleTemplateHidden = async (templateId: string) => {
    if (!draft) return;
    const nextDraft = {
      ...draft,
      templates: draft.templates.map((tpl) =>
        tpl.id === templateId ? { ...tpl, hidden: !tpl.hidden } : tpl
      ),
    };
    try {
      const saved = await persistDraft(nextDraft);
      const current = saved.templates.find((tpl) => tpl.id === templateId);
      toast.success(current?.hidden ? '模板已隐藏' : '模板已显示');
    } catch (error) {
      const message = error instanceof Error ? error.message : '更新失败';
      toast.error(message);
    }
  };

  const handleLocalesChange = (templateId: string, value: string) => {
    setLocalesTextById((prev) => ({ ...prev, [templateId]: value }));
    if (!value.trim()) {
      setLocalesError(null);
      updateTemplate(templateId, { locales: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(value);
      updateTemplate(templateId, { locales: parsed });
      setLocalesError(null);
    } catch (error) {
      setLocalesError(error instanceof Error ? error.message : 'Invalid JSON');
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setIsSaving(true);
    try {
      const saved = await updateStore({ data: draft });
      queryClient.setQueryData(['a2composer-store'], saved);
      setDraft(saved);
    } finally {
      setIsSaving(false);
    }
  };

  const handleGenerateTemplate = async () => {
    if (!activeTemplate?.id) return;
    if (!activeTemplate.skillId) {
      toast.error('请先绑定 Skill 后再生成模板');
      return;
    }
    setIsGeneratingTemplate(true);
    try {
      if (draft) {
        try {
          const saved = await updateStore({ data: draft });
          queryClient.setQueryData(['a2composer-store'], saved);
          setDraft(saved);
        } catch (error) {
          const message = error instanceof Error ? error.message : '保存失败，将继续生成模板';
          toast.message(message);
        }
      }
      const result = await generateTemplate({
        data: {
          templateId: activeTemplate.id,
          skillId: activeTemplate.skillId,
        },
      });
      const nextTemplate = result.template;
      const autoFill = result.autoFill as {
        suggestedId?: string;
        suggestedTitle?: string;
        suggestedSummary?: string;
        suggestedTags?: string[];
        suggestedHint?: string;
      } | undefined;

      // Phase 1 & 2: Auto-fill more fields from schema
      // Only update id if it looks like a default/placeholder (contains timestamp pattern)
      const isDefaultId = /^(new-template|template|category)-\d+$/.test(activeTemplate.id);
      const newId = isDefaultId && autoFill?.suggestedId ? autoFill.suggestedId : nextTemplate.id;

      // Auto-fill title and summary from schema if they are default values
      const isDefaultTitle = activeTemplate.title === '新模板' || activeTemplate.title === '';
      const isDefaultSummary = activeTemplate.summary === '请填写模板简介' || activeTemplate.summary === '';

      // Phase 2: Auto-fill skillHint and skillTags if not set
      const hasNoHint = !activeTemplate.skillHint;
      const hasNoTags = !activeTemplate.skillTags || activeTemplate.skillTags.length === 0;

      updateTemplate(activeTemplate.id, {
        id: newId,
        skillId: nextTemplate.skillId,
        template: nextTemplate.template,
        locales: nextTemplate.locales,
        // Auto-fill title and summary if they are default values
        ...(isDefaultTitle && autoFill?.suggestedTitle ? { title: autoFill.suggestedTitle } : {}),
        ...(isDefaultSummary && autoFill?.suggestedSummary ? { summary: autoFill.suggestedSummary } : {}),
        // Phase 2: Auto-fill skillHint and skillTags
        ...(hasNoHint && autoFill?.suggestedHint ? { skillHint: autoFill.suggestedHint } : {}),
        ...(hasNoTags && autoFill?.suggestedTags?.length ? { skillTags: autoFill.suggestedTags } : {}),
      });

      // If id changed, update the active template id
      if (newId !== activeTemplate.id) {
        setActiveTemplateId(newId);
      }

      setLocalesTextById((prev) => ({
        ...prev,
        [newId]: nextTemplate.locales
          ? JSON.stringify(nextTemplate.locales, null, 2)
          : '',
      }));
      setLocalesError(null);
      const warnings = result.warnings ?? [];
      const storeWarning = warnings.includes('TEMPLATE_NOT_FOUND_IN_STORE');
      const displayWarnings = warnings.filter((item) => item !== 'TEMPLATE_NOT_FOUND_IN_STORE');
      if (storeWarning) {
        toast.message('模板尚未保存，已生成草稿内容');
      }
      if (displayWarnings.length > 0) {
        toast.message(`模板已生成，需检查：${displayWarnings.join('；')}`);
      } else if (!storeWarning) {
        toast.success('模板已生成，已自动填充标题和简介');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '模板生成失败';
      toast.error(message);
    } finally {
      setIsGeneratingTemplate(false);
    }
  };

  if (isLoading || !draft) {
    return (
      <div className="p-6 text-sm text-muted-foreground">加载中...</div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">A2Composer 模板管理</h2>
          <p className="text-sm text-muted-foreground">
            维护泛分类、模板与 Skill 绑定关系（支持软匹配与多语言）。
          </p>
        </div>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? '保存中...' : '保存所有更改'}
        </Button>
      </div>

      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>此模板库当前不被对话端读取</AlertTitle>
        <AlertDescription>
          对话端快捷入口已派生自技能目录。此页保留供未来 per-skill override 模板功能使用。
        </AlertDescription>
      </Alert>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除模板</DialogTitle>
            <DialogDescription>
              删除后无法恢复，请确认是否继续。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
              取消
            </Button>
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => {
                if (!activeTemplate) return;
                setIsDeleteDialogOpen(false);
                void deleteTemplate(activeTemplate.id);
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 lg:grid-cols-[260px_320px_1fr]">
        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">分类列表</div>
              <Button size="sm" variant="outline" onClick={addCategory}>
                新增分类
              </Button>
            </div>
            <div className="space-y-2">
              {categories.map((category) => {
                const isActive = category.id === activeCategoryId;
                return (
                  <button
                    key={category.id}
                    type="button"
                    className={[
                      'w-full rounded-lg border px-3 py-2 text-left transition',
                      isActive ? 'border-primary/60 bg-muted/30' : 'hover:border-muted-foreground/50',
                      category.hidden ? 'opacity-60' : '',
                    ].join(' ')}
                    onClick={() => setActiveCategoryId(category.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{category.icon ?? '🗂️'}</span>
                        <div>
                          <div className="text-sm font-medium">{category.label}</div>
                          <div className="text-xs text-muted-foreground">{category.description}</div>
                        </div>
                      </div>
                      {category.hidden && <Badge variant="outline">隐藏</Badge>}
                    </div>
                  </button>
                );
              })}
              {categories.length === 0 && (
                <div className="text-sm text-muted-foreground">暂无分类，请先创建。</div>
              )}
            </div>
          </div>

          {activeCategory && (
            <div className="rounded-xl border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">分类设置</div>
                <Badge variant="outline">ID: {activeCategory.id}</Badge>
              </div>
              <div className="grid gap-3">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">图标</span>
                  <Input
                    value={activeCategory.icon ?? ''}
                    onChange={(event) => updateCategory(activeCategory.id, { icon: event.target.value })}
                    className="w-20 text-center"
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">分类名称</span>
                  <Input
                    value={activeCategory.label}
                    onChange={(event) => updateCategory(activeCategory.id, { label: event.target.value })}
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">分类描述</span>
                  <Textarea
                    value={activeCategory.description}
                    onChange={(event) => updateCategory(activeCategory.id, { description: event.target.value })}
                    rows={3}
                  />
                </label>
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div className="text-xs text-muted-foreground">隐藏该分类</div>
                  <Switch
                    checked={Boolean(activeCategory.hidden)}
                    onCheckedChange={(checked) => updateCategory(activeCategory.id, { hidden: checked })}
                  />
                </div>
                <div className="space-y-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canDeleteCategory}
                    onClick={() => deleteCategory(activeCategory.id)}
                  >
                    删除分类
                  </Button>
                  {!canDeleteCategory && (
                    <div className="text-xs text-muted-foreground">
                      该分类下仍有模板，需先清空模板后才能删除。
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">模板列表</div>
              <Button
                size="sm"
                variant="outline"
                onClick={addTemplate}
                disabled={!activeCategoryId}
              >
                新增模板
              </Button>
            </div>

            {!activeCategory && (
              <div className="mt-3 text-sm text-muted-foreground">请先选择或创建分类。</div>
            )}

            {activeCategory && categoryTemplates.length === 0 && (
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                <div>该分类暂无模板。</div>
                <Button size="sm" variant="secondary" onClick={addTemplate}>
                  立即新增模板
                </Button>
              </div>
            )}

            {activeCategory && categoryTemplates.length > 0 && (
              <div className="mt-3 space-y-2">
                {categoryTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={[
                      'w-full rounded-lg border px-3 py-2 text-left transition',
                      template.id === activeTemplate?.id ? 'border-primary/60 bg-muted/30' : 'hover:border-muted-foreground/50',
                      template.hidden ? 'opacity-60' : '',
                    ].join(' ')}
                    onClick={() => setActiveTemplateId(template.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">{template.title}</div>
                        <div className="text-xs text-muted-foreground">{template.summary}</div>
                        {template.skillId && (
                          <Badge variant="secondary" className="mt-1">绑定: {template.skillId}</Badge>
                        )}
                      </div>
                      {template.hidden && <Badge variant="outline">隐藏</Badge>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {activeTemplate ? (
            <div key={activeTemplate.id} className="rounded-xl border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">模板编辑</div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleGenerateTemplate}
                    disabled={!activeTemplate.skillId || isGeneratingTemplate}
                  >
                    {isGeneratingTemplate ? '生成中...' : '生成模板（AI）'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toggleTemplateHidden(activeTemplate.id)}
                  >
                    {activeTemplate.hidden ? '取消隐藏' : '隐藏模板'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    onClick={() => setIsDeleteDialogOpen(true)}
                  >
                    删除模板
                  </Button>
                </div>
              </div>
              {!activeTemplate.skillId && (
                <div className="text-xs text-amber-600">
                  先绑定 Skill 后才能生成模板。
                </div>
              )}


              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">ID</span>
                  <Input
                    value={activeTemplate.id}
                    onChange={(event) => updateTemplate(activeTemplate.id, { id: event.target.value })}
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">分类 ID</span>
                  <Input
                    value={activeTemplate.categoryId}
                    onChange={(event) => updateTemplate(activeTemplate.id, { categoryId: event.target.value })}
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">标题</span>
                  <Input
                    value={activeTemplate.title}
                    onChange={(event) => updateTemplate(activeTemplate.id, { title: event.target.value })}
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">简介</span>
                  <Input
                    value={activeTemplate.summary}
                    onChange={(event) => updateTemplate(activeTemplate.id, { summary: event.target.value })}
                  />
                </label>
              </div>

              <label className="space-y-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">模板内容</span>
                <Textarea
                  value={activeTemplate.template}
                  onChange={(event) => updateTemplate(activeTemplate.id, { template: event.target.value })}
                  rows={6}
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">绑定 Skill ID（可选）</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={activeTemplate.skillId ?? ''}
                      placeholder={toLocalizedString(content.a2composer.skillSlugPlaceholder)}
                      onChange={(event) => updateTemplate(activeTemplate.id, {
                        skillId: event.target.value || undefined,
                      })}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setIsSkillPickerOpen(true)}
                      disabled={!skills.length && isLoadingSkills}
                    >
                      选择技能
                    </Button>
                  </div>
                  {activeTemplate.skillId && matchedSkill && (
                    <div className="text-xs text-muted-foreground">
                      已匹配：{matchedSkill.name} ({matchedSkill.slug})
                    </div>
                  )}
                  {activeTemplate.skillId && !matchedSkill && !isLoadingSkills && (
                    <div className="text-xs text-amber-600">未找到该技能（可手动录入）</div>
                  )}
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Skill Hint（可选）</span>
                  <Input
                    value={activeTemplate.skillHint ?? ''}
                    onChange={(event) => updateTemplate(activeTemplate.id, {
                      skillHint: event.target.value || undefined,
                    })}
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                  <span className="font-medium text-foreground">Skill Tags（逗号分隔）</span>
                  <Input
                    value={activeTemplate.skillTags?.join(', ') ?? ''}
                    onChange={(event) => {
                      const tags = event.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean);
                      updateTemplate(activeTemplate.id, { skillTags: tags.length ? tags : undefined });
                    }}
                  />
                </label>
              </div>

              {activeTemplate.skillId && (
                <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Schema 字段预览</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => refetchSchema()}
                      disabled={isLoadingSchema}
                    >
                      {isLoadingSchema ? '加载中…' : '刷新'}
                    </Button>
                  </div>

                  <div className="text-xs text-muted-foreground">
                    绑定技能：{activeTemplate.skillId}
                  </div>

                  {isLoadingSchema && (
                    <div className="text-xs text-muted-foreground">正在读取 schema…</div>
                  )}

                  {isSchemaError && (
                    <div className="text-xs text-red-600">
                      读取 schema 失败：{schemaError instanceof Error ? schemaError.message : '未知错误'}
                    </div>
                  )}

                  {!isLoadingSchema && !isSchemaError && !schemaData?.schema && (
                    <div className="text-xs text-amber-600">
                      未读取到 schema（请确认 skills store 路径与 slug 是否正确）
                    </div>
                  )}

                  {!isLoadingSchema && schemaData?.schema && (
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground">
                        共 {schemaInputs.length} 个字段
                      </div>
                      <div className="grid gap-2">
                        {schemaInputs.length === 0 && (
                          <div className="text-xs text-muted-foreground">无输入字段</div>
                        )}
                        {schemaInputs.map((field) => (
                          <div key={field.name} className="rounded-md border bg-background px-3 py-2 text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{field.name}</span>
                              <Badge variant="secondary">{field.type}</Badge>
                              {field.required && (
                                <span className="text-red-500">必填</span>
                              )}
                            </div>
                            {field.label && (
                              <div className="text-muted-foreground">标签：{field.label}</div>
                            )}
                            {field.description && (
                              <div className="text-muted-foreground">说明：{field.description}</div>
                            )}
                            {field.options && field.options.length > 0 && (
                              <div className="text-muted-foreground">
                                选项：{field.options.map((opt) => {
                                  if (typeof opt === 'string') return opt;
                                  return opt.label ?? opt.value ?? '';
                                }).filter(Boolean).join(' / ')}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {templateVariables.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium">模板占位符</div>
                      <div className="flex flex-wrap gap-2">
                        {templateVariables.map((variable) => {
                          const hasSchema = schemaInputsByName.has(variable);
                          return (
                            <Badge key={variable} variant={hasSchema ? 'secondary' : 'destructive'}>
                              {variable}
                            </Badge>
                          );
                        })}
                      </div>
                      {schemaInputs.length > 0 && (
                        <div className="text-xs text-muted-foreground">
                          未匹配的占位符会在前端退化为普通输入框。
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <label className="space-y-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">多语言 locales（JSON，可选）</span>
                <Textarea
                  value={localesTextById[activeTemplate.id] ?? ''}
                  onChange={(event) => handleLocalesChange(activeTemplate.id, event.target.value)}
                  rows={5}
                  placeholder='{"en":{"title":"...","summary":"...","template":"..."}}'
                />
                {localesError && (
                  <span className="text-xs text-red-500">{localesError}</span>
                )}
              </label>
            </div>
          ) : (
            <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
              {activeCategory ? '该分类暂无模板，请先创建模板。' : '请选择分类后开始编辑模板。'}
            </div>
          )}
        </div>
      </div>

      {activeTemplate && (
        <CommandDialog
          open={isSkillPickerOpen}
          onOpenChange={setIsSkillPickerOpen}
          title="选择技能"
          description="搜索并选择一个技能作为绑定"
        >
          <CommandInput placeholder={toLocalizedString(content.a2composer.skillSearchPlaceholder)} />
          <CommandList>
            {isLoadingSkills && (
              <CommandEmpty>加载中...</CommandEmpty>
            )}
            {!isLoadingSkills && (
              <>
                <CommandEmpty>未找到技能</CommandEmpty>
                <CommandGroup heading="官方技能">
                  {skillGroups.official.map((skill) => (
                    <CommandItem
                      key={skill.slug}
                      value={`${skill.slug} ${skill.name} ${skill.description ?? ''}`}
                      onSelect={() => {
                        updateTemplate(activeTemplate.id, { skillId: skill.slug });
                        setIsSkillPickerOpen(false);
                      }}
                    >
                      <div className="flex w-full items-center justify-between gap-3">
                        <div className="space-y-0.5">
                          <div className="text-sm">{skill.name}</div>
                          <div className="text-xs text-muted-foreground">{skill.slug}</div>
                        </div>
                        {activeTemplate.skillId === skill.slug && (
                          <Check className="h-4 w-4 text-primary" />
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="用户技能">
                  {skillGroups.user.map((skill) => (
                    <CommandItem
                      key={skill.slug}
                      value={`${skill.slug} ${skill.name} ${skill.description ?? ''}`}
                      onSelect={() => {
                        updateTemplate(activeTemplate.id, { skillId: skill.slug });
                        setIsSkillPickerOpen(false);
                      }}
                    >
                      <div className="flex w-full items-center justify-between gap-3">
                        <div className="space-y-0.5">
                          <div className="text-sm">{skill.name}</div>
                          <div className="text-xs text-muted-foreground">{skill.slug}</div>
                        </div>
                        {activeTemplate.skillId === skill.slug && (
                          <Check className="h-4 w-4 text-primary" />
                        )}
                      </div>
                    </CommandItem>
                  ))}
                  {skillGroups.user.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">暂无用户技能</div>
                  )}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </CommandDialog>
      )}
    </div>
  );
}
