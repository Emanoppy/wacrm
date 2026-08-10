"use client"

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import {
  MessageSquare,
  UserPlus,
  DollarSign,
  Send,
  Package,
  CheckCircle2,
  Truck,
  TrendingUp,
} from 'lucide-react'
import Link from 'next/link'

import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadOrderStats,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  OrderStatsSummary,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { OrderStatsChart } from '@/components/dashboard/order-stats-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

import { useTranslations } from 'next-intl'

type RangeDays = 7 | 30 | 90

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  const { defaultCurrency } = useAuth()
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)

  const [range, setRange] = useState<RangeDays>(30)
  // Keep a cache per range so switching tabs doesn't re-fetch what we
  // already have. Ranges the user hasn't opened yet stay null and
  // trigger a fetch on first view.
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null)
  const [pipelineLoading, setPipelineLoading] = useState(true)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)

  // Order stats only render when Dropi is connected — null means
  // "not checked yet", false means "checked, not connected".
  const [dropiActive, setDropiActive] = useState<boolean | null>(null)
  const [orderStats, setOrderStats] = useState<Record<RangeDays, OrderStatsSummary | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [orderStatsLoading, setOrderStatsLoading] = useState(true)

  const loadAll = useCallback(() => {
    const db = createClient()

    // Kick everything off in parallel. Each block has its own
    // setState + finally so a slow query doesn't hold up faster
    // sections — each widget shows its own skeleton independently.
    void loadMetrics(db)
      .then((m) => setMetrics(m))
      .catch((err) => console.error('[dashboard] metrics failed:', err))
      .finally(() => setMetricsLoading(false))

    void loadConversationsSeries(db, 30)
      .then((s) => setSeries((prev) => ({ ...prev, 30: s })))
      .catch((err) => console.error('[dashboard] series failed:', err))
      .finally(() => setSeriesLoading(false))

    void loadPipelineDonut(db)
      .then((p) => setPipeline(p))
      .catch((err) => console.error('[dashboard] pipeline failed:', err))
      .finally(() => setPipelineLoading(false))

    void loadResponseTime(db)
      .then((r) => setResponseTime(r))
      .catch((err) => console.error('[dashboard] response time failed:', err))
      .finally(() => setResponseTimeLoading(false))

    // Fetch up to 50 so the biggest page-size option in the feed
    // (50 rows) is already in memory — switching sizes then becomes
    // a pure client-side slice with no extra round trip.
    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => console.error('[dashboard] activity failed:', err))
      .finally(() => setActivityLoading(false))

    void (async () => {
      let active = false
      try {
        const { data } = await db.from('dropi_config').select('is_active').maybeSingle()
        active = Boolean(data?.is_active)
      } catch (err) {
        console.error('[dashboard] dropi config check failed:', err)
      }
      setDropiActive(active)
      if (!active) {
        setOrderStatsLoading(false)
        return
      }
      try {
        const s = await loadOrderStats(db, 30)
        setOrderStats((prev) => ({ ...prev, 30: s }))
      } catch (err) {
        console.error('[dashboard] order stats failed:', err)
      } finally {
        setOrderStatsLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Range switch handler — kept in an event callback (not an effect)
  // so the setState calls stay out of the react-hooks/set-state-in-effect
  // rule's way. The cached bucket check means switching back to a
  // previously-viewed range is instant and doesn't re-fetch.
  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      const db = createClient()
      if (series[r] === null) {
        setSeriesLoading(true)
        loadConversationsSeries(db, r)
          .then((s) => setSeries((prev) => ({ ...prev, [r]: s })))
          .catch((err) => console.error('[dashboard] series failed:', err))
          .finally(() => setSeriesLoading(false))
      }
      if (dropiActive && orderStats[r] === null) {
        setOrderStatsLoading(true)
        loadOrderStats(db, r)
          .then((s) => setOrderStats((prev) => ({ ...prev, [r]: s })))
          .catch((err) => console.error('[dashboard] order stats failed:', err))
          .finally(() => setOrderStatsLoading(false))
      }
    },
    [series, orderStats, dropiActive],
  )

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('description')}
        </p>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('activeConversations')}
              value={metrics.activeConversations.current.toLocaleString()}
              icon={MessageSquare}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(
                  metrics.activeConversations.previous, 
                  t('newTodayVsYesterday'), 
                  t('noChange', { suffix: t('newTodayVsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('newContactsToday')}
              value={metrics.newContactsToday.current.toLocaleString()}
              icon={UserPlus}
              delta={{
                sign:
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                label: deltaLabel(
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('openDealsValue')}
              value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
              icon={DollarSign}
              subtitle={t('openDeals', { count: metrics.openDealsCount })}
            />
            <MetricCard
              title={t('messagesSentToday')}
              value={metrics.messagesSentToday.current.toLocaleString()}
              icon={Send}
              delta={{
                sign:
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                label: deltaLabel(
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
          </>
        )}
      </div>

      {/* Quick actions */}
      <QuickActions />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full lg:col-span-3">
          <ConversationsChart
            series={series}
            loading={seriesLoading}
            range={range}
            onRangeChange={handleRangeChange}
          />
        </div>
        <div className="h-full lg:col-span-2">
          <PipelineDonut
            data={pipeline}
            loading={pipelineLoading}
            currency={defaultCurrency}
          />
        </div>
      </div>

      {/* Response time */}
      <ResponseTimeChart data={responseTime} loading={responseTimeLoading} />

      {/* Order stats (Dropi) — only rendered once we know the account
          has sync turned on; omitted entirely otherwise rather than
          showing an empty/misleading logistics section. */}
      {dropiActive && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {orderStatsLoading || !orderStats[range] ? (
              Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
            ) : (
              <>
                <MetricCard
                  title={t('newOrders')}
                  value={orderStats[range]!.totalOrders.toLocaleString()}
                  icon={Package}
                  subtitle={t('rangeDays', { count: range })}
                />
                <MetricCard
                  title={t('confirmationRate')}
                  value={formatRate(orderStats[range]!.confirmationRate)}
                  icon={CheckCircle2}
                  subtitle={t('confirmedOf', {
                    confirmed: orderStats[range]!.confirmedOrders,
                    total: orderStats[range]!.totalOrders,
                  })}
                />
                <MetricCard
                  title={t('deliveryRate')}
                  value={formatRate(orderStats[range]!.deliveryRate)}
                  icon={Truck}
                  subtitle={t('deliveredOf', {
                    delivered: orderStats[range]!.deliveredOrders,
                    confirmed: orderStats[range]!.confirmedOrders,
                  })}
                />
                <MetricCard
                  title={t('estimatedProfit')}
                  value={formatCurrency(orderStats[range]!.estimatedProfit, defaultCurrency)}
                  icon={TrendingUp}
                  subtitle={
                    orderStats[range]!.ordersWithUnknownCost > 0
                      ? t('unknownCostWarning', { count: orderStats[range]!.ordersWithUnknownCost })
                      : orderStats[range]!.deliveredOrders > 0
                        ? t('profitBasisDelivered', { count: orderStats[range]!.deliveredOrders })
                        : t('profitBasisUnconfigured')
                  }
                />
              </>
            )}
          </div>
          {orderStats[range] && orderStats[range]!.ordersWithUnknownCost > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('unknownCostHint', { count: orderStats[range]!.ordersWithUnknownCost })}{' '}
              <Link href="/products" className="text-primary hover:underline">
                {t('unknownCostLink')}
              </Link>
            </p>
          )}
          <OrderStatsChart data={orderStats[range]} loading={orderStatsLoading} />
        </div>
      )}

      {/* Activity feed */}
      <ActivityFeed items={activity} loading={activityLoading} />
    </div>
  )
}

// ------------------------------------------------------------

function formatRate(rate: number | null): string {
  if (rate == null) return '—'
  return `${Math.round(rate * 100)}%`
}

function deltaLabel(delta: number, suffix: string, noChangeLabel: string): string {
  if (delta === 0) return noChangeLabel
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}
