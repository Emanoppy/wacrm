"use client"

import { Package } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { OrderStatsSummary } from '@/lib/dashboard/types'
import { BarChart } from '@/components/tremor/bar-chart'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface OrderStatsChartProps {
  data: OrderStatsSummary | null
  loading: boolean
}

const CATEGORY = 'New orders'

export function OrderStatsChart({ data, loading }: OrderStatsChartProps) {
  const t = useTranslations('Dashboard.orderStatsChart')
  const hasData = (data?.totalOrders ?? 0) > 0

  const chartData =
    data?.series.map((p) => ({
      day: p.day.slice(5), // MM-DD — the range can span >7 days, weekday-only labels would collide
      [CATEGORY]: p.newOrders,
    })) ?? []

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !hasData ? (
          <EmptyState icon={Package} title={t('noOrders')} hint={t('noOrdersHint')} />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[CATEGORY]}
            colors={['blue']}
            valueFormatter={(value) => value.toFixed(0)}
            showLegend={false}
            yAxisWidth={40}
            className="h-[260px]"
          />
        )}
      </div>
    </section>
  )
}
