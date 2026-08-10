'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Truck, CheckCircle2, Trash2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { DropiPipelineConfig } from './dropi-pipeline-config';
import { useTranslations } from 'next-intl';

const MASKED_KEY = '••••••••••••••••';

/**
 * Toggle-pill picker built from the account's OWN observed order
 * statuses (same query pattern as DropiPipelineConfig's mapping table)
 * instead of a free-text field — typing "Entregado" by hand when Dropi
 * actually sends "ENTREGADO" silently breaks confirmation/delivery
 * rates, the profit calc, and never-notify with no error shown
 * anywhere, so picking from real values removes that failure mode.
 */
function StatusMultiSelect({
  statuses,
  selected,
  onChange,
  disabled,
  emptyLabel,
}: {
  statuses: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  emptyLabel: string;
}) {
  if (statuses.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  const selectedSet = new Set(selected);
  return (
    <div className="flex flex-wrap gap-2">
      {statuses.map((status) => {
        const checked = selectedSet.has(status);
        return (
          <button
            key={status}
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange(
                checked ? selected.filter((s) => s !== status) : [...selected, status],
              )
            }
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              checked
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-foreground/40',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            {status}
          </button>
        );
      })}
    </div>
  );
}

export function DropiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.dropiConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [integrationKey, setIntegrationKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [syncBatchSize, setSyncBatchSize] = useState(50);
  const [neverNotifyStatuses, setNeverNotifyStatuses] = useState<string[]>([]);
  const [confirmedStatuses, setConfirmedStatuses] = useState<string[]>([]);
  const [deliveredStatuses, setDeliveredStatuses] = useState<string[]>([]);
  const [lostStatuses, setLostStatuses] = useState<string[]>([]);
  const [orderStatuses, setOrderStatuses] = useState<string[]>([]);
  const [loadingOrderStatuses, setLoadingOrderStatuses] = useState(false);
  const [defaultShippingCost, setDefaultShippingCost] = useState('');
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [statusStageMap, setStatusStageMap] = useState<Record<string, string>>({});
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/dropi/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setIsActive(data.is_active);
        setNotifyEnabled(data.notify_customers_enabled);
        setSyncBatchSize(data.sync_batch_size ?? 50);
        setNeverNotifyStatuses(data.never_notify_statuses ?? []);
        setConfirmedStatuses(data.confirmed_statuses ?? []);
        setDeliveredStatuses(data.delivered_statuses ?? []);
        setLostStatuses(data.lost_statuses ?? []);
        setDefaultShippingCost(
          data.default_shipping_cost != null ? String(data.default_shipping_cost) : '',
        );
        setPipelineId(data.pipeline_id ?? null);
        setStatusStageMap(data.status_stage_map ?? {});
        setLastSyncedAt(data.last_synced_at ?? null);
        setHasStoredKey(Boolean(data.has_key));
        setIntegrationKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  // Real observed statuses from this account's own synced orders — same
  // query pattern as DropiPipelineConfig's mapping table — so the
  // never-notify/confirmed/delivered pickers below offer exact values
  // instead of requiring the user to type Dropi's status text by hand.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoadingOrderStatuses(true);
    const supabase = createClient();
    (async () => {
      try {
        const { data } = await supabase.from('orders').select('status').limit(500);
        if (cancelled) return;
        const seen = new Set<string>();
        ((data as { status: string }[] | null) ?? []).forEach((o) => seen.add(o.status));
        setOrderStatuses([...seen].sort());
      } finally {
        if (!cancelled) setLoadingOrderStatuses(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const keyPayload = () => (keyEdited ? integrationKey.trim() : undefined);

  const buildBody = () => ({
    integration_key: keyPayload(),
    is_active: isActive,
    notify_customers_enabled: notifyEnabled,
    sync_batch_size: syncBatchSize,
    never_notify_statuses: neverNotifyStatuses,
    confirmed_statuses: confirmedStatuses,
    delivered_statuses: deliveredStatuses,
    lost_statuses: lostStatuses,
    default_shipping_cost: defaultShippingCost.trim() ? Number(defaultShippingCost) : null,
    pipeline_id: pipelineId,
    status_stage_map: statusStageMap,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/dropi/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration_key: keyPayload() }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess', { count: data.departmentCount }));
      else toast.error(data.error ?? t('testRejected'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!configured && !keyEdited) {
      toast.error(t('missingKey'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/dropi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/dropi/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasStoredKey(false);
        setIntegrationKey('');
        setKeyEdited(false);
        setIsActive(false);
        setNotifyEnabled(false);
        setSyncBatchSize(50);
        setNeverNotifyStatuses([]);
        setConfirmedStatuses([]);
        setDeliveredStatuses([]);
        setLostStatuses([]);
        setDefaultShippingCost('');
        setPipelineId(null);
        setStatusStageMap({});
        setLastSyncedAt(null);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4 text-primary" /> {t('connection')}
            </CardTitle>
            <CardDescription>{t('encryptionNotice')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dropi-key">{t('integrationKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="dropi-key"
                    type={showKey ? 'text' : 'password'}
                    value={integrationKey}
                    onChange={(e) => {
                      setIntegrationKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setIntegrationKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={t('integrationKeyPlaceholder')}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testConnection')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('keyHint')}</p>
            </div>

            {lastSyncedAt && (
              <p className="text-xs text-muted-foreground">
                {t('lastSynced', { time: new Date(lastSyncedAt).toLocaleString() })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>{t('behaviourDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('enableSync')}
                </p>
                <p className="text-xs text-muted-foreground">{t('enableSyncDesc')}</p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('enableNotify')}
                </p>
                <p className="text-xs text-muted-foreground">{t('enableNotifyDesc')}</p>
              </div>
              <Switch
                checked={notifyEnabled}
                onCheckedChange={setNotifyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            {notifyEnabled && (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t('automationsHint')}{' '}
                <Link href="/automations" className="text-primary hover:underline">
                  {t('automationsLink')}
                </Link>
              </p>
            )}

            <div className="space-y-2">
              <Label>{t('neverNotifyStatuses')}</Label>
              <p className="text-xs text-muted-foreground">{t('neverNotifyStatusesDesc')}</p>
              <StatusMultiSelect
                statuses={orderStatuses}
                selected={neverNotifyStatuses}
                onChange={setNeverNotifyStatuses}
                disabled={disabled || !notifyEnabled}
                emptyLabel={loadingOrderStatuses ? t('loading') : t('mappingNoOrdersYet')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dropi-batch-size">{t('syncBatchSize')}</Label>
              <p className="text-xs text-muted-foreground">{t('syncBatchSizeDesc')}</p>
              <Input
                id="dropi-batch-size"
                type="number"
                min={10}
                max={500}
                value={syncBatchSize}
                onChange={(e) =>
                  setSyncBatchSize(Math.min(500, Math.max(10, Number(e.target.value) || 50)))
                }
                disabled={disabled}
                className="w-28"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboardSection')}</CardTitle>
            <CardDescription>{t('dashboardSectionDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('confirmedStatuses')}</Label>
              <p className="text-xs text-muted-foreground">{t('confirmedStatusesDesc')}</p>
              <StatusMultiSelect
                statuses={orderStatuses}
                selected={confirmedStatuses}
                onChange={setConfirmedStatuses}
                disabled={disabled}
                emptyLabel={loadingOrderStatuses ? t('loading') : t('mappingNoOrdersYet')}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('deliveredStatuses')}</Label>
              <p className="text-xs text-muted-foreground">{t('deliveredStatusesDesc')}</p>
              <StatusMultiSelect
                statuses={orderStatuses}
                selected={deliveredStatuses}
                onChange={setDeliveredStatuses}
                disabled={disabled}
                emptyLabel={loadingOrderStatuses ? t('loading') : t('mappingNoOrdersYet')}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('lostStatuses')}</Label>
              <p className="text-xs text-muted-foreground">{t('lostStatusesDesc')}</p>
              <StatusMultiSelect
                statuses={orderStatuses}
                selected={lostStatuses}
                onChange={setLostStatuses}
                disabled={disabled}
                emptyLabel={loadingOrderStatuses ? t('loading') : t('mappingNoOrdersYet')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dropi-shipping">{t('defaultShippingCost')}</Label>
              <p className="text-xs text-muted-foreground">{t('defaultShippingCostDesc')}</p>
              <Input
                id="dropi-shipping"
                type="number"
                value={defaultShippingCost}
                onChange={(e) => setDefaultShippingCost(e.target.value)}
                placeholder={t('defaultShippingCostPlaceholder')}
                disabled={disabled}
                className="w-36"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('pipelineSection')}</CardTitle>
            <CardDescription>{t('pipelineSectionDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <DropiPipelineConfig
              pipelineId={pipelineId}
              statusStageMap={statusStageMap}
              onChange={(id, map) => {
                setPipelineId(id);
                setStatusStageMap(map);
              }}
              disabled={disabled}
            />
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
