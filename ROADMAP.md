# Roadmap — CherryCRM (ecommerce/dropshipping)

> Registro de fases para continuidad entre sesiones/equipos (mismo
> propósito que `PROGRESS.md`). Escrito a partir de una sesión de
> planeación con el dueño (Emmanuel) el 2026-08-08. Si eres una IA
> retomando esto: lee `PROGRESS.md` primero (estado técnico actual),
> luego esto (hacia dónde vamos y por qué en este orden).
>
> **Estado: las 6 fases están completas** (implementadas y verificadas
> con `npm run typecheck` / `lint` / `test` — 0 errores, mismos
> 700/706 tests que ya fallaban antes de estas fases por un tema de
> zona horaria del entorno, ajeno a este trabajo). Migraciones 041 a
> 044 aplicadas. Ver el detalle de "qué se construyó" en cada sección
> — quedó documentado también qué se dejó fuera de cada fase a
> propósito, por si se retoma más adelante.

## Regla de oro (del dueño, textual)

> "No dañes la lógica que ya funciona. La idea es acoplar todo y que
> todo funcione, con buenas prácticas. Cada vez que hagas una
> modificación, revisa que no hayas dañado nada."

Cada fase abajo dice explícitamente si toca código que ya funciona en
producción (con cuidado extra) o si es puramente aditiva.

## Decisión de arquitectura — la pregunta que hizo el dueño

**Pregunta:** ¿el envío de WhatsApp cuando cambia el estado de un
pedido debería armarse con el módulo de **Flujos** (Flows) o con
lógica interna programada?

**Respuesta: ninguna de las dos — debe ser un nuevo tipo de disparador
del motor de Automatizaciones (`src/lib/automations/engine.ts`), no
Flujos.**

Por qué:
- **Flujos** (`flows`, tablas `flow_nodes`/`flow_runs`) están hechos
  para árboles conversacionales disparados por un mensaje entrante
  (`keyword`, `first_inbound_message`, `manual`) — el cliente escribe
  algo y el flujo responde. Un cambio de estado en Dropi no es un
  mensaje entrante, así que no encaja ahí.
- **Automatizaciones** (`automations`, motor en `engine.ts`,
  `runAutomationsForTrigger()`) ya son "si pasa X, hacer estos pasos"
  — y la columna `trigger_type` es texto libre sin restricción en la
  base de datos, confirmado al revisar el esquema: agregar un
  disparador nuevo (`order_status_changed`) no necesita migración,
  solo:
  1. Agregarlo al tipo `AutomationTriggerType` en `src/types/index.ts`
  2. Un caso en `triggerMatches()` (engine.ts) para poder filtrar por
     "de qué estado a qué estado"
  3. Llamar `runAutomationsForTrigger()` desde `sync.ts` cuando se
     detecta el cambio de estado (ya sabemos exactamente dónde —
     `upsertOneOrder`, línea donde hoy se manda el único
     `notify_template_name`)
- Esto además reemplaza el campo único `dropi_config.notify_template_name`
  (una sola plantilla para cualquier cambio) por **una automatización
  por estado**, configurable sin tocar código desde el constructor
  visual que el CRM ya tiene — exactamente lo que pediste con
  "plantilla distinta por estado", sin construir una interfaz nueva.

## Fase 1 — Cerrar el módulo de Pedidos ✅

*(Aditiva. No rompe nada del sync actual — el "Sincronizar ahora" y
"Importar historial" siguen funcionando igual mientras se construye
esto al lado.)*

1. **Cron activo** — generar `AUTOMATION_CRON_SECRET`, configurar un
   pinger externo (ej. cron-job.org, o el mismo mecanismo que ya usa
   `/api/automations/cron`) que llame `/api/dropi/cron` cada 5-10 min.
2. **Tamaño de lote configurable por cuenta** — nueva columna
   `dropi_config.sync_batch_size` (default 50). Si `fetched ==
   sync_batch_size` en un sync, el sistema puede advertir "puede haber
   más pedidos sin traer, sube este número" — así el negocio ajusta
   solo cuando el volumen crece, como pediste.
3. **No notificar en estados terminales negativos** — lista
   configurable de estados que nunca disparan mensaje (ej.
   `CANCELADO`), para no gastar automatizaciones en pedidos muertos.
4. **Migrar la notificación a Automatizaciones** (ver decisión de
   arquitectura arriba) — esto habilita una plantilla distinta por
   transición de estado.
5. **Conectar `orders.contact_id` / `orders.conversation_id`** — ya
   existen en la tabla `orders` pero el sync no las llena todavía
   (lo detecté al revisar `sync.ts`). Completarlas durante el upsert
   deja cada pedido enlazado a su ficha de contacto y su chat.

## Fase 2 — Módulo de Productos (prerrequisito de las fases 3, 4 y 6) ✅

*(Aditiva — tabla nueva, no toca nada existente.)*

1. Tabla `products`: nombre, precio de venta, **costo del producto**,
   ficha técnica / preguntas frecuentes, imágenes, nicho/categoría.
2. Conectar cada producto a la **Base de Conocimiento IA — ya
   existe** (Settings → AI Assistant, tablas `ai_knowledge_documents` /
   `ai_knowledge_chunks`, búsqueda híbrida texto+semántica). No hay
   que construir "la IA responde dudas del producto" desde cero — hay
   que **poblar** lo que ya está construido con la ficha de cada
   producto.
3. (Opcional, fase posterior) sincronizar catálogo desde el endpoint
   de productos de Dropi en vez de cargarlo a mano.

## Fase 3 — Plantillas dinámicas por estado y producto ✅

*(Depende de la Fase 1.4 y, para las variables de producto, de la
Fase 2.)*

1. Mejorar la creación/edición de plantillas (imagen de encabezado,
   botones) dentro de lo que Meta permite — **límite importante a
   tener en cuenta**: una plantilla de WhatsApp aprobada por Meta
   tiene texto fijo con variables numeradas (`{{1}}`, `{{2}}`...), no
   se puede escribir texto libre nuevo sin volver a aprobar la
   plantilla. La "dinámica" es rellenar esas posiciones con datos
   reales del pedido (nombre, producto, precio), no reescribir el
   mensaje.
2. Definir, por plantilla, qué campo del pedido llena cada posición
   (`{{1}} = nombre del cliente`, `{{2}} = nombre del producto`, etc.)
   y usar eso en la automatización de la Fase 1.4.

## Fase 4 — Dashboard de logística y rentabilidad ✅

*(Depende del costo de producto de la Fase 2 para la parte de
ganancia; los conteos de pedidos/estados se pueden construir antes.)*

1. Pedidos nuevos, confirmados, entregados — por día y por semana.
2. Tasa de confirmación (confirmados ÷ total) y tasa de entrega
   (entregados ÷ confirmados) — usa el historial en
   `order_status_events`, ya se está guardando desde la Fase 1
   original.
3. Ganancia estimada = `total_order` − costo del producto (Fase 2) −
   costo de flete (fijo configurable, o real vía el cotizador de
   Dropi que el cliente ya tiene integrado: `quoteFreight` en
   `client.ts`).

## Fase 5 — Pipeline visual por estado de pedido ✅

*(Depende del mismo punto de enganche que la Fase 1.4 — se puede
construir en paralelo a las fases 2-4.)*

1. Reutilizar `orders.deal_id` (ya existe, sin usar) — crear/mover el
   deal correspondiente en el pipeline cuando el pedido cambia de
   estado.
2. Etapas del pipeline = estados reales de Dropi (Confirmación,
   Actualizando datos, Cancelado, Guía generada, En reparto,
   Entregado, Novedad).

## Fase 6 — Clientes y remarketing por nicho ✅

*(Depende de las etiquetas/nicho de la Fase 2.)*

1. Al sincronizar un pedido, etiquetar automáticamente el contacto con
   el nicho del producto comprado (usa el sistema de `tags` que ya
   existe en Contactos).
2. Con eso, los **Broadcasts** (ya soportan segmentar audiencia) se
   pueden dirigir por nicho/interés cuando salga un producto
   relacionado — sin construir nada nuevo de targeting, solo tener
   los datos limpios.

## Cosas que YA EXISTEN y no hay que construir (aclarado para no
duplicar trabajo)

- **Prompt maestro del asistente de IA** → ya existe:
  `ai_configs.system_prompt`, campo "Business context & instructions"
  en Settings → AI Assistant. Falta redactarlo bien, no programarlo.
- **Base de conocimiento con IA (RAG)** → ya existe (ver Fase 2.2).
- **Segmentación de audiencia en Broadcasts** → ya existe (ver Fase
  6.2).
- **Constructor visual de Automatizaciones** → ya existe, es lo que
  se reutiliza en la Fase 1.4 en vez de construir una UI nueva.

## Orden recomendado de ejecución

1 → (2 en paralelo con 5) → 3 → 4 → 6

La Fase 1 es la más urgente y la más barata (mejoras sobre código que
ya funciona). La Fase 2 desbloquea tres fases más adelante, así que
conviene adelantarla temprano aunque no sea la más vistosa.
