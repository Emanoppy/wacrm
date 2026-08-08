'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Search, Loader2, Package, RefreshCw, Settings, History } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface OrderRow {
  id: string;
  dropi_order_id: string;
  customer_name: string | null;
  customer_surname: string | null;
  city: string | null;
  status: string;
  total_order: number | null;
  currency: string | null;
  shipping_company: string | null;
  dropi_created_at: string | null;
}

interface OrderDetail extends OrderRow {
  customer_phone: string | null;
  address: string | null;
  state: string | null;
  shipping_amount: number | null;
  shop_order_id: string | null;
  shop_order_number: number | null;
  raw: {
    orderdetails?: Array<{
      product: { name: string; sku: string | null };
      quantity: number;
    }>;
  } | null;
}

interface DropiConfigRow {
  is_active: boolean;
  last_synced_at: string | null;
}

// Status → badge color. Falls back to a neutral style for any Dropi
// status we haven't specifically mapped (Dropi's vocabulary isn't a
// closed enum — see migration 037).
const STATUS_STYLES: Record<string, string> = {
  'PENDIENTE CONFIRMACION': 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  GUIA_GENERADA: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  ENTREGADO: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  CANCELADO: 'bg-red-500/10 text-red-600 border-red-500/30',
  DEVOLUCION: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
};

function statusBadgeClass(status: string): string {
  return STATUS_STYLES[status] ?? 'bg-muted text-muted-foreground border-border';
}

export default function OrdersPage() {
  const t = useTranslations('Orders.page');
  const supabase = createClient();

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [config, setConfig] = useState<DropiConfigRow | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchConfig = useCallback(async () => {
    const { data } = await supabase
      .from('dropi_config')
      .select('is_active, last_synced_at')
      .maybeSingle();
    setConfig(data ?? null);
  }, [supabase]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('orders')
      .select(
        'id, dropi_order_id, customer_name, customer_surname, city, status, total_order, currency, shipping_company, dropi_created_at'
      )
      .order('dropi_created_at', { ascending: false, nullsFirst: false })
      .limit(200);

    if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }
    const term = search.trim();
    if (term) {
      const like = `%${term}%`;
      query = query.or(
        `customer_name.ilike.${like},customer_surname.ilike.${like},city.ilike.${like},dropi_order_id.ilike.${like}`
      );
    }

    const { data, error } = await query;
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    setOrders(data ?? []);
    setStatuses((prev) => {
      const seen = new Set(prev);
      (data ?? []).forEach((o) => seen.add(o.status));
      return [...seen].sort();
    });
    setLoading(false);
  }, [supabase, search, statusFilter]);

  const fetchDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      const { data, error } = await supabase
        .from('orders')
        .select(
          'id, dropi_order_id, customer_name, customer_surname, customer_phone, address, city, state, status, total_order, currency, shipping_amount, shipping_company, shop_order_id, shop_order_number, dropi_created_at, raw'
        )
        .eq('id', id)
        .single();
      if (error) {
        toast.error(error.message);
        setDetail(null);
      } else {
        setDetail(data as OrderDetail);
      }
      setDetailLoading(false);
    },
    [supabase]
  );

  useEffect(() => {
    if (detailId) fetchDetail(detailId);
  }, [detailId, fetchDetail]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      const res = await fetch('/api/dropi/sync', { method: 'POST' });
      const body = await res.json();
      // The route always answers 200 (it's a background-style sync, not
      // a request that should 500 on a Dropi-side failure) — a failed
      // Dropi call surfaces as `body.error` instead of a bad status
      // code. Checking only `res.ok` let this fail completely silently.
      if (!res.ok) throw new Error(body.error || 'Sync failed');
      if (body.error) throw new Error(body.error);
      await Promise.all([fetchOrders(), fetchConfig()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function handleBackfill() {
    setBackfilling(true);
    try {
      const res = await fetch('/api/dropi/backfill', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Import failed');
      if (body.error) throw new Error(body.error);
      toast.success(t('backfillSuccess', { count: body.fetched ?? 0 }));
      await Promise.all([fetchOrders(), fetchConfig()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBackfilling(false);
    }
  }

  // `config` is `undefined` only until the initial fetchConfig()
  // resolves. Without this guard, an account that has never connected
  // Dropi briefly renders the search/filter/table (with a spinner)
  // instead of the "not connected" prompt during that first fetch.
  const configLoading = config === undefined;
  const notConfigured = !configLoading && config === null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {orders.length > 0
              ? t('subtitle', { count: orders.length })
              : t('subtitleZero')}
          </p>
        </div>
        {config?.is_active && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {config.last_synced_at
                ? t('lastSynced', {
                    time: new Date(config.last_synced_at).toLocaleString(),
                  })
                : t('neverSynced')}
            </span>
            <Button
              variant="outline"
              onClick={handleBackfill}
              disabled={backfilling || syncing}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {backfilling ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <History className="size-4" />
              )}
              {backfilling ? t('backfilling') : t('backfillBtn')}
            </Button>
            <Button
              variant="outline"
              onClick={handleSyncNow}
              disabled={syncing || backfilling}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {syncing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {syncing ? t('syncing') : t('syncNowBtn')}
            </Button>
          </div>
        )}
      </div>

      {configLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : notConfigured ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
          <Package className="size-8 text-muted-foreground" />
          <p className="font-medium text-foreground">{t('notConfiguredTitle')}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t('notConfiguredDesc')}
          </p>
          <Button
            render={<Link href="/settings" />}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Settings className="size-4" />
            {t('goToSettings')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value ?? 'all')}
            >
              <SelectTrigger className="w-full sm:w-56 border-border bg-card text-foreground">
                <SelectValue placeholder={t('statusFilterLabel')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allStatuses')}</SelectItem>
                {statuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">
                    {t('tableColumns.dropiOrderId')}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t('tableColumns.customer')}
                  </TableHead>
                  <TableHead className="text-muted-foreground hidden md:table-cell">
                    {t('tableColumns.city')}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t('tableColumns.status')}
                  </TableHead>
                  <TableHead className="text-muted-foreground">
                    {t('tableColumns.total')}
                  </TableHead>
                  <TableHead className="text-muted-foreground hidden lg:table-cell">
                    {t('tableColumns.carrier')}
                  </TableHead>
                  <TableHead className="text-muted-foreground hidden lg:table-cell">
                    {t('tableColumns.createdAt')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow className="border-border">
                    <TableCell colSpan={7} className="text-center py-12">
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="size-6 animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">{t('loading')}</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : orders.length === 0 ? (
                  <TableRow className="border-border">
                    <TableCell colSpan={7} className="text-center py-12">
                      <div className="flex flex-col items-center gap-2">
                        <Package className="size-8 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                          {search.trim() || statusFilter !== 'all'
                            ? t('noOrdersMatch')
                            : t('noOrdersYet')}
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  orders.map((order) => (
                    <TableRow
                      key={order.id}
                      className="border-border hover:bg-muted/50 cursor-pointer"
                      onClick={() => setDetailId(order.id)}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {order.dropi_order_id}
                      </TableCell>
                      <TableCell className="text-foreground font-medium">
                        {[order.customer_name, order.customer_surname]
                          .filter(Boolean)
                          .join(' ') || '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden md:table-cell text-sm">
                        {order.city || '-'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(order.status)}`}
                        >
                          {order.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-foreground text-sm">
                        {order.total_order != null
                          ? `${order.currency ?? 'COP'} ${order.total_order.toLocaleString()}`
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden lg:table-cell text-sm">
                        {order.shipping_company || '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden lg:table-cell text-xs">
                        {order.dropi_created_at
                          ? new Date(order.dropi_created_at).toLocaleString()
                          : '-'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <Sheet
        open={detailId != null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null);
            setDetail(null);
          }
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t('detail.title')}</SheetTitle>
            <SheetDescription>
              {detail ? `#${detail.dropi_order_id}` : ''}
            </SheetDescription>
          </SheetHeader>

          {detailLoading || !detail ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="space-y-5 px-4 pb-6">
              <span
                className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(detail.status)}`}
              >
                {detail.status}
              </span>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('detail.customer')}
                </p>
                <p className="text-sm text-foreground">
                  {[detail.customer_name, detail.customer_surname]
                    .filter(Boolean)
                    .join(' ') || '-'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {detail.customer_phone || '-'}
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('detail.address')}
                </p>
                <p className="text-sm text-foreground">{detail.address || '-'}</p>
                <p className="text-sm text-muted-foreground">
                  {[detail.city, detail.state].filter(Boolean).join(', ') || '-'}
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('detail.products')}
                </p>
                {detail.raw?.orderdetails && detail.raw.orderdetails.length > 0 ? (
                  <ul className="space-y-1">
                    {detail.raw.orderdetails.map((line, i) => (
                      <li key={i} className="text-sm text-foreground">
                        {line.quantity}× {line.product?.name ?? '-'}
                        {line.product?.sku ? (
                          <span className="text-muted-foreground"> ({line.product.sku})</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">-</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('detail.total')}
                  </p>
                  <p className="text-sm text-foreground">
                    {detail.total_order != null
                      ? `${detail.currency ?? 'COP'} ${detail.total_order.toLocaleString()}`
                      : '-'}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('detail.shipping')}
                  </p>
                  <p className="text-sm text-foreground">
                    {detail.shipping_amount != null
                      ? `${detail.currency ?? 'COP'} ${detail.shipping_amount.toLocaleString()}`
                      : '-'}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('detail.carrier')}
                  </p>
                  <p className="text-sm text-foreground">
                    {detail.shipping_company || '-'}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('detail.createdAt')}
                  </p>
                  <p className="text-sm text-foreground">
                    {detail.dropi_created_at
                      ? new Date(detail.dropi_created_at).toLocaleString()
                      : '-'}
                  </p>
                </div>
              </div>

              <div className="space-y-1 border-t border-border pt-4">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('detail.shopOrder')}
                </p>
                <p className="text-sm text-muted-foreground">
                  {[detail.shop_order_number, detail.shop_order_id]
                    .filter(Boolean)
                    .join(' — ') || '-'}
                </p>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
