# ADR 0003 — Registro, verificación de correo y edad mínima

- **Estado:** aceptada
- **Fecha:** 2026-10-05

## Contexto

RF-AUT-001 dice en su flujo alternativo 10: "si la cuenta ya existe, el sistema informa que el usuario ya está registrado". Hacerlo así permite **enumerar cuentas**: cualquiera podría averiguar si un correo está registrado en Charles. CLAUDE.md ya exige respuestas que no revelen la existencia de la cuenta en el inicio de sesión y en la recuperación de acceso.

## Decisión

### Registro con respuesta idéntica (se aparta del texto de RF-AUT-001 por seguridad)

`POST /api/v1/auth/register` responde **siempre** `202` con el mismo cuerpo, exista o no el correo:

- **Correo nuevo:** se crea la cuenta `CLIENT` y se envía un código de verificación.
- **Correo existente:** no se crea nada y se envía al dueño del correo un aviso de "intento de registro con tu correo", con indicaciones para iniciar sesión o recuperar el acceso.

Así, quien se registra con un correo que ya tiene cuenta se entera **por su correo**, no por la API. El objetivo del RF (que el usuario sepa que ya está registrado) se cumple sin exponer la información a terceros.

Para que el tiempo de respuesta tampoco delate la existencia del correo, ambos caminos:

- calculan el hash Argon2id de la contraseña;
- encolan un trabajo de correo;
- envían el correo fuera de la petición, desde una cola BullMQ.

Una prueba e2e compara el código, el cuerpo y el tiempo de respuesta de los dos casos.

**Consecuencia:** el registro no devuelve tokens. El usuario inicia sesión después de registrarse.

### Verificación de correo

El usuario puede iniciar sesión sin verificar su correo. El correo verificado se exigirá para reservar (Fase 7). Para la verificación se usa:

- un código de 6 dígitos con validez de 15 minutos y de un solo uso;
- solo se guarda su HMAC;
- se invalida tras 5 intentos fallidos, que además cuentan para el bloqueo por cuenta e IP.

### Edad mínima: 18 años

El registro exige marcar una casilla que declara tener 18 años o más (`declaresAdult: true`) junto con la aceptación de los términos. Se guarda la fecha de la declaración en `users.adult_declared_at`. No se pide la fecha de nacimiento.

**⚠️ Decisión a validar legalmente:** la suficiencia de una autodeclaración, la edad mínima y el tratamiento de datos de menores deben revisarse con asesoría legal antes del lanzamiento.

`adult_declared_at` admite nulos solo por las cuentas creadas antes de esta regla, que en desarrollo son los usuarios del seed. Toda cuenta registrada por la API la tiene.

## Consecuencias

- Los clientes (apps) deben mostrar tras el registro un mensaje del tipo "revisa tu correo" y luego la pantalla de inicio de sesión.
- Sin un proveedor de correo real (Fase 10), en desarrollo los correos quedan en Redis (`FakeMailer`).
