require('dotenv').config();

module.exports = {
    // Nombre del evento
    EVENTO_NOMBRE: process.env.EVENTO_NOMBRE || "Gran Quiniela Vecinal - Barrio Carolina II",

    // Rango de números (por defecto del 00 al 99)
    NUMERO_MIN: parseInt(process.env.NUMERO_MIN || "0", 10),
    NUMERO_MAX: parseInt(process.env.NUMERO_MAX || "99", 10),
    DIGITOS_PAD: parseInt(process.env.DIGITOS_PAD || String(process.env.NUMERO_MAX || "99").length, 10),

    // Valor de cada número en pesos
    PRECIO_NUMERO: parseInt(process.env.PRECIO_NUMERO || "1000", 10),

    // Datos para la transferencia / pago
    DATOS_PAGO: {
        alias: process.env.PAGO_ALIAS || "barrio.carolina.pagos",
        cbu: process.env.PAGO_CBU || "0000003100010000000000",
        titular: process.env.PAGO_TITULAR || "Comisión Vecinal Barrio Carolina II",
        banco: process.env.PAGO_BANCO || "Mercado Pago / Banco"
    },

    // Tiempo límite sugerido para transferir luego de reservar (en horas)
    HORAS_LIMITE_PAGO: parseInt(process.env.HORAS_LIMITE_PAGO || "24", 10),

    // Configuración de Premios y Modalidad del Sorteo (leídos desde .env)
    PREMIOS: process.env.PREMIOS || "🥇 1° Premio: A definir\n🥈 2° Premio: A definir",
    FECHA_SORTEO: process.env.FECHA_SORTEO || "A confirmar al completar los números",
    MODALIDAD_SORTEO: process.env.MODALIDAD_SORTEO || "Se sortea por Quiniela Nocturna (últimas cifras).",

    // Teléfonos de Administradores (formato internacional sin signos, ej: '5491112345678')
    ADMIN_PHONES: (process.env.ADMIN_PHONES || "").split(',').map(p => p.trim()).filter(Boolean),

    // ID del grupo de WhatsApp para recordatorios automáticos (ej: '120363012345678@g.us')
    GRUPO_ID: process.env.GRUPO_ID || "",

    // Programación de recordatorios automáticos (Cron: por defecto a las 11:00 y 19:00 todos los días)
    CRON_RECORDATORIO: process.env.CRON_RECORDATORIO || "0 11,19 * * *",

    // Token de acceso de Mercado Pago para generación automática de links de pago
    MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN || "",

    // Configuración del servidor Webhook
    PORT: parseInt(process.env.PORT || "3000", 10),
    WEBHOOK_URL: process.env.WEBHOOK_URL || "",

    // Prefijo de comandos
    PREFIX: "!"
};
