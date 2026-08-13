# Progreso del proyecto — CherryCRM (fork de wacrm)

> Este archivo es un registro para continuidad entre sesiones/equipos.
> Si eres una IA (Claude u otra) retomando este proyecto: lee esto
> completo antes de tocar código, y después lee `ROADMAP.md` (detalle
> técnico de las 6 fases del módulo Dropi). Está escrito para que
> cualquiera (humano o IA) entienda en qué estado quedó todo sin tener
> que reconstruir el contexto desde cero.

**Última actualización:** 2026-08-13
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
`046` — todas aplicadas y confirmadas (ver secciones 5 y 5.2).

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

## 5.1 Sesión 2026-08-10 (tarde) — automatizaciones + prueba real + fix

1. **Se crearon 6 automatizaciones** de WhatsApp ligadas a los estados
   reales de Dropi y a las plantillas ya aprobadas (Confirmación, Guía
   generada, En reparto, Entregado, más las 2 respuestas a botones:
   "Confirmar Pedido" / "Modificar Datos"). Viven en `automations` /
   `automation_steps`, actualmente **todas en `is_active: false`**.
2. **Migración `045` aplicada** (confirmado).
3. **Se hizo una prueba real de extremo a extremo** con una cuenta de
   Dropi de prueba — durante la prueba se sincronizó por error con la
   clave de la cuenta **real** un par de veces (el campo no se había
   guardado a tiempo), lo que repobló pedidos/contactos reales. Se
   limpió dos veces (borrado de `orders`, `deals` del pipeline Dropi, y
   contactos sin conversación real — se preservó siempre el único
   contacto con historial de chat real). **Estado actual: 0 pedidos, 0
   deals del pipeline Dropi, 1 contacto** (el único con mensajes
   reales). Las 6 automatizaciones y `dropi_config.is_active` /
   `notify_customers_enabled` quedaron **apagados** después de la
   prueba — hay que volver a encenderlos a propósito antes de la
   siguiente prueba o de ir a producción real.
4. **Bug real encontrado y arreglado**: la regla "nunca notificar la
   primera vez que el CRM ve un pedido" (para no mandarle mensaje a
   todo el historial viejo al activar el sync) también bloqueaba sin
   querer el caso que sí se necesita — un pedido genuinamente nuevo.
   Arreglo: nueva columna `dropi_config.notify_since` (migración
   `046`, **confirmar que se aplicó**) — pedidos creados en Dropi en o
   después de esa fecha sí disparan la automatización aunque sea la
   primera vez que el CRM los ve. Configurable en Configuración →
   Dropi. `null` (vacío) = comportamiento seguro de siempre.
5. Verificado: el motor de automatizaciones (`engine.ts`) consulta
   `automations.is_active` en vivo en cada disparo, no cachea — apagar
   una automatización a mitad de un sync en curso sí detiene mensajes
   pendientes de ese mismo run.

## 5.2 Sesión 2026-08-13 — motor de automatizaciones + Agente de IA real + preparación para producción

1. **El prompt del Agente de IA YA NO es el de "EducaBot"** — al
   revisarlo hoy, alguien (probablemente la sesión del 09/10) ya lo
   había reemplazado por un prompt extenso y bien escrito, específico
   para **"Casa Nova Market"** (el nombre real de la tienda, confirmado
   contra el `shop.name` de un pedido real de Dropi). El punto 4 de la
   sección 5 sobre EducaBot está **desactualizado** — ya no aplica.
2. **Bug real encontrado en ese prompt**: describía acciones que el
   Agente de IA puede ejecutar (crear/modificar/cancelar pedidos,
   consultar estado logístico en vivo) que **no existen en el código**
   — `src/lib/ai/` no tiene ningún tool/function-calling conectado, es
   un generador de texto puro (lee `messages` + la base de
   conocimiento, nada más — confirmado revisando `context.ts`,
   `auto-reply.ts`, `generate.ts`). Si se activaba tal cual, el bot
   podía prometerle a un cliente que algo "ya quedó confirmado/
   cancelado" sin que fuera cierto. **Arreglo**: se reescribieron las
   secciones que asumían esas herramientas (4, 9, 25, 27-30, 33, 35)
   para que el bot registre la solicitud y transfiera a un asesor
   humano, en vez de afirmar que ya ejecutó algo. Se conservó ~90% del
   prompt original (tono, reglas de precio/catálogo/objeciones, todo
   estaba bien). Guardado en `ai_configs.system_prompt`.
   **`auto_reply_enabled` sigue en `false`** — no reactivar sin probar
   primero en una conversación propia.
3. **Se completó el motor de Automatizaciones con 3 piezas que
   faltaban** (encontradas al auditar el motor contra un flujo real:
   "pedido creado → ¿contraentrega? → confirmar → mover pipeline"):
   - **Operadores genéricos** en condiciones (`equals`, `not_equals`,
     `contains`, `not_contains`, `greater_than`, `less_than`,
     `is_empty`, `is_not_empty`) — antes cada `subject` traía una sola
     comparación fija sin poder elegirla. `ConditionOperator` en
     `types/index.ts`, aplicado vía `applyOperator()` en `engine.ts`.
     Retrocompatible: un `condition` step guardado antes de esto no
     tiene `operator` y sigue con su comparación fija de siempre.
   - **Condición sobre el pedido** (`subject: 'order_field'`) — antes
     una condición solo podía mirar contacto/tag/mensaje/hora, nunca
     el pedido. Resuelve el pedido desde `context.order_id` (si el
     trigger es `order_status_changed`) o el más reciente del
     contacto (para triggers como `interactive_reply`), y evalúa
     cualquier columna (`status`, `total_order`, `city`...).
   - **Acción `move_deal_stage`** — antes solo existía `create_deal`
     (crear). Mueve el deal ya enlazado a otra etapa del pipeline.
     **Importante, por qué no se hizo escribiendo `orders.status`
     directamente**: `orders` es un espejo de solo lectura de Dropi
     (lo llena `sync.ts`, nunca al revés) — un `status` escrito ahí
     por una automatización se perdería en el siguiente sync. El
     pipeline sí es dato propio del CRM, por eso "el cliente confirmó"
     debe vivir ahí, no en `orders`.
   Todo con `t/lint` en 0 errores, paridad i18n en 0. Builder visual
   (`automation-builder.tsx`) actualizado con los campos nuevos.
4. **Migración `046` aplicada y confirmada** (columna `notify_since`
   existe en `dropi_config`).
5. **`notify_since` se puso a "ahora"** (2026-08-13T21:27:05Z) —
   preparación explícita para conectar el token de la tienda real: el
   historial viejo que se traiga con "Importar historial completo" no
   va a notificar a nadie (protegido por defecto), pero cualquier
   pedido genuinamente nuevo desde ese momento en adelante sí.
6. **⚠️ ESTADO EN VIVO AHORA MISMO — leer antes de tocar nada**:
   `dropi_config.is_active = true`, `notify_customers_enabled = true`,
   **las 6 automatizaciones están `is_active: true`**. Todavía
   apuntando a la clave de integración de **prueba** (cuenta de
   pruebas del dueño, un solo pedido `#85467467` "Emmanuel R", estado
   `PENDIENTE`) — **NO** a la tienda real todavía. El dueño pidió
   conectar ya el token de su tienda oficial; quedó pendiente de que
   él lo pegue en Configuración → Dropi (o en la conversación para que
   la IA lo guarde) — no se hizo en esta sesión por falta del valor
   del token, no por decisión de esperar. **Antes de la próxima
   sesión, confirmar si ya se conectó el token real o sigue en
   pruebas**, porque con todo ya encendido, el momento en que se
   guarde el token real y se sincronice, el sistema empieza a mandar
   mensajes de verdad.
7. **Pista para investigar el campo de "contraentrega"** (pendiente,
   sección 6): el dueño mencionó que probablemente el valor es
   `"CON RECAUDO"` / `"SIN RECAUDO"` — ese término ya aparece en
   `client.ts` (`rateType` de `listCitiesByDepartment`, y
   `EnvioConCobro` de `quoteFreight`), pero no se ha confirmado si el
   objeto de un pedido (`DropiOrder`/`order.raw`) trae ese mismo dato
   o algo distinto — falta sacarlo de un pedido real y confirmar antes
   de construir la condición "¿es contraentrega?" con `order_field`.
8. **Decisión explícita del dueño**: el botón/flujo de cancelación
   (tercer botón "Cancelar" en la plantilla de confirmación) queda
   **fuera de alcance por ahora** — no construir sin que lo pida de
   nuevo.
9. **Pedido para una próxima sesión, todavía sin construir**: tabla
   `order_line_items` (poblada en el sync, para poder elegir productos
   ya vistos en pedidos reales al crear un producto en `/productos` en
   vez de escribir el SKU a ciegas — además destraba analítica por
   producto) + indicador de "escribiendo..." en los envíos del motor
   (la API de WhatsApp Cloud lo soporta, no investigado a fondo
   todavía).

## 6. Pendientes inmediatos (en orden)

1. **Conectar el token real de la tienda oficial** en Configuración →
   Dropi (ver sección 5.2 punto 6) — todo lo demás ya está armado y
   encendido esperando esto. Después: "Importar historial completo"
   (seguro, nunca notifica) y luego "Sincronizar ahora".
2. **Confirmar el campo real de contraentrega** en un pedido real
   (sección 5.2 punto 7) antes de construir la condición `order_field`
   para "¿es contraentrega?".
3. **Armar y probar la automatización completa** del ejemplo objetivo
   (pedido creado → condición → confirmar → `move_deal_stage`) usando
   las 3 piezas nuevas del motor.
4. **Probar el Agente de IA** con el prompt nuevo de Casa Nova Market,
   en una conversación propia del dueño — `auto_reply_enabled` sigue
   apagado hasta confirmar que responde bien.
5. **Corregir el `status` de los deals viejos** — los 241 deals
   creados antes del punto 7 de la sección 5 quedaron todos en
   `'open'`; hace falta una pasada de corrección única (recalcular
   `won`/`lost` contra el estado actual de cada pedido). No
   automatizado todavía.
6. **Configurar el cron externo** de `/api/dropi/cron` (cada 5-10 min)
   — falta: confirmar/generar `AUTOMATION_CRON_SECRET` en las
   variables de entorno de EasyPanel, y apuntar un pinger externo
   (ej. cron-job.org) con el dominio real de producción. Sin esto, la
   sincronización solo corre cuando alguien hace clic en "Sincronizar
   ahora" manualmente. Requiere que el dueño actúe en 2 plataformas
   externas (EasyPanel + cron-job.org), no se puede hacer solo desde
   el código.
7. **`order_line_items` + selector de productos en `/productos`** y
   **indicador de "escribiendo..."** (sección 5.2 punto 9) — pedidos
   por el dueño, sin construir todavía.

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
