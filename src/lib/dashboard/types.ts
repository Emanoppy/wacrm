// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}

// ------------------------------------------------------------
// Dropi order stats (ROADMAP.md Fase 4) — logistics/profit dashboard.
// ------------------------------------------------------------

export interface OrderStatsPoint {
  day: string // YYYY-MM-DD local
  newOrders: number
}

export interface OrderStatsSummary {
  series: OrderStatsPoint[]
  totalOrders: number
  confirmedOrders: number
  deliveredOrders: number
  /** null when totalOrders is 0 — no rate to show, not "0%". */
  confirmationRate: number | null
  /** null when confirmedOrders is 0. */
  deliveryRate: number | null
  /** Sum of (total_order - shipping - product cost) for DELIVERED
   *  orders only (dropi_config.delivered_statuses) — pending, cancelled,
   *  and returned orders never collected their total_order, so they're
   *  excluded rather than overstating real profit. 0 when
   *  delivered_statuses isn't configured yet, not "every order". */
  estimatedProfit: number
  /** Among delivered orders, how many had at least one line item whose
   *  SKU didn't match the product catalog — estimatedProfit excludes
   *  their product cost, so it's understated by an unknown amount for
   *  these orders. */
  ordersWithUnknownCost: number
}
