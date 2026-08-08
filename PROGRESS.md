# Progreso del proyecto — CherryCRM (fork de wacrm)

> Este archivo es un registro para continuidad entre sesiones/equipos.
> Si eres una IA (Claude u otra) retomando este proyecto: lee esto
> completo antes de tocar código. Está escrito para que cualquiera
> (humano o IA) entienda en qué estado quedó todo sin tener que
> reconstruir el contexto desde cero.

**Última actualización:** 2026-08-08
**Repo:** fork de `ArnasDon/wacrm` en `https://github.com/Emanoppy/wacrm.git`
**Nombre de marca del producto:** "Cherry" / "CherryCRM"

---

## 1. Contexto del negocio

El dueño (Emmanuel) tiene un negocio de dropshipping/ecommerce en Colombia
que usa **Dropi** para logística/fulfillment. El objetivo del proyecto:

1. Adaptar un CRM open source de WhatsApp (**wacrm**, elegido tras comparar
   contra `vocero-crm` + `nea-agent` de otro autor — wacrm ganó por ser
   multi-tenant real dentro de una sola instalación, ver sección 3) para
   su operación de dropshipping.
2. Integrarlo con **Dropi** (API de Integraciones) para traer los pedidos
   al CRM automáticamente.
3. A futuro: revender el sistema por suscripción a otros dropshippers
   (por eso importaba que wacrm ya soporte multi-tenant real vía RLS de
   Postgres — cada cliente futuro sería una cuenta aislada en la misma
   instalación, sin necesitar un servidor por cliente).

## 2. Estado del despliegue — MUY IMPORTANTE

- **Producción real:** desplegada en Hostinger VPS + **EasyPanel**, app
  llamada `cherrycrm`, dominio `crm-cherrycrm.uumxex.easypanel.host`.
- **EasyPanel hace auto-deploy cuando se hace push a la rama `main`** del
  fork en GitHub (`Emanoppy/wacrm`).
- **Todo el trabajo de esta sesión está SOLO en local** (`d:\crm_waza`,
  rama `main`, varios commits por delante de `upstream/main`). **Nunca se
  ha podido hacer `git push` exitoso** — falla con 403 "Permission to
  Emanoppy/wacrm.git denied". No se resolvió el tema de credenciales de
  Git Credential Manager en Windows todavía. **Antes de pushear, resolver
  la autenticación de git** (revisar credential manager, o generar un
  Personal Access Token, o que el usuario haga el push él mismo desde su
  propia sesión ya logueada).
- **Local y producción comparten la MISMA base de datos de Supabase**
  (a propósito, ver `.env.local`) — por eso los datos se ven iguales en
  los dos lados, pero el *código* de producción sigue siendo el de ANTES
  de esta sesión hasta que se haga el push.
- Esto importa mucho para WhatsApp: **el webhook de Meta apunta a
  producción, nunca a localhost** (Meta no puede alcanzar una IP local).
  Cualquier prueba con mensajes reales de WhatsApp solo refleja el código
  YA desplegado, no los cambios de esta sesión, hasta que se suba.

## 3. Por qué wacrm (no vocero-crm/nea-agent)

Se compararon 3 repos: `wacrm` (ArnasDon), `vocero-crm` + `nea-agent`
(kevinrivm). Se clonaron también a `D:\vocero-crm` y `D:\nea-agent` como
referencia (no se usan, se dejaron ahí por si se quieren revisar).

Razón de la decisión: wacrm tiene **multi-tenancy real** — cada registro
nuevo crea una cuenta aislada vía RLS de Postgres (migración
`017_account_sharing.sql`, función `is_account_member()`). Eso permite
correr **una sola instalación sirviendo a muchos clientes futuros**, en
vez de necesitar un servidor por cliente (como el modelo de vocero-crm).

## 4. Módulo de Dropi — lo que se construyó

### Base de datos (migraciones `037` a `040`, todas aplicadas ya vía SQL Editor)

- **`dropi_config`** — un registro por cuenta: clave de integración
  cifrada (AES-256-GCM, mismo `encrypt()`/`decrypt()` que WhatsApp), y
  **dos interruptores apagados por defecto**:
  - `is_active` — activa la sincronización.
  - `notify_customers_enabled` — activa el envío de WhatsApp al cliente
    cuando cambia el estado de un pedido.
  - `notify_template_name` — qué plantilla usar para notificar.
  - `syncing` — candado atómico (migración 038) para que el cron y el
    botón manual no corran al mismo tiempo y dupliquen notificaciones.
    Función `claim_dropi_sync()`, se autolibera si un sync queda pegado
    más de 15 min.
- **`orders`** — un registro por pedido de Dropi, con
  `dropi_created_at` (fecha real de creación en Dropi, migración 039 —
  no confundir con `last_synced_at`), cliente, dirección, producto (en
  `raw` como JSON completo), estado, transportadora, total.
  `UNIQUE(account_id, dropi_order_id)` — el sync es idempotente.
- **`order_status_events`** — historial de cambios de estado por pedido,
  con `customer_notified` para no notificar dos veces por el mismo
  cambio.

### Código

- `src/lib/dropi/client.ts` — cliente de la API de Integraciones de
  Dropi. **Solo lectura** (nunca crea pedidos ni genera guías —
  decisión deliberada, es la cuenta real de producción del usuario).
  Endpoints probados y funcionando contra producción real:
  departamentos, ciudades, cotizador de flete, transportadoras, listar
  pedidos, pedido por ID.
  - **Bug real encontrado y corregido:** `fetch()` no permite mandar
    body en peticiones GET, y "Listar Mis Órdenes" es GET-con-body según
    la doc de Dropi. Se manda como query string en su lugar (el backend
    de Dropi es Laravel, lee igual de query que de body).
  - Ambiente de **test de Dropi (`test-api.dropi.co`) NO funciona con
    este token** — el token es válido solo para producción
    (`api.dropi.co`). Pendiente: pedirle a Dropi un token de test, o
    aceptar trabajar contra producción con cuidado (ya se hace así).
- `src/lib/dropi/sync.ts` — `syncAccountDropiOrders` (últimos 50,
  rápido) y `backfillAccountDropiOrders` (pagina TODO el historial,
  notificaciones forzadas a `false` sin importar la config — un
  backfill histórico nunca debe notificar). Nunca notifica en la
  primera vez que ve un pedido, solo en cambios posteriores a un pedido
  ya existente.
- Rutas: `/api/dropi/{config,test,sync,backfill,cron}`.
- Página **Pedidos** (`/orders`) — tabla con buscador, filtro por
  estado, botones "Sincronizar ahora" / "Importar historial completo",
  clic en una fila abre un detalle completo (teléfono, dirección,
  productos, envío, transportadora, pedido de origen en Shopify).
- Configuración → **Dropi** (nueva sección en Settings) — pegar la
  clave, botón "Verificar conexión" (prueba real sin guardar), los dos
  interruptores. También agregada la tarjeta correspondiente en
  Configuración → Resumen (se le había olvidado en la primera pasada).

### Pendiente / próxima fase (ya identificado, no construido)

1. Plantilla de WhatsApp **específica por estado** (hoy es una sola
   plantilla genérica para cualquier cambio de estado).
2. Tablero visual tipo **Pipeline** por estado de pedido (Confirmación,
   Actualizando datos, Cancelado, En reparto, Entregado, Novedad) — hoy
   es una tabla con filtro, no un Kanban.
3. Capa de **analítica/reportes**: pedidos por día de la semana,
   promedio diario, tasa de conversión (confirmados vs.
   cancelados/rechazados) — la base de datos ya tiene todo lo necesario
   (`dropi_created_at`, `status`), falta la vista.
4. Preguntas pendientes para el equipo de TI de Dropi: token de test
   aparte, si el historial/huella del cliente por teléfono está en la
   API de Integraciones, si cartera/tickets están bajo el mismo token o
   necesitan el otro sistema de auth (Bearer, login con
   usuario/contraseña — **nunca se debe pedir la contraseña de Dropi
   del usuario para esto**, es contra la política de Dropi).

## 5. Arreglos en el inbox de WhatsApp (encontrados probando Dropi con un número real)

- **Botones de plantilla no reconocidos**: Meta manda `type: "button"`
  cuando el cliente toca un botón de plantilla (Quick Reply) —
  distinto de `type: "interactive"` (usado por Flows). No había caso
  para eso, cae en `[Unsupported message type: button]`. Ya se agregó
  el caso en `src/app/api/whatsapp/webhook/route.ts`. **Ojo: mensajes
  viejos ya guardados con ese texto no se corrigen solos, es solo hacia
  adelante — y como el webhook de Meta apunta a producción, este
  arreglo no se nota hasta que se despliegue.**
- **Plantilla enviada desde Contacto sin texto visible**: el botón
  "Enviar plantilla" en la ficha de contacto no mandaba `content_text`
  al guardar el mensaje (a diferencia del picker de la bandeja de
  entrada, que sí lo hacía). Se unificó la lógica en
  `renderTemplateBody()` (ahora vive en
  `src/lib/whatsapp/template-components.ts`, compartida por los dos
  sitios).
- **Botones de la plantilla enviada no se veían**: se agregó
  `messages.template_buttons` (migración 040) — guarda los botones de
  la plantilla al momento de enviar, y la burbuja del chat ahora los
  renderiza (estilo similar a como ya se renderizaban los botones de
  mensajes interactivos).
- Hay un log de diagnóstico temporal en el `default:` del switch de
  `parseMessageContent` (webhook route) — imprime el payload crudo de
  cualquier tipo de mensaje no reconocido. **Se puede quitar una vez
  confirmado en producción que no aparecen más tipos sin manejar.**

## 6. Idioma español (i18n)

- El proyecto ya traía `next-intl`, solo tenía `en.json` y `ko.json`.
  Se creó `messages/es.json` — traducción completa de toda la interfaz.
- **Glosario de términos que se dejan en inglés a propósito** (decisión
  del cliente, no traducir): `Pipeline`, `Lead`, `Dashboard`, `Deal`,
  `Tag`/`Tags`. Todo lo demás sí se tradujo (Broadcast → Difusión,
  Automation → Automatización, etc.)
- Activado vía `NEXT_PUBLIC_APP_LOCALE=es` en `.env.local`.
- **Recordatorio:** cada vez que se agregue un texto nuevo a la UI, hay
  que agregarlo en `en.json` Y `es.json` con las mismas claves — hay un
  chequeo de paridad que se puede correr así:
  ```
  node -e "const en=require('./messages/en.json'); const es=require('./messages/es.json'); function keys(o,p=''){return Object.keys(o).flatMap(k=>typeof o[k]==='object'&&o[k]!==null?keys(o[k],p+k+'.'):[p+k])} const ek=keys(en),sk=keys(es); console.log('missing:',ek.filter(k=>!sk.includes(k))); console.log('extra:',sk.filter(k=>!ek.includes(k)));"
  ```

## 7. Marca "Cherry"

- Título de pestaña del navegador y nombre en el sidebar → "Cherry" /
  "CherryCRM" (`src/app/layout.tsx`, claves `Sidebar.title` en
  en.json/es.json).
- Favicon → cerezas 🍒 sobre fondo **blanco** (`src/app/icon.tsx`) —
  se probó primero fondo rojo intenso pero el emoji (rojo) no se veía,
  se cambió a blanco por contraste.

## 8. Cómo correr esto localmente

```bash
cd d:\crm_waza
npm install          # si hace falta
npm run dev           # http://localhost:3000
```

`.env.local` ya está configurado (apunta al mismo Supabase de
producción — con cuidado, cualquier prueba local toca datos reales).

Migraciones pendientes de aplicar en un ambiente NUEVO (si esto se
clona en otra parte / otro Supabase): correr **todas** las de
`supabase/migrations/`, del 001 al 040, en orden, vía SQL Editor de
Supabase (son idempotentes, se pueden re-correr sin problema).

## 9. Comandos de verificación que siempre se corrieron antes de dar algo por terminado

```bash
npm run typecheck    # tsc --noEmit, debe dar 0 errores
npm run lint          # eslint, debe dar 0 errores (warnings preexistentes son aceptables)
```

## 10. Siguiente paso inmediato pendiente

**Resolver la autenticación de git para poder hacer `git push origin main`**
y así activar el despliegue automático en EasyPanel con todo lo de esta
sesión. El usuario decidirá cómo prefiere resolverlo (push manual desde
su propia sesión, generar un Personal Access Token, etc.) — no se debe
intentar de nuevo sin su instrucción explícita sobre el método.
