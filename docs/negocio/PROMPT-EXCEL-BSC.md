# Prompt: Excel funcional del Balanced Scorecard (BSC) de Charles

Copia todo lo que está debajo de la línea en la herramienta que generará el Excel (Copilot en Excel, Claude, ChatGPT u otra). Es coherente con el modelo de negocio y precios de `PROMPT-PPT-MODELO-NEGOCIO.md`. Las metas y los datos de ejemplo son **de demostración**.

---

## ROL

Actúa como **consultor de control de gestión y experto en Excel**. Construye un libro de Excel **funcional** (.xlsx) que implemente el **Balanced Scorecard (Cuadro de Mando Integral, de Kaplan y Norton)** de **Charles**, una plataforma peruana para barberías. Al ingresar los datos de cada mes, el libro debe calcular solo los indicadores, los semáforos y el avance de cada objetivo y de la estrategia.

## CONTEXTO DEL NEGOCIO

Charles conecta a **clientes**, **barberías**, **barberos** y **empresas auspiciadoras**.

**Qué ofrece:**

- **App del cliente:** búsqueda en mapa, reservas con pago en línea (Mercado Pago: tarjeta y Yape), valoraciones, chat con la barbería, cupones y recomendación de cortes según la forma de la cara.
- **Panel de la barbería:**
  - agenda, barberos, servicios y galería;
  - gestión de clientes (CRM) y ranking de clientes habituales (Bronce, Plata, Oro);
  - catálogo de cortes;
  - venta en el local sin reserva, con boleta electrónica SUNAT;
  - caja y reportes;
  - membresías para sus clientes.
- **Barbero:** perfil profesional propio, ranking, portafolio con videos y bolsa de trabajo.
- **Auspiciadores:** campañas de publicidad con métricas de impresiones y clics.

**Tres tipos de promoción:**

- de la barbería a sus clientes;
- de Charles a todos los clientes;
- de auspiciadores.

**Cinco fuentes de ingreso:**

1. suscripción de la barbería;
2. comisión por reserva pagada en la app;
3. publicidad de auspiciadores;
4. destacados pagados;
5. valor agregado: boletas por encima del límite y comisión sobre membresías.

**Planes de demostración:**

| Plan    | Precio mensual | Comisión por reserva |
| ------- | -------------- | -------------------- |
| Gratis  | S/ 0           | 8 %                  |
| Pro     | S/ 59          | 5 %                  |
| Premium | S/ 129         | 3 %                  |

Los planes Pro y Premium tienen 14 días de prueba. Si no se paga, hay 7 días de gracia y luego la barbería baja a Gratis sin perder datos.

**Misión:** "Hacer crecer a las barberías del Perú con tecnología simple: más clientes, mejor gestión y una carrera digna para el barbero".

**Visión (2029):** "Ser el sistema de gestión y reservas líder de barberías en el Perú".

**Estrategia:** freemium con penetración rápida; luego, crecimiento por valor (subir barberías a Pro y Premium) y monetización del ecosistema (auspiciadores).

## LAS CUATRO PERSPECTIVAS: OBJETIVOS E INDICADORES

Usa exactamente estos objetivos e indicadores. Para cada indicador, crea las columnas:

- **Código** y **Objetivo**.
- **Indicador** y **Fórmula de cálculo** (en texto).
- **Unidad**: %, S/, número o días.
- **Frecuencia**.
- **Polaridad**: ↑ mayor es mejor, o ↓ menor es mejor.
- **Línea base**, **Meta** y **Umbral rojo**.
- **Peso** dentro de la perspectiva.
- **Responsable**: Dirección, Comercial, Producto, Operaciones o Soporte.
- **Iniciativa estratégica asociada**.

### 1. Perspectiva financiera (peso 30 %)

| Cód. | Objetivo                    | Indicador                                 | Fórmula                                                                            | Polaridad | Meta mensual (demo) |
| ---- | --------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- | --------- | ------------------- |
| F1   | Crecer ingresos recurrentes | MRR (ingreso mensual recurrente)          | Σ(suscriptores Pro × 59) + Σ(Premium × 129)                                        | ↑         | S/ 15 000           |
| F2   | Crecer ingresos recurrentes | Crecimiento del MRR                       | (MRR mes − MRR mes anterior) / MRR mes anterior                                    | ↑         | 8 %                 |
| F3   | Diversificar ingresos       | % ingresos no provenientes de suscripción | (comisiones + auspiciadores + destacados + valor agregado) / ingresos totales      | ↑         | 45 %                |
| F4   | Rentabilidad por cliente    | ARPU por barbería de pago                 | ingresos totales / barberías de pago                                               | ↑         | S/ 95               |
| F5   | Rentabilidad por cliente    | Relación LTV / CAC                        | (ARPU × margen bruto / churn) / CAC                                                | ↑         | ≥ 3                 |
| F6   | Controlar costos            | Margen bruto                              | (ingresos − costos directos: pasarela, servidores, SMS/correo, boletas) / ingresos | ↑         | 70 %                |

### 2. Perspectiva del cliente (peso 30 %)

Aquí hay dos tipos de cliente: **barberías** (las que pagan) y **usuarios finales**.

| Cód. | Objetivo                   | Indicador                            | Fórmula                                                                | Polaridad | Meta (demo) |
| ---- | -------------------------- | ------------------------------------ | ---------------------------------------------------------------------- | --------- | ----------- |
| C1   | Captar barberías           | Barberías nuevas registradas         | conteo del mes                                                         | ↑         | 60          |
| C2   | Convertir a pago           | Conversión de Gratis a pago          | barberías que pasan a Pro/Premium / barberías Gratis activas al inicio | ↑         | 6 %         |
| C3   | Retener barberías          | Churn mensual de barberías de pago   | barberías que cancelan o bajan a Gratis / barberías de pago al inicio  | ↓         | ≤ 4 %       |
| C4   | Satisfacer a la barbería   | NPS de barberías                     | % promotores − % detractores (encuesta trimestral)                     | ↑         | ≥ 40        |
| C5   | Atraer usuarios finales    | Usuarios activos mensuales (MAU)     | usuarios con al menos una sesión en el mes                             | ↑         | 8 000       |
| C6   | Fidelizar usuarios finales | Tasa de clientes recurrentes         | clientes con 2 o más atenciones en 60 días / clientes atendidos        | ↑         | 45 %        |
| C7   | Calidad percibida          | Valoración promedio de las barberías | promedio de estrellas del mes                                          | ↑         | ≥ 4,5       |
| C8   | Atraer auspiciadores       | Auspiciadores con campaña activa     | conteo                                                                 | ↑         | 5           |

### 3. Perspectiva de procesos internos (peso 25 %)

| Cód. | Objetivo                | Indicador                                | Fórmula                                         | Polaridad | Meta (demo) |
| ---- | ----------------------- | ---------------------------------------- | ----------------------------------------------- | --------- | ----------- |
| P1   | Reservas eficientes     | Reservas pagadas en la app               | conteo del mes                                  | ↑         | 6 000       |
| P2   | Reservas eficientes     | Tasa de inasistencia                     | inasistencias / reservas confirmadas            | ↓         | ≤ 8 %       |
| P3   | Digitalizar el local    | Ventas en el local con boleta            | conteo de ventas sin reserva con boleta emitida | ↑         | 3 000       |
| P4   | Pagos confiables        | Tasa de pagos aprobados                  | pagos aprobados / intentos de pago              | ↑         | ≥ 92 %      |
| P5   | Promociones efectivas   | Tasa de canje de promociones             | cupones canjeados / cupones emitidos            | ↑         | 15 %        |
| P6   | Auspiciadores rentables | CTR de campañas                          | clics / impresiones                             | ↑         | 2,5 %       |
| P7   | Soporte ágil            | Tiempo promedio de resolución de tickets | Σ horas de resolución / tickets cerrados        | ↓         | ≤ 24 h      |
| P8   | Plataforma estable      | Disponibilidad del servicio              | minutos disponibles / minutos del mes           | ↑         | ≥ 99,5 %    |

### 4. Perspectiva de aprendizaje y crecimiento (peso 15 %)

| Cód. | Objetivo                   | Indicador                                 | Fórmula                                   | Polaridad | Meta (demo) |
| ---- | -------------------------- | ----------------------------------------- | ----------------------------------------- | --------- | ----------- |
| A1   | Profesionalizar al barbero | Barberos con perfil profesional completo  | perfiles completos / barberos registrados | ↑         | 60 %        |
| A2   | Profesionalizar al barbero | Videos de portafolio publicados           | conteo del mes                            | ↑         | 300         |
| A3   | Innovar el producto        | Funciones entregadas a tiempo             | entregas en fecha / entregas planificadas | ↑         | ≥ 80 %      |
| A4   | Calidad técnica            | Cobertura de pruebas automatizadas        | % de código cubierto por pruebas          | ↑         | ≥ 80 %      |
| A5   | Uso de datos e IA          | Uso de la recomendación por forma de cara | usuarios que la usan / MAU                | ↑         | 10 %        |
| A6   | Equipo capacitado          | Horas de capacitación del equipo          | horas en el mes                           | ↑         | 16          |

## INICIATIVAS ESTRATÉGICAS (vincúlalas a los objetivos)

| Cód. | Iniciativa                                                     | Objetivos  | Inicio | Fin | Presupuesto (demo) | Avance % |
| ---- | -------------------------------------------------------------- | ---------- | ------ | --- | ------------------ | -------- |
| I1   | Lanzar los planes Pro y Premium con prueba gratis              | F1, F2, C2 | ene    | mar | S/ 4 000           | —        |
| I2   | Panel de la barbería: CRM, ranking y punto de venta con boleta | C3, P3, F3 | feb    | jun | S/ 12 000          | —        |
| I3   | Programa de referidos entre barberías                          | C1         | mar    | may | S/ 2 000           | —        |
| I4   | Campañas con auspiciadores (kit comercial)                     | F3, C8, P6 | abr    | dic | S/ 3 000           | —        |
| I5   | Recordatorios y política de inasistencia                       | P2, C6     | ene    | feb | S/ 800             | —        |
| I6   | Academia del barbero (perfil y videos)                         | A1, A2     | may    | ago | S/ 2 500           | —        |
| I7   | Membresías para clientes                                       | F3, C6     | jul    | oct | S/ 5 000           | —        |
| I8   | IA de recomendación de cortes, etapa 2                         | A5, C5     | ago    | dic | S/ 6 000           | —        |

## ESTRUCTURA DEL LIBRO (hojas en este orden)

1. **`Inicio`**
   - portada con el nombre, misión, visión y estrategia;
   - índice con **hipervínculos** a cada hoja;
   - instrucciones de uso en 5 pasos.
2. **`Parámetros`**: celdas de entrada en color amarillo claro, con **nombres definidos**:
   - año del plan y mes actual (lista desplegable de ene a dic);
   - precios de los planes y comisiones;
   - pesos de cada perspectiva (deben sumar 100 %; muestra una alerta si no);
   - umbrales del semáforo, con valores por defecto: verde si el cumplimiento es ≥ 100 %, amarillo si está entre 80 % y 99 %, rojo si es menor de 80 %.
3. **`Datos_Mensuales`**: tabla de Excel (`tblDatos`) con una fila por mes (ene a dic) y una columna por cada dato base. Los indicadores **se calculan** desde estos datos, nunca se escriben a mano. Datos base:
   - **Barberías:**
     - Gratis, Pro y Premium al inicio y al final del mes;
     - barberías nuevas;
     - altas de pago y bajas de pago.
   - **Ingresos por fuente** (S/): suscripciones, comisiones, auspiciadores, destacados y valor agregado.
   - **Costos:** costos directos, gasto de marketing y ventas (para el CAC).
   - **Usuarios:** MAU, clientes atendidos y clientes recurrentes.
   - **Reservas y ventas:**
     - reservas confirmadas e inasistencias;
     - reservas pagadas en la app;
     - ventas en el local con boleta;
     - intentos de pago y pagos aprobados.
   - **Promociones y auspiciadores:**
     - cupones emitidos y canjeados;
     - impresiones y clics;
     - auspiciadores activos.
   - **Soporte y plataforma:**
     - tickets cerrados y horas totales de resolución;
     - minutos de caída del servicio.
   - **Barberos y producto:**
     - perfiles completos y barberos registrados;
     - videos publicados;
     - entregas a tiempo y entregas planificadas;
     - cobertura de pruebas.
   - **Equipo e IA:**
     - usuarios de la recomendación por forma de cara;
     - horas de capacitación.
   - **Encuestas trimestrales:** NPS y valoración promedio.
   - Llena **ene a jun con datos de ejemplo realistas** y crecientes, con algún mes malo para que se vean los semáforos en rojo. Deja **jul a dic vacíos**.
4. **`Indicadores`**: la ficha de los 28 indicadores con las columnas indicadas arriba, más:
   - **Valor real del mes seleccionado**, calculado con `INDEX/MATCH` o `XLOOKUP` sobre `tblDatos` según el mes elegido en `Parámetros`;
   - **% de cumplimiento**, con fórmula según la polaridad:
     - si es ↑: `=MIN(real/meta;1,5)`;
     - si es ↓: `=MIN(meta/real;1,5)`;
     - controla las divisiones entre cero con `IFERROR`;
   - **Semáforo**: texto "Verde", "Amarillo" o "Rojo" con formato condicional de color y un conjunto de iconos;
   - **Tendencia** frente al mes anterior: ▲, ▼ o ▬;
   - **Puntaje ponderado** = cumplimiento × peso.
5. **`Mapa_Estrategico`**: el mapa estratégico dibujado con formas de Excel.
   - Las 4 franjas horizontales, de abajo hacia arriba: Aprendizaje, Procesos, Cliente y Financiera.
   - Una caja por objetivo, con **flechas de causa-efecto**, por ejemplo: A1 → P3 → C6 → F3, y P2 → C7 → C3 → F1.
   - Cada caja toma el color de su semáforo mediante una celda vinculada, o con una cuadrícula de celdas coloreadas por formato condicional si las formas no lo permiten.
6. **`Dashboard`**: el tablero de control del mes seleccionado, en una sola pantalla.
   - **Arriba:** selector del mes y 4 tarjetas grandes con el puntaje de cada perspectiva, el % y el semáforo, más un **índice global de la estrategia** (promedio ponderado).
   - **Centro, gráficos:**
     - velocímetro (gráfico de anillo) del índice global;
     - barras de cumplimiento por perspectiva;
     - línea del MRR real frente a la meta, de ene a dic;
     - barras apiladas de ingresos por fuente;
     - embudo de barberías: registradas → Gratis activas → de pago;
     - línea del churn frente al umbral.
   - **Abajo:**
     - tabla "Top 5 indicadores en rojo", con `SORTBY`/`FILTER`, o `LARGE` + `INDEX` si no hay funciones dinámicas;
     - estado de las iniciativas.
7. **`Iniciativas`**:
   - la tabla de iniciativas con un **diagrama de Gantt** hecho con formato condicional sobre las columnas de ene a dic;
   - avance % (ingresado), presupuesto y gasto real;
   - desviación = gasto − presupuesto;
   - semáforo de avance frente al tiempo transcurrido.
8. **`Tendencias`**: una mini serie (sparkline) por indicador a lo largo de ene a dic, y la meta y el real en columnas paralelas.
9. **`Glosario`**: definiciones claras de MRR, ARPU, CAC, LTV, churn, NPS, MAU, CTR, freemium, polaridad, cumplimiento y BSC.

## REGLAS DE FUNCIONAMIENTO

- **Todo calculado:** solo son editables las celdas amarillas de `Parámetros`, `Datos_Mensuales` y el avance de `Iniciativas`. Todo lo demás son fórmulas.
- **Protección:** protege las hojas sin contraseña y deja desbloqueadas solo las celdas de entrada.
- **Validación de datos:**
  - listas desplegables para el mes, la polaridad, la frecuencia y el responsable;
  - números ≥ 0 en los datos;
  - porcentajes entre 0 y 100 %.
- **Sin errores visibles:** cubre con `IFERROR` los meses vacíos y muestra "—".
- **Nombres definidos** para los parámetros clave: `MesActual`, `PrecioPro`, `PrecioPremium`, `PesoFinanciera`, etc.
- **Compatibilidad:** Excel 365 y Excel 2019. Si usas `XLOOKUP`, `FILTER` o `SORTBY`, deja como alternativa una versión con `INDEX`/`MATCH`.
- **Sin macros (.xlsx)**, para que funcione en cualquier equipo y en Excel en línea.

## DISEÑO VISUAL

- Paleta de Charles:
  - carbón `#16181D` para encabezados;
  - dorado `#C9A227` como acento;
  - azul petróleo `#1F6F78`;
  - verde `#2E9E6B`, ámbar `#E3A72F` y coral `#E0644A` para los semáforos;
  - fondo blanco hueso `#F7F5F0`.
- Encabezados con fondo carbón y texto blanco; filas con bandas suaves; cuadrícula oculta en `Dashboard` y `Mapa_Estrategico`.
- Fuentes: Calibri o Aptos 10–11; títulos en 16–20 en negrita.
- Formatos: moneda `S/ #,##0`, porcentajes con 1 decimal y miles con separador.
- Paneles inmovilizados en las tablas y ancho de columnas ajustado.
- El `Dashboard` se imprime en una página horizontal (A4).

## ENTREGABLE Y VERIFICACIÓN

- Archivo **`Charles_BSC.xlsx`** con las 9 hojas.
- Al cambiar el mes en `Parámetros` (por ejemplo, de mar a jun), el `Dashboard`, el mapa y los semáforos se actualizan solos.
- Comprueba antes de entregar:
  1. Los pesos suman 100 %.
  2. Ningún indicador muestra `#DIV/0!` ni `#N/A`.
  3. Hay al menos un indicador en cada color con los datos de ejemplo.
  4. El índice global coincide con el promedio ponderado manual.
  5. Los hipervínculos del índice funcionan.
- Incluye una **breve guía** en la hoja `Inicio`: cómo cargar un mes nuevo, cómo cambiar una meta y cómo leer el semáforo.
