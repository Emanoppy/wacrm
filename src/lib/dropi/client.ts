/**
 * Dropi Integrations API client.
 *
 * Base URL is production-only (`api.dropi.co/integrations`) —
 * `test-api.dropi.co` was verified NOT to accept this token type
 * (401 "Access denied" regardless of IP/header format; the token is
 * scoped to production only). All functions here are read-only on
 * purpose: order creation and guide generation are NOT implemented
 * here yet, since those mutate a real, live Dropi account.
 *
 * Auth: header `dropi-integration-key: <token>` — NOT `Authorization:
 * Bearer`. Dropi has a second, separate `/api/...` surface that uses
 * Bearer auth and its own login-issued tokens; that surface is
 * unrelated to this one and out of scope here.
 */

const DROPI_API_BASE =
  process.env.DROPI_API_BASE_URL || 'https://api.dropi.co/integrations'

interface DropiEnvelope<T> {
  isSuccess: boolean
  status: number
  message?: string
  objects: T
  count?: number | null
}

export class DropiApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'DropiApiError'
  }
}

// Dropi's own docs put request params in the "Body" of several GET
// endpoints (e.g. Listar Mis Ordenes) — non-standard HTTP that the
// Fetch API refuses outright ("Request with GET/HEAD method cannot
// have body", thrown before the request ever leaves the machine).
// Verified against the real API: Dropi's Laravel backend reads the
// same params fine from the query string on a GET, so that's what we
// send instead — same data, a shape fetch() actually allows.
function buildUrl(path: string, params?: unknown): string {
  const url = `${DROPI_API_BASE}${path}`
  if (!params || typeof params !== 'object') return url
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    qs.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  const query = qs.toString()
  return query ? `${url}?${query}` : url
}

async function dropiRequest<T>(
  path: string,
  args: {
    integrationKey: string
    method?: 'GET' | 'POST' | 'PUT'
    body?: unknown
  }
): Promise<T> {
  const { integrationKey, method = 'GET', body } = args
  const isGet = method === 'GET'
  const response = await fetch(isGet ? buildUrl(path, body) : `${DROPI_API_BASE}${path}`, {
    method,
    headers: {
      'dropi-integration-key': integrationKey,
      ...(body && !isGet ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body && !isGet ? JSON.stringify(body) : undefined,
  })

  let data: DropiEnvelope<T>
  try {
    data = await response.json()
  } catch {
    throw new DropiApiError(
      `Dropi API returned a non-JSON response (HTTP ${response.status})`,
      response.status
    )
  }

  if (!response.ok || !data.isSuccess) {
    throw new DropiApiError(
      data.message || `Dropi API error (HTTP ${response.status})`,
      response.status
    )
  }

  return data.objects
}

// ============================================================
// Types (fields confirmed against a live account's real responses,
// not just the PDF docs — Dropi's docs and actual payloads diverge
// in places, e.g. undocumented fields like `shop_order_number`).
// ============================================================

export interface DropiDepartment {
  id: number
  name: string
  country_id: number
  department_code: string | null
}

export interface DropiCity {
  id: number
  department_id: number
  name: string
  cod_dane: string
  rate_type: string
}

export interface DropiDistributionCompany {
  id: number
  name: string
  is_visible: boolean
}

export interface DropiFreightQuoteOption {
  transportadora: string
  transportadora_id: number
  objects?: {
    precioEnvio: number
    seguroEnvio: number | null
    overload_was_applied: boolean
  }
  error?: string
}

export interface DropiOrderProduct {
  id: number
  name: string
  sku: string | null
  sale_price: number
  quantity?: number
}

export interface DropiOrder {
  id: number
  shop_order_id: string | null
  shop_order_number: number | null
  status: string
  name: string
  surname: string
  phone: string
  dir: string
  city: string
  state: string
  total_order: number
  shipping_amount: number | null
  shipping_company: string | null
  distribution_company_id: number | null
  sticker: string | null
  /** Tracking/guide number shown to the customer — null until Dropi
   *  generates the guide (status GUIA_GENERADA onward). */
  shipping_guide: string | null
  guide_was_downloaded: boolean
  created_at: string
  updated_at: string
  orderdetails: Array<{ product: DropiOrderProduct; quantity: number }>
}

// ============================================================
// Departments / cities
// ============================================================

export async function listDepartments(args: {
  integrationKey: string
}): Promise<DropiDepartment[]> {
  return dropiRequest<DropiDepartment[]>('/department', args)
}

export async function listCitiesByDepartment(args: {
  integrationKey: string
  departmentId: number
  rateType?: 'CON RECAUDO' | 'SIN RECAUDO' | ''
}): Promise<{ cities: DropiCity[] }> {
  return dropiRequest('/trajectory/bycity', {
    integrationKey: args.integrationKey,
    method: 'POST',
    body: {
      department_id: args.departmentId,
      rate_type: args.rateType ?? '',
    },
  })
}

// ============================================================
// Logistics
// ============================================================

export async function listDistributionCompanies(args: {
  integrationKey: string
}): Promise<DropiDistributionCompany[]> {
  // Endpoint name uses an underscore — confirmed via the second doc;
  // not present in the first PDF's text at all.
  return dropiRequest<DropiDistributionCompany[]>('/distribution_companies', args)
}

export async function quoteFreight(args: {
  integrationKey: string
  envioConCobro: boolean
  amount: number
  destinoCodDane: string
  remitenteCodDane: string
}): Promise<DropiFreightQuoteOption[]> {
  return dropiRequest('/orders/cotizaEnvioTransportadoraV2', {
    integrationKey: args.integrationKey,
    method: 'POST',
    body: {
      EnvioConCobro: args.envioConCobro,
      amount: args.amount,
      ciudad_destino: { cod_dane: args.destinoCodDane },
      ciudad_remitente: { cod_dane: args.remitenteCodDane },
    },
  })
}

// ============================================================
// Orders (read-only — see file header)
// ============================================================

export async function listMyOrders(args: {
  integrationKey: string
  resultNumber?: number
  start?: number
  status?: string
}): Promise<DropiOrder[]> {
  return dropiRequest<DropiOrder[]>('/orders/myorders', {
    integrationKey: args.integrationKey,
    method: 'GET',
    body: {
      result_number: args.resultNumber ?? 50,
      start: args.start ?? 0,
      filter_date_by: 'FECHA DE CREADO',
      ...(args.status ? { status: args.status } : {}),
    },
  })
}

export async function getOrderById(args: {
  integrationKey: string
  dropiOrderId: string | number
}): Promise<DropiOrder> {
  return dropiRequest<DropiOrder>(`/orders/myorders/${args.dropiOrderId}`, {
    integrationKey: args.integrationKey,
  })
}
