const config = require('./config');
const db = require('./db');
const scheduler = require('./scheduler');

/**
 * Obtiene el número telefónico limpio del remitente
 */
function getSenderPhone(msg) {
    // En grupos msg.author es el participante; en chat privado es msg.from
    const sender = msg.author || msg.from || '';
    return sender.replace(/@c\.us|@s\.whatsapp\.net|@lid/g, '');
}

/**
 * Verifica si el remitente es un administrador
 */
function isAdmin(phone) {
    if (!config.ADMIN_PHONES || config.ADMIN_PHONES.length === 0) {
        // Si no hay admins configurados en .env, permitimos para testing local inicial
        return true;
    }
    return config.ADMIN_PHONES.some(admin => phone.endsWith(admin) || admin.endsWith(phone));
}

/**
 * Manejador principal de comandos
 */
async function handleMessage(msg, client) {
    const body = (msg.body || '').trim();
    if (!body.startsWith(config.PREFIX)) return;

    const args = body.slice(config.PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    const senderPhone = getSenderPhone(msg);

    try {
        switch (command) {
            case 'ayuda':
            case 'help':
            case 'comandos':
                await cmdAyuda(msg, senderPhone);
                break;

            case 'elegir':
            case 'reserva':
            case 'reservar':
            case 'numero':
                await cmdElegir(msg, args, senderPhone);
                break;

            case 'libres':
            case 'disponibles':
                await cmdLibres(msg);
                break;

            case 'misnumeros':
            case 'minumero':
            case 'mis':
                await cmdMisNumeros(msg, senderPhone);
                break;

            case 'alias':
            case 'pago':
            case 'cbu':
            case 'datos':
                await cmdDatosPago(msg);
                break;

            case 'idgrupo':
            case 'grupo':
            case 'chatid':
                await cmdIdGrupo(msg);
                break;

            // --- COMANDOS DE ADMINISTRADOR ---
            case 'pagado':
            case 'confirmar':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdPagado(msg, args, senderPhone);
                break;

            case 'liberar':
            case 'cancelar':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdLiberar(msg, args);
                break;

            case 'pendientes':
            case 'deudores':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdPendientes(msg);
                break;

            case 'resumen':
            case 'balance':
            case 'estado':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdResumen(msg);
                break;

            case 'tablero':
            case 'lista':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdTablero(msg);
                break;

            case 'anuncio':
            case 'recordatorio':
            case 'difundir':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdAnuncio(msg, args, client);
                break;

            default:
                // Comando no reconocido
                break;
        }
    } catch (error) {
        console.error(`[Error ejecutando comando !${command}]:`, error);
        await msg.reply('⚠️ Ocurrió un error al procesar tu solicitud. Por favor intenta nuevamente.');
    }
}

// -------------------------------------------------------------
// IMPLEMENTACIÓN DE COMANDOS PÚBLICOS
// -------------------------------------------------------------

async function cmdAyuda(msg, senderPhone) {
    let text = `🎲 *${config.EVENTO_NOMBRE}* 🎲\n\n`;
    text += `*Comandos disponibles:*\n`;
    text += `• *!elegir <número> <Nombre> <Casa>* : Reservar un número (Ej: \`!elegir 42 Juan Casa 15\`)\n`;
    text += `• *!libres* : Ver la lista de números disponibles\n`;
    text += `• *!misnumeros* : Ver qué números tienes reservados/pagados\n`;
    text += `• *!alias* o *!pago* : Datos para realizar la transferencia\n`;
    text += `• *!idgrupo* : Ver el identificador de este chat/grupo\n`;
    text += `• *!ayuda* : Mostrar este menú\n`;

    if (isAdmin(senderPhone)) {
        text += `\n👑 *Comandos de Administrador:*\n`;
        text += `• *!pagado <número>* : Confirmar pago de un número\n`;
        text += `• *!liberar <número>* : Liberar un número reservado\n`;
        text += `• *!pendientes* : Listar reservas sin pagar\n`;
        text += `• *!resumen* : Balance y recaudación general\n`;
        text += `• *!tablero* : Listado completo de todos los números\n`;
        text += `• *!anuncio [texto]* : Enviar un recordatorio o comunicado al grupo\n`;
    }

    await msg.reply(text);
}

async function cmdElegir(msg, args, senderPhone) {
    if (args.length < 3) {
        await msg.reply(
            `⚠️ *Formato incorrecto.*\n\n` +
            `Por favor escribe:\n` +
            `👉 *!elegir <número> <Nombre> <Casa>*\n\n` +
            `*Ejemplo:* \`!elegir 42 Carlos Gomez Casa 18\``
        );
        return;
    }

    const numInput = args[0];
    const casa = args.pop(); // Último argumento es la casa/lote
    const vecino = args.slice(1).join(' '); // El resto es el nombre

    const result = db.reserveNumber(numInput, vecino, casa, senderPhone);

    if (!result.success) {
        await msg.reply(`❌ ${result.message}`);
        return;
    }

    const resp = 
        `🎉 ¡Felicitaciones *${vecino}* (*${casa}*)!\n\n` +
        `🟡 Reservaste el número: *${result.numero}*\n` +
        `💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n` +
        `🏦 *Datos para transferir:*\n` +
        `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
        `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
        `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
        `• *Banco:* ${config.DATOS_PAGO.banco}\n\n` +
        `⚠️ *Importante:* Envía el comprobante de transferencia al administrador dentro de las *${config.HORAS_LIMITE_PAGO} hs* para confirmar tu jugada. ¡Muchas gracias!`;

    await msg.reply(resp);
}

async function cmdLibres(msg) {
    const libres = db.getAvailableNumbers();
    if (libres.length === 0) {
        await msg.reply('🔥 ¡Todos los números ya han sido reservados o comprados! No quedan números disponibles.');
        return;
    }

    let text = `📋 *Números Disponibles (${libres.length}/${config.NUMERO_MAX - config.NUMERO_MIN + 1}):*\n\n`;
    text += libres.join(' - ');
    text += `\n\n💡 Para elegir tu número, escribí: *!elegir <número> <TuNombre> <TuCasa>*`;

    await msg.reply(text);
}

async function cmdMisNumeros(msg, senderPhone) {
    const userNums = db.getUserNumbers(senderPhone);
    if (userNums.length === 0) {
        await msg.reply('ℹ️ No tienes ningún número reservado con este teléfono.\nEscribí *!libres* para ver cuáles están disponibles.');
        return;
    }

    let text = `🎟️ *Tus números registrados:*\n\n`;
    for (const item of userNums) {
        const estadoEmoji = item.estado === 'PAGADO' ? '🟢 PAGADO' : '🟡 PENDIENTE DE PAGO';
        text += `• Número *${item.numero}* -> ${estadoEmoji} (${item.vecino} - ${item.casa})\n`;
    }

    text += `\n💡 Escribí *!alias* para ver los datos de transferencia.`;
    await msg.reply(text);
}

async function cmdDatosPago(msg) {
    const text = 
        `💳 *DATOS DE PAGO / TRANSFERENCIA* 💳\n\n` +
        `💰 *Valor por número:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
        `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
        `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
        `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
        `• *Banco:* ${config.DATOS_PAGO.banco}\n\n` +
        `📲 Envía el comprobante al administrador para confirmar tu número.`;

    await msg.reply(text);
}

async function cmdIdGrupo(msg) {
    const isGroup = msg.from.includes('@g.us');
    if (isGroup) {
        await msg.reply(`🆔 *ID de este Grupo:* \`${msg.from}\`\n\n💡 Puedes copiar este código y colocarlo en el archivo \`.env\` como \`GRUPO_ID=${msg.from}\` para los mensajes automáticos.`);
    } else {
        await msg.reply(`ℹ️ Este comando debe enviarse dentro de un *grupo de WhatsApp* para conocer su ID.`);
    }
}

// -------------------------------------------------------------
// IMPLEMENTACIÓN DE COMANDOS DE ADMINISTRADOR
// -------------------------------------------------------------

async function cmdPagado(msg, args, adminPhone) {
    if (args.length === 0) {
        await msg.reply('⚠️ Debes especificar el número a confirmar. Ejemplo: `!pagado 42`');
        return;
    }

    const result = db.confirmPayment(args[0], adminPhone);
    if (!result.success) {
        await msg.reply(`❌ ${result.message}`);
        return;
    }

    const text = 
        `✅ *¡PAGO CONFIRMADO!*\n\n` +
        `• Número: *${result.numero}*\n` +
        `• Vecino: *${result.item.vecino}*\n` +
        `• Casa: *${result.item.casa}*\n` +
        `• Estado: 🟢 *PAGADO*`;

    await msg.reply(text);
}

async function cmdLiberar(msg, args) {
    if (args.length === 0) {
        await msg.reply('⚠️ Debes especificar el número a liberar. Ejemplo: `!liberar 42`');
        return;
    }

    const result = db.releaseNumber(args[0]);
    if (!result.success) {
        await msg.reply(`❌ ${result.message}`);
        return;
    }

    let text = `♻️ El número *${result.numero}* ha sido liberado y queda nuevamente disponible para cualquier vecino.`;
    if (result.anterior && result.anterior.vecino) {
        text += ` (Estaba a nombre de: ${result.anterior.vecino} - ${result.anterior.casa})`;
    }

    await msg.reply(text);
}

async function cmdPendientes(msg) {
    const pendientes = db.getPendingPayments();
    if (pendientes.length === 0) {
        await msg.reply('👏 ¡Excelente! No hay números pendientes de pago.');
        return;
    }

    let text = `⏳ *Números Reservados Pendientes de Pago (${pendientes.length}):*\n\n`;
    for (const item of pendientes) {
        text += `• *#${item.numero}* - ${item.vecino} (${item.casa})\n`;
    }
    text += `\n💡 Para confirmar un pago recibido, escribí: \`!pagado <número>\``;

    await msg.reply(text);
}

async function cmdResumen(msg) {
    const summary = db.getSummary();
    const porcentajeVenta = (( (summary.pagados + summary.reservados) / summary.total ) * 100).toFixed(1);

    const text = 
        `📊 *BALANCE GENERAL - ${config.EVENTO_NOMBRE}* 📊\n\n` +
        `• *Total de números:* ${summary.total}\n` +
        `• 🟢 *Pagados:* ${summary.pagados}\n` +
        `• 🟡 *Reservados (sin pagar):* ${summary.reservados}\n` +
        `• ⚪ *Libres:* ${summary.libres}\n` +
        `• 📈 *Ocupación:* ${porcentajeVenta}%\n\n` +
        `💰 *Recaudación Confirmada:* $${summary.recaudado.toLocaleString('es-AR')}\n` +
        `🎯 *Recaudación Potencial (total):* $${summary.potencial.toLocaleString('es-AR')}`;

    await msg.reply(text);
}

async function cmdTablero(msg) {
    const fs = require('fs');
    const path = require('path');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'quiniela.json'), 'utf-8'));

    let text = `📋 *TABLERO COMPLETO DE NÚMEROS:*\n\n`;
    for (const [num, data] of Object.entries(raw.numeros)) {
        if (data.estado === 'LIBRE') {
            text += `[${num}] ⚪ Libre\n`;
        } else if (data.estado === 'RESERVADO') {
            text += `[${num}] 🟡 ${data.vecino} (${data.casa}) - Pendiente\n`;
        } else if (data.estado === 'PAGADO') {
            text += `[${num}] 🟢 ${data.vecino} (${data.casa}) - Pagado\n`;
        }
    }

    await msg.reply(text);
}

async function cmdAnuncio(msg, args, client) {
    const targetChat = config.GRUPO_ID || (msg.from.includes('@g.us') ? msg.from : null);

    if (!targetChat) {
        await msg.reply('⚠️ No hay un grupo configurado en `GRUPO_ID` ni estás ejecutando el comando dentro de un grupo.');
        return;
    }

    const customText = args.length > 0 ? args.join(' ') : null;
    const messageToSend = scheduler.buildReminderMessage(customText);

    try {
        await scheduler.sendBroadcast(client, targetChat, messageToSend);
        if (msg.from !== targetChat) {
            await msg.reply('✅ Anuncio enviado exitosamente al grupo.');
        }
    } catch (error) {
        console.error('[Error al enviar anuncio]:', error);
        await msg.reply('❌ No se pudo enviar el anuncio al grupo. Verifica que el bot pertenezca al grupo y que el ID sea correcto.');
    }
}

module.exports = {
    handleMessage
};
