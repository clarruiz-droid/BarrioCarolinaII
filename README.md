# 🎲 Bot de Quiniela Vecinal - Barrio Carolina II

Bot interactivo de WhatsApp desarrollado en Node.js para gestionar la selección de números, control de reservas, seguimiento de pagos y recordatorios automáticos en eventos y quinielas comunitarias.

## 🚀 Funcionalidades

- **Lectura Automática de Comprobantes con IA (Gemini Vision):**
  - Los vecinos pueden enviar fotos o PDFs de sus comprobantes de transferencia (Mercado Pago, Cuenta DNI, BNA+, Ualá, bancos tradicionales).
  - La IA de Gemini extrae el monto, fecha, entidad y número de operación.
  - Si el monto cubre la deuda de los números reservados, **se acredita y marca como PAGADO automáticamente**, notificando al comprador y al grupo de administradores.
  - **Sistema Anti-Fraude:** Registro de identificadores de operación para prevenir comprobantes duplicados o reutilizados.
- **Elección interactiva y reserva de números:** Cada número solo puede ser reservado por un vecino en orden estricto.
- **Control de estados:** `LIBRE`, `RESERVADO` (pendiente de pago) y `PAGADO`.
- **Integración con Mercado Pago:** Generación de links de pago automáticos y Webhooks para acreditación instantánea.
- **Mensajes y recordatorios automáticos:** Envío programado mediante tareas cron (`node-cron`).
- **Comandos para vecinos:**
  - `!elegir <numero> <nombre> <casa>`: Reserva un número y entrega los datos de pago.
  - `!libres`: Lista los números disponibles.
  - `!misnumeros`: Muestra los números asociados al remitente y su estado de pago.
  - `!alias` o `!pago`: Muestra los datos de transferencia y monto.
  - `!idgrupo`: Muestra el ID único del grupo para configurarlo en el bot.
  - `!ayuda`: Lista todos los comandos.
- **Comandos para administradores:**
  - `!pagado <numero>`: Confirma el pago de un número de forma manual.
  - `!liberar <numero>`: Libera un número reservado.
  - `!pendientes`: Muestra el listado de números reservados aún sin pagar.
  - `!resumen` / `!balance`: Reporte de recaudación y balance general.
  - `!tablero`: Vista completa de todos los números y participantes.
  - `!anuncio [texto]`: Envía un comunicado o recordatorio inmediato al grupo.

## ⚙️ Configuración (.env)
Copia `.env.example` a `.env` para personalizar:
- `EVENTO_NOMBRE`: Nombre de la quiniela/evento.
- `PRECIO_NUMERO`: Valor de cada tarjeta.
- `PAGO_ALIAS`, `PAGO_CBU`, `PAGO_TITULAR`, `PAGO_BANCO`: Datos para transferencias.
- `ADMIN_PHONES`: Números de teléfono autorizados para comandos de administración.
- `ADMIN_GRUPO_ID` / `GRUPO_ID`: Identificadores de WhatsApp de grupos.
- `GEMINI_API_KEY`: API Key de Google Gemini ([Google AI Studio](https://aistudio.google.com/)).
- `AUTO_APROBAR_COMPROBANTES`: `true` para acreditar pagos automáticamente al leer el comprobante.
- `CRON_RECORDATORIO`: Expresión Cron de los horarios de recordatorio (por defecto: `0 11,19 * * *`).

## 📋 Requisitos y Ejecución
- Node.js v18+
- Ejecutar:
  ```bash
  npm install
  npm start
  ```

