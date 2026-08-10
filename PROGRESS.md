# Progreso del proyecto — CherryCRM (fork de wacrm)

> Este archivo es un registro para continuidad entre sesiones/equipos.
> Si eres una IA (Claude u otra) retomando este proyecto: lee esto
> completo antes de tocar código, y después lee `ROADMAP.md` (detalle
> técnico de las 6 fases del módulo Dropi). Está escrito para que
> cualquiera (humano o IA) entienda en qué estado quedó todo sin tener
> que reconstruir el contexto desde cero.

**Última actualización:** 2026-08-10
**Repo:** fork de `ArnasDon/wacrm` en `https://github.com/Emanoppy/wacrm.git`
**Carpeta local:** `d:\CRM` (ojo: sesiones viejas de este mismo proyecto
usaban `d:\crm_waza` — esa ruta ya no aplica)
**Nombre de marca del producto:** "Cherry" / "CherryCRM"

---

## 1. Contexto del negocio

El dueño (Emmanuel) tiene un negocio de dropshipping/ecommerce en Colombia
que usa **Dropi** para logística/fulfillment. El objetivo del proyecto:

1. Adaptar un CRM open source de WhatsApp (**wacrm**) para su operación
   de dropshipping.
2. Integrarlo con **Dropi** (API de Integraciones) para traer los pedidos
   al CRM automáticamente, notificar al cliente por WhatsApp cuando
   cambia el estado, medir rentabilidad real, y visualizar el proceso
   logístico en un Pipeline tipo Kanban.
3. Catálogo de productos con costo/precio, ficha técnica que alimenta
   al asistente de IA, y etiquetado automático de clientes por nicho
   para remarketing (Broadcasts).
4. A futuro: revender el sistema por suscripción a otros dropshippers
   (wacrm ya soporta multi-tenant real vía RLS de Postgres — cada
   cliente futuro sería una cuenta aislada en la misma instalación).

## 2. Estado del despliegue — MUY IMPORTANTE

- **Producción real:** desplegada en Hostinger VPS + **EasyPanel**, app
  `cherrycrm`, dominio `crm-cherrycrm.uumxex.easypanel.host`.
- **EasyPanel hace auto-deploy cuando se hace push a la rama `main`** del
  fork en GitHub (`Emanoppy/wacrm`).
- **Local y producción comparten la MISMA base de datos de Supabase**
  (a propósito, ver `.env.local`) — cualquier prueba local toca datos
  reales, y cualquier migración aplicada localmente ya está aplicada
  en producción también (y viceversa).
- El webhook de Meta (WhatsApp) apunta **siempre a producción**, nunca a
  localhost — una prueba de mensajes reales solo refleja el código YA
  desplegado, no lo que esté sin subir.

## 3. Módulo Dropi (6 fases) — ver `ROADMAP.md`

Las 6 fases del roadmap de Dropi (pedidos, productos + IA, plantillas
dinámicas, dashboard de rentabilidad, pipeline visual, etiquetado por
nicho) están **completas** — el detalle técnico de qué se construyó en
cada una vive en `ROADMAP.md`, no se duplica acá. Migraciones `041` a
`045` (ver sección 5 — la `045` puede seguir pendiente de aplicar,
confirmar antes de asumir que ya corrió).

## 4. Idioma español (i18n)

- `messages/es.json` es la traducción completa de la interfaz.
- **Glosario que se deja en inglés a propósito**: `Pipeline`, `Lead`,
  `Dashboard`, `Deal`, `Tag`/`Tags`. Todo lo demás se traduce.
- Activado vía `NEXT_PUBLIC_APP_LOCALE=es` en `.env.local` — si algún
  día la UI vuelve a aparecer en inglés, ese es el primer lugar a
  revisar (requiere reiniciar el server, es una env var leída al
  arrancar, no en caliente).
- **Cada texto nuevo en la UI va en `en.json` Y `es.json` con las
  mismas claves.** Chequeo de paridad:
  ```bash
  node -e "const en=require('./messages/en.json'); const es=require('./messages/es.json'); function keys(o,p=''){return Object.keys(o).flatMap(k=>typeof o[k]==='object'&&o[k]!==null?keys(o[k],p+k+'.'):[p+k])} const ek=keys(en),sk=keys(es); console.log('missing:',ek.filter(k=>!sk.includes(k))); console.log('extra:',sk.filter(k=>!ek.includes(k)));"
  ```

## 5. Sesión 2026-08-09/10 — revisión senior + arreglos

Después de tener las 6 fases construidas, se hizo una revisión honesta
de si el sistema realmente cumple el objetivo (seguimiento logístico +
rentabilidad real), no solo "compila y pasa los tests". Se encontraron
y arreglaron varias cosas:

1. **El sync perdía pedidos viejos en tránsito.** `listMyOrders` solo
   trae los N pedidos más recientes por fecha de *creación* — un
   pedido que lleva varios días en tránsito se "caía" de esa ventana y
   dejaba de actualizarse para siempre. Arreglo: segunda pasada en
   cada corrida (`resolveStaleOpenOrderIds` en `sync.ts`) que refresca
   por `getOrderById` un lote de los pedidos propios que aún no están
   en `delivered_statuses`, empezando por los que hace más tiempo no
   se sincronizan.
2. **"Ganancia estimada" contaba TODOS los pedidos**, incluidos
   cancelados/pendientes — sobrestimaba la ganancia real, sobre todo
   grave en contraentrega colombiana donde la tasa de cancelación es
   alta. Arreglo: `loadOrderStats` (`src/lib/dashboard/queries.ts`)
   ahora solo cuenta pedidos en `delivered_statuses`.
3. **Campos de estado eran texto libre** (`confirmed_statuses`,
   `delivered_statuses`, `never_notify_statuses`, y el nuevo
   `lost_statuses`) — un typo los rompía en silencio. Arreglo:
   selector de pastillas (`StatusMultiSelect` en `dropi-config.tsx`)
   poblado con los estados reales observados en la cuenta.
4. **Bug real y serio encontrado**: el Agente de IA (`ai_configs`,
   sección "Agentes de IA") estaba **activo en producción** con un
   `system_prompt` de otro negocio completamente distinto ("EducaBot"
   de "EducaPro", vendiendo cuentas Canva/licencias Windows con
   cuentas bancarias peruanas) — quedó ahí de alguna prueba/demo
   anterior y nunca se reemplazó. **Se pausó (`auto_reply_enabled =
   false`) directamente en la base de datos como medida de
   seguridad.** Pendiente: redactar el prompt real del negocio antes
   de reactivarlo — no reactivar sin eso.
5. **Idioma por defecto de plantillas**: `en_US` → `es_CO` (código de
   idioma válido de Meta para Colombia, confirmado contra la
   documentación oficial).
6. **Se creó el pipeline "Pedidos"** — 9 etapas mapeadas a los 17
   estados reales observados en la cuenta (no la lista genérica de 7
   etapas del botón automático, que no cubría bien estados como "En
   bodega origen" o "Entregado a transportadora"). Mapeo completo,
   explícito, sin heurística. `dropi_config.pipeline_id` /
   `status_stage_map` quedaron enlazados.
7. **Won/Lost del pipeline no funcionaban** — `deals.status` se creaba
   en `'open'` y nunca cambiaba, así que "Ganado este mes" / "Perdido
   este mes" siempre daban 0. Arreglo: nueva columna
   `dropi_config.lost_statuses` (migración `045`, **confirmar que ya
   se aplicó** — ver sección 6) + `resolveDealStatus()` en `sync.ts`
   que marca el deal `won` cuando el pedido llega a
   `delivered_statuses`, `lost` cuando llega a `lost_statuses`
   (el dueño definió: solo `CANCELADO` cuenta como perdido).
8. **Pipeline Analytics tenía terminología y métricas de ventas B2B**
   sin sentido para pedidos logísticos ("Valor ponderado" = concepto
   de probabilidad de cierre). Arreglo: `pipeline-analytics.tsx`
   detecta si el pipeline seleccionado es el de Dropi
   (`isOrdersPipeline`) y en ese caso muestra "Total de pedidos",
   "Entregados/Cancelados este mes", oculta "Valor ponderado" — el
   pipeline genérico de Ventas no se tocó.
9. **Columna del pipeline crecía sin límite** (102 tarjetas en
   "Pendiente confirmación" estiraban toda la página) — ahora cada
   columna tiene alto máximo con scroll propio (`pipeline-board.tsx`).
10. **Filtro de fecha en Pipelines** — Hoy / Este mes / Todo el tiempo,
    antes no existía ninguno y "Valor del pipeline" era siempre la
    suma histórica completa.
11. **Paginación real en Pedidos** (`/orders`) — antes traía 200 filas
    fijas sin paginar. Ahora: selector de "por página" (10/25/50/100/200),
    navegación anterior/siguiente, contador "Mostrando X–Y de Z", y el
    filtro de estados se llena con su propia consulta (antes solo
    reflejaba lo que hubiera cargado en pantalla).

Todo verificado después de cada cambio: `npm run typecheck` (0
errores), `npm run lint` (0 errores), `npx vitest run` (700/706 — los
6 que fallan son de timezone/locale del entorno, preexistentes, no
relacionados con este trabajo), y chequeo de paridad i18n (0
faltantes/sobrantes).

## 6. Pendientes inmediatos (en orden)

1. **Aplicar la migración `045_dropi_deal_status.sql`** en el SQL
   Editor de Supabase si todavía no se hizo — es una sola línea
   (`ALTER TABLE dropi_config ADD COLUMN IF NOT EXISTS lost_statuses
   text[] NOT NULL DEFAULT '{}'`). Sin esto, guardar Settings → Dropi
   con `lost_statuses` falla.
2. **Corregir el `status` de los deals ya existentes** — los 241 deals
   creados antes del punto 7 de la sección 5 quedaron todos en
   `'open'`; como el pedido no cambia de estado en Dropi solo por
   correr el sync de nuevo, hace falta una pasada de corrección única
   (recalcular `won`/`lost` contra el estado actual de cada pedido).
   No se automatizó todavía — pendiente de hacer en la próxima sesión.
3. **Configurar el cron externo** de `/api/dropi/cron` (cada 5-10 min)
   — falta: confirmar/generar `AUTOMATION_CRON_SECRET` en las
   variables de entorno de EasyPanel, y apuntar un pinger externo
   (ej. cron-job.org) con el dominio real de producción. Sin esto, la
   sincronización solo corre cuando alguien hace clic en "Sincronizar
   ahora" manualmente.
4. **Redactar el prompt real del Agente de IA** (Settings → Agentes de
   IA) antes de reactivar `auto_reply_enabled` — ver punto 4 de la
   sección 5. Está pausado a propósito.
5. Confirmar que "Importar historial completo" (`/orders`) se corrió
   al menos una vez después de crear el pipeline "Pedidos", para que
   los pedidos históricos aparezcan en el tablero.

## 7. Cómo correr esto localmente

```bash
cd d:\CRM
npm install          # si hace falta
npm run dev           # http://localhost:3000
```

`.env.local` ya está configurado (apunta al mismo Supabase de
producción — con cuidado, cualquier prueba local toca datos reales).

Migraciones pendientes de aplicar en un ambiente NUEVO (si esto se
clona en otra parte / otro Supabase): correr **todas** las de
`supabase/migrations/` en orden vía SQL Editor de Supabase (son
idempotentes, se pueden re-correr sin problema).

## 8. Comandos de verificación que siempre se corren antes de dar algo por terminado

```bash
npm run typecheck    # tsc --noEmit, debe dar 0 errores
npm run lint          # eslint, debe dar 0 errores (warnings preexistentes son aceptables)
npx vitest run        # 700/706 es la línea base actual (6 fallos preexistentes de timezone/locale)
```
