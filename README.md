# 🎲 Bot de Quiniela Vecinal - Barrio Carolina II

Bot interactivo de WhatsApp desarrollado en Node.js para gestionar la selección de números, control de reservas, seguimiento de pagos y recordatorios automáticos en eventos y quinielas comunitarias.

## 🚀 Funcionalidades

- **Elección exclusiva de números:** Cada número solo puede ser reservado por un vecino.
- **Control de pagos:** Estados `LIBRE`, `RESERVADO` (pendiente de pago) y `PAGADO`.
- **Mensajes y recordatorios automáticos:** Envío programado mediante tareas cron (`node-cron`) al grupo oficial del barrio.
- **Comandos para vecinos:**
  - `!elegir <numero> <nombre> <casa>`: Reserva un número y entrega los datos de pago.
  - `!libres`: Lista los números disponibles.
  - `!misnumeros`: Muestra los números asociados al remitente y su estado de pago.
  - `!alias` o `!pago`: Muestra los datos de transferencia y monto.
  - `!idgrupo`: Muestra el ID único del grupo para configurarlo en el bot.
  - `!ayuda`: Lista todos los comandos.
- **Comandos para administradores:**
  - `!pagado <numero>`: Confirma el pago de un número.
  - `!liberar <numero>`: Libera un número reservado.
  - `!pendientes`: Muestra el listado de números reservados aún sin pagar.
  - `!resumen`: Reporte de recaudación y balance general.
  - `!tablero`: Vista completa de todos los números y participantes.
  - `!anuncio [texto]`: Envía un comunicado o recordatorio inmediato al grupo.

## ⚙️ Configuración (.env)
Copia `.env.example` a `.env` para personalizar:
- `EVENTO_NOMBRE`: Nombre de la quiniela/evento.
- `PRECIO_NUMERO`: Valor de cada tarjeta.
- `PAGO_ALIAS`, `PAGO_CBU`, `PAGO_TITULAR`, `PAGO_BANCO`: Datos para transferencias.
- `ADMIN_PHONES`: Números de teléfono autorizados para comandos de administración.
- `GRUPO_ID`: Identificador de WhatsApp del grupo donde se enviarán los recordatorios.
- `CRON_RECORDATORIO`: Expresión Cron de los horarios de recordatorio (por defecto: `0 11,19 * * *`).

## 📋 Requisitos y Ejecución
- Node.js v18+
- Ejecutar:
  ```bash
  npm install
  npm start
  ```
