'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, GitBranch } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Suggested by ROADMAP.md Fase 5 — display names for the auto-created
// pipeline's columns. These are just labels the account can rename
// later in Pipelines; the real link to Dropi's status text lives in
// dropi_config.status_stage_map, not in these names.
const DEFAULT_STAGES = [
  { name: 'Confirmación', color: '#3b82f6' },
  { name: 'Actualizando datos', color: '#eab308' },
  { name: 'Guía generada', color: '#8b5cf6' },
  { name: 'En reparto', color: '#f97316' },
  { name: 'Entregado', color: '#22c55e' },
  { name: 'Cancelado', color: '#ef4444' },
  { name: 'Novedad', color: '#64748b' },
];

// Best-effort starting guess so the mapping table isn't blank the
// first time — reviewed/adjustable before saving, never trusted
// silently. Matched by substring against Dropi's real status text
// (case-insensitive), which isn't a fixed vocabulary (confirmed
// against the live account repeatedly across this project).
const HEURISTICS: { test: RegExp; stageName: string }[] = [
  { test: /cancel/i, stageName: 'Cancelado' },
  { test: /devol|novedad/i, stageName: 'Novedad' },
  { test: /entrega/i, stageName: 'Entregado' },
  { test: /reparto/i, stageName: 'En reparto' },
  { test: /guia/i, stageName: 'Guía generada' },
  { test: /pendiente|confirma/i, stageName: 'Confirmación' },
];

interface StageOption {
  id: string;
  name: string;
}

interface DropiPipelineConfigProps {
  pipelineId: string | null;
  statusStageMap: Record<string, string>;
  onChange: (pipelineId: string, statusStageMap: Record<string, string>) => void;
  disabled: boolean;
}

export function DropiPipelineConfig({
  pipelineId,
  statusStageMap,
  onChange,
  disabled,
}: DropiPipelineConfigProps) {
  const t = useTranslations('Settings.dropiConfig');
  const { accountId } = useAuth();
  const supabase = createClient();

  const [creating, setCreating] = useState(false);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [orderStatuses, setOrderStatuses] = useState<string[]>([]);
  const [loadingMapData, setLoadingMapData] = useState(false);

  const loadMapData = useCallback(async () => {
    if (!pipelineId) return;
    setLoadingMapData(true);
    const [stagesRes, ordersRes] = await Promise.all([
      supabase.from('pipeline_stages').select('id, name').eq('pipeline_id', pipelineId).order('position'),
      supabase.from('orders').select('status').limit(500),
    ]);
    setStages((stagesRes.data as StageOption[]) ?? []);
    const seen = new Set<string>();
    ((ordersRes.data as { status: string }[] | null) ?? []).forEach((o) => seen.add(o.status));
    setOrderStatuses([...seen].sort());
    setLoadingMapData(false);
  }, [pipelineId, supabase]);

  useEffect(() => {
    void loadMapData();
  }, [loadMapData]);

  async function handleCreatePipeline() {
    if (!accountId) return;
    setCreating(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('not signed in');

      const { data: pipeline, error: pipelineErr } = await supabase
        .from('pipelines')
        .insert({ user_id: user.id, account_id: accountId, name: t('pipelineName') })
        .select('id')
        .single();
      if (pipelineErr || !pipeline) throw pipelineErr ?? new Error('insert failed');

      const stagesPayload = DEFAULT_STAGES.map((s, i) => ({
        pipeline_id: pipeline.id,
        name: s.name,
        color: s.color,
        position: i,
      }));
      const { data: newStages, error: stagesErr } = await supabase
        .from('pipeline_stages')
        .insert(stagesPayload)
        .select('id, name');
      if (stagesErr) throw stagesErr;

      const { data: ordersData } = await supabase.from('orders').select('status').limit(500);
      const seenStatuses = new Set<string>();
      (ordersData ?? []).forEach((o: { status: string }) => seenStatuses.add(o.status));

      const stageByName = new Map((newStages ?? []).map((s) => [s.name, s.id as string]));
      const guessedMap: Record<string, string> = {};
      for (const status of seenStatuses) {
        const match = HEURISTICS.find((h) => h.test.test(status));
        const stageId = match ? stageByName.get(match.stageName) : undefined;
        if (stageId) guessedMap[status] = stageId;
      }

      setStages((newStages as StageOption[]) ?? []);
      setOrderStatuses([...seenStatuses].sort());
      onChange(pipeline.id, guessedMap);
      toast.success(t('pipelineCreated'));
    } catch (err) {
      console.error('[dropi-pipeline-config] create pipeline failed:', err);
      toast.error(t('pipelineCreateFailed'));
    } finally {
      setCreating(false);
    }
  }

  const UNMAPPED = '__unmapped__';

  return (
    <div className="space-y-4">
      {!pipelineId ? (
        <Button onClick={handleCreatePipeline} disabled={disabled || creating} variant="outline">
          {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <GitBranch className="mr-2 h-4 w-4" />
          {t('createPipelineBtn')}
        </Button>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t('pipelineLinked')}{' '}
            <Link href="/pipelines" className="text-primary hover:underline">
              {t('viewPipeline')}
            </Link>
          </p>

          {loadingMapData ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : orderStatuses.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('mappingNoOrdersYet')}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('mappingHint')}</p>
              {orderStatuses.map((status) => (
                <div key={status} className="flex items-center gap-2">
                  <span className="w-48 shrink-0 truncate text-xs text-foreground" title={status}>
                    {status}
                  </span>
                  <Select
                    value={statusStageMap[status] ?? UNMAPPED}
                    onValueChange={(v) => {
                      const next = { ...statusStageMap };
                      if (v === UNMAPPED || !v) delete next[status];
                      else next[status] = v;
                      onChange(pipelineId, next);
                    }}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-8 flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNMAPPED}>{t('mappingUnmapped')}</SelectItem>
                      {stages.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
