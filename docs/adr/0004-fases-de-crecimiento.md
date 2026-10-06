# ADR 0004 — Fases de crecimiento: galería, planes de suscripción, membresías y auspiciadores

- **Estado:** aceptado como diseño previsto. **No implementado.**
- **Fecha:** 2026-10-06
- **Alcance:** Fases 13 (ampliación), 14, 15 y 16 (CLAUDE.md §12).

## Contexto

El usuario definió cuatro líneas de crecimiento posteriores al MVP. Este ADR fija el diseño previsto para que las fases anteriores (en particular la 12, que crea el rol `ADMIN` y el prefijo `/api/v1/admin`) dejen los puntos de extensión correctos. Cada fase presentará su plan detallado y sus preguntas antes de implementarse (CLAUDE.md §1).

Principios comunes:

- **Lo que se administra son datos, no código.** Las listas cerradas (categorías, estilos, planes y beneficios) las gestiona `ADMIN` desde `/api/v1/admin`, sin despliegues. El código define solo los tipos.
- **Un único punto de decisión** para lo que depende del plan, el servicio de derechos de la Fase 15. Ningún módulo pregunta "¿qué plan tiene?": pregunta "¿tiene este derecho?" o "¿cuál es este límite?".
- **Interfaces delante de los proveedores**, como ya ocurre con `PaymentGateway`: almacenamiento de imágenes (`ImageStorage`) y cobro recurrente (sobre `PaymentGateway`).
- **Seguridad y privacidad** según CLAUDE.md §6: autorización por propiedad, auditoría de las acciones sensibles y ningún dato personal en registros ni eventos.

## Fase 14 — Galería y perfiles

**Debe estar lista antes de la app móvil.**

### Almacenamiento de imágenes

- **Interfaz `ImageStorage`:** subir, borrar y obtener la URL pública o firmada. Una implementación local para desarrollo y pruebas; el proveedor real está por decidir (`docs/pendientes-produccion.md`).
- **Procesamiento:** límite de tamaño de subida, validación del tipo real del archivo (no por extensión), eliminación de metadatos EXIF (incluida la ubicación) y reducción automática a tamaños estándar (miniatura y grande). La subida va fuera de las transacciones de base de datos (regla 12).
- **Tipos de imagen:**
  - logo y portada de la barbería;
  - foto del barbero;
  - galería de trabajos **por barbero**.

### Clasificación de la galería

- **Categoría obligatoria** de `service_categories` (la misma lista de los servicios).
- **Hasta 3 estilos opcionales** de una tabla nueva, `service_styles`: estilos asociados a una categoría, por ejemplo en "Corte de cabello": degradado, clásico, moderno, rapado, con diseño. Cada estilo tiene clave estable, nombre, orden y activo.
- **Listas cerradas:** categorías y estilos los administra `ADMIN` desde `/api/v1/admin`; la barbería elige, nunca escribe texto libre.
- **Orden de la galería:** la barbería puede **fijar** fotos al inicio; el resto se ordena por fecha, de la más reciente a la más antigua.

### Consulta pública

- **Filtros:** la galería se filtra por categoría y por estilo.
- **Reservar desde una foto:** cada foto devuelve los datos para reservar _ese servicio con ese barbero_: barbería, barbero y los servicios activos de esa categoría que el barbero realiza.
- **Búsqueda:** la búsqueda de barberías (Fase 6) podrá filtrar por estilo más adelante. Su consulta de candidatos ya admite añadir filtros sin rehacerse.

### Perfil del barbero ampliado

- Especialidades (categorías y estilos), años de experiencia y valoración (promedio y número de valoraciones del barbero, Fase 11).

### Consentimiento, reportes y moderación

- **Consentimiento:** al subir una foto con personas, la barbería **declara** tener el consentimiento de las personas fotografiadas. Se guarda quién lo declaró y cuándo.
- **Reportes:** cualquier usuario puede reportar una foto. Soporte revisa (Fase 12) y puede ocultarla o retirarla, con motivo y auditoría. La barbería puede retirar las suyas en cualquier momento.
- **Moderación:** estados `VISIBLE`, `HIDDEN` y `REMOVED`, como las valoraciones. Retirar una foto borra también el archivo del almacenamiento.

## Fase 15 — Planes de suscripción para barberías

### Planes como datos

- **Planes:** nombre, precio mensual y anual, orden, visible y activo. Se administran desde el panel `ADMIN` sin cambios de código.
- **Ocultar, no eliminar:** un plan con suscriptores no se elimina; se oculta (deja de ofrecerse) y sus suscriptores siguen.
- **Periodo de prueba:** opcional por plan.

### Beneficios como derechos

- **Catálogo de tipos de beneficio en código:** clave estable y tipo.
  - **Límites numéricos:** barberos, sedes, fotos de galería, días destacados y mensajes al mes.
  - **Interruptores:** vender membresías, crear promociones, galería por barbero, estadísticas, insignia verificada y soporte prioritario.
- **Asignación y valores como datos:** qué tipos tiene cada plan y con qué valor.
- **Comisión por reserva según el plan.** Reemplaza el `CHARLES_FEE_AMOUNT = 0` actual: la línea `FEE` del desglose ya existe desde la Fase 8A.

### Servicio de derechos

- `EntitlementsService.has(barbershopId, key)`, `limit(barbershopId, key)` y `remaining(barbershopId, key)` son la **única** fuente que consultan los demás módulos.
- **Barbería sin suscripción:** recibe el plan gratis.
- **Rendimiento:** caché corta e invalidación al cambiar de plan.

### Cobro recurrente

- **Detrás de `PaymentGateway`:** con reintentos y periodo de gracia (configurables).
- **Si no se paga:** al terminar la gracia, la barbería baja al **plan gratis sin perder datos ni reservas**. Lo que excede el nuevo límite queda inactivo (por ejemplo, barberos o fotos de más), no se borra, y se reactiva si vuelve a subir de plan.
- **Disponibilidad en Izipay por confirmar:** si Izipay ofrece cobros recurrentes programados. Si no, el cobro programado lo hace Charles con un token de pago guardado, nunca con datos de tarjeta.

### Cambios de precio

- **Suscripciones nuevas:** el precio nuevo aplica de inmediato.
- **Suscripciones existentes:** el precio nuevo aplica desde la siguiente renovación, con aviso previo (Fase 10).

## Fase 16 — Membresías para clientes

- **Quién las crea:** la barbería, solo si su plan incluye el derecho "vender membresías" (Fase 15).
- **Cómo funcionan:** el cliente paga una membresía y recibe **créditos periódicos**, y reserva con esos créditos en lugar de pagar cada reserva. El cobro de la reserva de la Fase 7 admite un medio de pago "créditos".
- **Si la barbería pierde el derecho:** no vende membresías nuevas, pero **las vigentes se respetan hasta el fin del periodo pagado**.
- **Por definir en la fase:** vencimiento y acumulación de créditos, cancelación y devolución.

## Ampliación de la Fase 13 — Auspiciadores

- **Público de cada campaña:** clientes, barberías o ambos.
- **Espacios publicitarios:** además de los de la app del cliente, en las pantallas de la barbería.
- **Catálogo de productos por auspiciador**, con enlace externo de compra. **Charles no vende ni cobra productos:** solo muestra y registra impresiones y clics (`sponsor_events`).
- **Destacados:** siguen la estrategia de ranking de la Fase 6 (`RankingStrategy`), con `featured: true`. Los días destacados pueden depender del plan (Fase 15).

## Consecuencias

- La Fase 12 crea `ADMIN` y `/api/v1/admin`. Ahí se administrarán categorías, estilos, planes, beneficios y auspiciadores.
- Ninguna fase anterior debe consultar directamente el plan de una barbería. Mientras no exista la Fase 15, los límites siguen siendo los actuales.
- Decisiones abiertas en `docs/pendientes-produccion.md`:
  - proveedor de almacenamiento;
  - planes, precios, beneficios y comisión por plan;
  - periodo de prueba;
  - cobro recurrente en Izipay;
  - políticas de Apple y Google sobre suscripciones dentro de la app.
