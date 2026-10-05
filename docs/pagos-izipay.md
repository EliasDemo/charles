# Pagos con Izipay — referencias para la Fase 8

Decisión registrada en [ADR 0002](adr/0002-pasarela-izipay-e-impuestos.md). **Todavía no hay integración:** hasta la Fase 8 se usa `FakeGateway`.

> **Credenciales:** ninguna credencial de Izipay, **ni siquiera las de prueba**, se guarda en el repositorio, en `.env.example`, en pruebas ni en seeds. Viven en el gestor de secretos y se inyectan como variables de entorno.

## Referencias

| Recurso                        | Enlace                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Portal de pruebas              | [testdevelopers.izipay.pe](https://testdevelopers.izipay.pe)                                                   |
| Portal de producción           | [developers.izipay.pe](https://developers.izipay.pe)                                                           |
| Demo Android (SDK PaymentForm) | [github.com/izipay-pe/Sdk-PaymentForm-Java-Android](https://github.com/izipay-pe/Sdk-PaymentForm-Java-Android) |
| Demo iOS (SDK PaymentForm)     | [github.com/izipay-pe/Sdk-PaymentForm-Swift-iOS](https://github.com/izipay-pe/Sdk-PaymentForm-Swift-iOS)       |
| Ejemplo de IPN en JavaScript   | [github.com/izipay-pe/Server-IPN-JavaScript](https://github.com/izipay-pe/Server-IPN-JavaScript)               |

## Pendientes

- [ ] **(a) Plataforma de Izipay.** Confirmar si se usará **developers.izipay.pe** o **micuentaweb**. Las demos enlazadas apuntan a micuentaweb, y la elección cambia los endpoints, el formato de las credenciales y la verificación de firma del IPN.
- [ ] **(b) SDK nativo con Expo.** Definir cómo integrar los SDK nativos de Android e iOS en la app de Expo (React Native). Opciones a evaluar: módulo nativo propio con _config plugin_ y _development build_, o un flujo web (formulario embebido o redirección) que no requiera SDK nativo.

## Requisitos que debe cumplir la integración (CLAUDE.md)

- La reserva pasa a `CONFIRMED` **solo** por un aviso (IPN) verificado de Izipay, nunca por lo que reporte la app.
- El IPN se procesa así:
  - se verifica la firma;
  - se rechazan los avisos antiguos;
  - se procesa con idempotencia por `provider_event_id` (`payment_events`).
- Charles nunca almacena ni procesa número de tarjeta, CVV ni vencimiento. Solo guarda identificadores y tokens del proveedor.
- La cabecera `Idempotency-Key` es obligatoria al crear pagos (`payments.idempotency_key`).
- El esquema sigue siendo independiente del proveedor (`provider = 'IZIPAY'`).
