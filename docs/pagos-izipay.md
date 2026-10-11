# Pagos con Izipay — referencias para la Fase 8

Decisión registrada en [ADR 0002](adr/0002-pasarela-izipay-e-impuestos.md). La **Fase 8A** (cerrada) construyó el sistema de pagos independiente del proveedor con `FakeGateway`; la **8B** agrega el adaptador de Izipay en modo de prueba.

**Referencia técnica detallada:** [docs/izipay/referencia.md](izipay/referencia.md) (API REST, SDK, firma y validaciones obligatorias; leída de la documentación oficial).

> **Credenciales:** ninguna credencial de Izipay, **ni siquiera las de prueba ni las de la tienda de demostración pública**, se guarda en el repositorio, en `.env.example`, en pruebas ni en seeds. En desarrollo viven en `apps/api/.env` (ignorado por git); en producción, en el gestor de secretos.

## Decisiones confirmadas (Fase 8B)

- **Plataforma:** botón de pagos de **developers.izipay.pe** (la que Izipay ofrece al afiliarse a "izipay online"). La referencia anterior, de **micuentaweb**, queda descartada.
- **App:** formulario web de Izipay dentro de un WebView (sin módulos nativos; funciona en Expo Go). Medios: tarjeta y Yape.
- **Comisión de Charles:** configurable por ADMIN (`fees.percent_bp`, `fees.fixed_amount`, `fees.payer`), congelada en cada reserva. Por defecto la asume la barbería y está en 0.
- **Comisión de Izipay en las devoluciones:** la asume la barbería (se descuenta en la liquidación, aún no implementada).
- **Documento de la barbería:** DNI o RUC. El cobro lo hace la cuenta de Izipay de Charles; el RUC que pide Izipay para devolver es el de Charles (`IZIPAY_RUC`).
- **Sin cuenta todavía** (proyecto universitario): todo se prueba con un simulador de Izipay que firma como el real. En desarrollo se usa `FakeGateway` (`PAYMENTS_GATEWAY=fake`).

Detalle técnico: [docs/izipay/referencia.md](izipay/referencia.md). Guía de la app: [docs/mobile/PAGOS.md](mobile/PAGOS.md).
