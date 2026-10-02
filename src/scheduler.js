const cron = require('node-cron');
const config = require('./config');
const db = require('./db');

/**
 * Construye el mensaje de recordatorio automático con datos en tiempo real
 */
function buildReminderMessage(customText = null) {
    const summary = db.getSummary();
    const libres = db.getAvailableNumbers();

    if (customText) {
        return `📢 *COMUNICADO OFICIAL - ${config.EVENTO_NOMBRE}* 📢\n\n${customText}`;
    }

    let msg = `🎲 *RECORDATORIO: ${config.EVENTO_NOMBRE}* 🎲\n\n`;
    
    if (summary.libres === 0) {
        msg += `🔥 *¡TODOS LOS NÚMEROS HAN SIDO VENDIDOS / RESERVADOS!*\n`;
        msg += `Agradecemos a todos los vecinos por su participación.\n`;
        msg += `💡 Si aún tienes un número pendiente de pago, recuerda abonarlo para asegurar tu jugada.`;
        return msg;
    }

    msg += `⏳ *Estado actual:* Quedan *${summary.libres} números disponibles* (de ${summary.total}).\n`;
    msg += `💰 *Valor por número:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n`;
    
    // Muestra una muestra de números libres
    const muestraLibres = libres.slice(0, 15).join(' - ');
    msg += `📋 *Algunos números libres:* ${muestraLibres}${libres.length > 15 ? '...' : ''}\n\n`;
    
    msg += `👉 *¿Cómo participar?*\n`;
    msg += `Escribe en este grupo:\n`;
    msg += `\`!elegir <número> <TuNombre> <TuCasa>\`\n`;
    msg += `*(Ejemplo: \`!elegir 24 Maria Casa 08\`)*\n\n`;
    msg += `📋 Para ver la lista completa de números libres: \`!libres\`\n`;
    msg += `💳 Datos de transferencia: \`!alias\``;

    return msg;
}

/**
 * Envía un anuncio o recordatorio a un grupo específico
 */
async function sendBroadcast(client, targetChatId, text) {
    if (!targetChatId) {
        throw new Error('No se ha especificado el ID del grupo.');
    }
    return await client.sendMessage(targetChatId, text);
}

/**
 * Inicializa las tareas programadas (Cron Jobs)
 */
function initScheduler(client) {
    if (!config.RECORDATORIOS_ACTIVOS) {
        console.log('[Scheduler] Recordatorios automáticos desactivados en configuración.');
        return;
    }

    if (!config.GRUPO_ID) {
        console.log('[Scheduler] ⚠️ No se configuró GRUPO_ID en .env. Los recordatorios automáticos no se enviarán hasta que configures el ID del grupo.');
        console.log('[Scheduler] 👉 Para obtener el ID, escribe !idgrupo en el grupo de WhatsApp deseado.');
        return;
    }

    // Validar expresión cron
    if (!cron.validate(config.CRON_RECORDATORIO)) {
        console.error(`[Scheduler Error] Expresión Cron inválida: "${config.CRON_RECORDATORIO}"`);
        return;
    }

    console.log(`[Scheduler] ⏰ Recordatorios programados con la expresión cron: "${config.CRON_RECORDATORIO}" para el grupo: ${config.GRUPO_ID}`);

    cron.schedule(config.CRON_RECORDATORIO, async () => {
        console.log('[Scheduler] 🚀 Ejecutando envío de recordatorio automático...');
        try {
            const message = buildReminderMessage();
            await sendBroadcast(client, config.GRUPO_ID, message);
            console.log('[Scheduler] ✅ Recordatorio enviado con éxito.');
        } catch (error) {
            console.error('[Scheduler Error] Falló el envío del recordatorio automático:', error);
        }
    });
}

module.exports = {
    buildReminderMessage,
    sendBroadcast,
    initScheduler
};
