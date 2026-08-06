'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Truck, CheckCircle2, Trash2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
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
import { useTranslations } from 'next-intl';

const MASKED_KEY = '••••••••••••••••';

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
  const [templateName, setTemplateName] = useState('');
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
        setTemplateName(data.notify_template_name ?? '');
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

  const keyPayload = () => (keyEdited ? integrationKey.trim() : undefined);

  const buildBody = () => ({
    integration_key: keyPayload(),
    is_active: isActive,
    notify_customers_enabled: notifyEnabled,
    notify_template_name: templateName.trim() || null,
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
        setTemplateName('');
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

            <div className="space-y-2">
              <Label htmlFor="dropi-template">{t('templateName')}</Label>
              <p className="text-xs text-muted-foreground">{t('templateNameDesc')}</p>
              <Input
                id="dropi-template"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder={t('templateNamePlaceholder')}
                disabled={disabled || !notifyEnabled}
              />
            </div>
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
