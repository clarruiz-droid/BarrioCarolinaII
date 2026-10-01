# 🎲 Bot de Quiniela Vecinal - Barrio Carolina II

Bot interactivo de WhatsApp desarrollado en Node.js para gestionar la selección de números, control de reservas y seguimiento de pagos en eventos y quinielas comunitarias.

## 🚀 Funcionalidades

- **Elección exclusiva de números:** Cada número solo puede ser reservado por un vecino.
- **Control de pagos:** Estado de cada número (`LIBRE`, `RESERVADO`, `PAGADO`).
- **Comandos para vecinos:**
  - `!elegir <numero> <nombre> <casa>`: Reserva un número y entrega los datos de pago.
  - `!libres`: Lista los números disponibles.
  - `!misnumeros`: Muestra los números asociados al remitente y su estado de pago.
  - `!alias` o `!pago`: Muestra los datos de transferencia y monto.
  - `!ayuda`: Lista todos los comandos.
- **Comandos para administradores:**
  - `!pagado <numero>`: Confirma el pago de un número.
  - `!liberar <numero>`: Libera un número reservado.
  - `!pendientes`: Muestra el listado de números reservados aún sin pagar.
  - `!resumen`: Reporte de recaudación y balance general.

## 📋 Requisitos
- Node.js v18+
- Cuenta de WhatsApp para escanear el código QR.
