const config = require('./config');
const db = require('./db');
const scheduler = require('./scheduler');

/**
 * Obtiene la información del remitente (número telefónico y ID de chat serializado)
 */
async function getSenderInfo(msg) {
    let rawId = msg.author || (msg.fromMe ? (msg.from.includes('@g.us') ? msg.to : msg.from) : msg.from) || '';
    let phone = rawId.replace(/@.*/, '');
    let serializedId = rawId;

    try {
        const contact = await msg.getContact();
        if (contact && contact.id) {
            serializedId = contact.id._serialized;
            phone = contact.number || contact.id.user || phone;
        }
    } catch {
        // Usar fallback con el ID crudo
    }

    return { phone, serializedId };
}

/**
 * Verifica si el remitente es un administrador
 */
function isAdmin(phone) {
    if (!config.ADMIN_PHONES || config.ADMIN_PHONES.length === 0) {
        return true;
    }
    return config.ADMIN_PHONES.some(admin => phone.endsWith(admin) || admin.endsWith(phone));
}

/**
 * Envía un mensaje privado al remitente de forma segura
 */
async function sendPrivate(client, targetId, text) {
    try {
        let dest = targetId;
        if (!dest.includes('@')) {
            dest = `${dest}@c.us`;
        }
        await client.sendMessage(dest, text);
        return true;
    } catch (e) {
        console.error(`[Error enviando privado a ${targetId}]:`, e.message);
        return false;
    }
}

/**
 * Manejador principal de comandos
 */
async function handleMessage(msg, client) {
    const body = (msg.body || '').trim();
    if (!body.startsWith(config.PREFIX)) return;

    const args = body.slice(config.PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    const { phone: senderPhone, serializedId } = await getSenderInfo(msg);

    let isGroup = false;
    let currentGroupId = null;
    try {
        const chat = await msg.getChat();
        isGroup = chat.isGroup;
        if (isGroup) {
            currentGroupId = chat.id._serialized;
        }
    } catch {
        isGroup = msg.from.includes('@g.us') || msg.to?.includes('@g.us');
        currentGroupId = msg.from.includes('@g.us') ? msg.from : msg.to;
    }

    // Filtro: Si es un grupo, solo atender en GRUPO_ID
    if (isGroup) {
        if (command === 'idgrupo' || command === 'grupo' || command === 'chatid') {
            await cmdIdGrupo(msg);
            return;
        }

        if (config.GRUPO_ID && currentGroupId !== config.GRUPO_ID) {
            return; // Ignorar silenciosamente otros grupos
        }
    }

    try {
        switch (command) {
            case 'ayuda':
            case 'help':
            case 'comandos':
                await cmdAyuda(msg, senderPhone, isGroup, client);
                break;

            case 'elegir':
            case 'reserva':
            case 'reservar':
            case 'numero':
                await cmdElegir(msg, args, senderPhone, serializedId, isGroup, client);
                break;

            case 'libres':
            case 'disponibles':
                await cmdLibres(msg, senderPhone, serializedId, isGroup, client);
                break;

            case 'misnumeros':
            case 'minumero':
            case 'mis':
                await cmdMisNumeros(msg, senderPhone, serializedId, isGroup, client);
                break;

            case 'alias':
            case 'pago':
            case 'cbu':
            case 'datos':
                await cmdDatosPago(msg, serializedId, isGroup, client);
                break;

            case 'idgrupo':
            case 'grupo':
            case 'chatid':
                await cmdIdGrupo(msg);
                break;

            case 'pagado':
            case 'confirmar':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdPagado(msg, args, senderPhone, isGroup, client);
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
                await cmdPendientes(msg, serializedId, isGroup, client);
                break;

            case 'resumen':
            case 'balance':
            case 'estado':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdResumen(msg, serializedId, isGroup, client);
                break;

            case 'tablero':
            case 'lista':
                if (!isAdmin(senderPhone)) {
                    await msg.reply('⛔ Este comando solo puede ser utilizado por administradores.');
                    return;
                }
                await cmdTablero(msg, serializedId, isGroup, client);
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

async function cmdAyuda(msg, senderPhone, isGroup, client) {
    let text = `🎲 *${config.EVENTO_NOMBRE}* 🎲\n\n`;
    text += `*Comandos para vecinos:*\n`;
    text += `• *!elegir <número> <Nombre> <Casa>* : Reservar un número (Ej: \`!elegir 042 Juan Casa 15\`)\n`;
    text += `• *!libres* : Ver la lista de números disponibles\n`;
    text += `• *!misnumeros* : Ver tus números reservados y estado de pago\n`;
    text += `• *!alias* : Datos para realizar la transferencia\n`;
    text += `• *!ayuda* : Mostrar este menú\n`;

    if (isAdmin(senderPhone)) {
        text += `\n👑 *Comandos de Administrador:*\n`;
        text += `• *!pagado <número>* : Confirmar pago de un número\n`;
        text += `• *!liberar <número>* : Liberar un número reservado\n`;
        text += `• *!pendientes* : Listar reservas sin pagar\n`;
        text += `• *!resumen* : Balance y recaudación general\n`;
        text += `• *!tablero* : Listado completo de todos los números\n`;
        text += `• *!anuncio [texto]* : Enviar un comunicado al grupo\n`;
        text += `• *!idgrupo* : Ver el identificador de este chat\n`;
    }

    await msg.reply(text);
}

async function cmdElegir(msg, args, senderPhone, serializedId, isGroup, client) {
    if (args.length < 3) {
        await msg.reply(
            `⚠️ *Formato incorrecto.*\n\n` +
            `Por favor escribe:\n` +
            `👉 *!elegir <número> <Nombre> <Casa>*\n\n` +
            `*Ejemplo:* \`!elegir 042 Carlos Gomez Casa 18\``
        );
        return;
    }

    const numInput = args[0];
    const casa = args.pop();
    const vecino = args.slice(1).join(' ');

    const result = db.reserveNumber(numInput, vecino, casa, senderPhone);

    if (!result.success) {
        await msg.reply(`❌ ${result.message}`);
        return;
    }

    const datosPagoMsg = 
        `🎉 ¡Felicitaciones *${vecino}* (*${casa}*)!\n\n` +
        `🟡 Reservaste el número: *${result.numero}*\n` +
        `💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n` +
        `🏦 *Datos para transferir:*\n` +
        `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
        `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
        `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
        `• *Banco:* ${config.DATOS_PAGO.banco}\n\n` +
        `⚠️ *Importante:* Envía el comprobante de transferencia al administrador dentro de las *${config.HORAS_LIMITE_PAGO} hs* para confirmar tu jugada.`;

    if (isGroup) {
        await msg.reply(
            `🎉 ¡Felicitaciones *${vecino}* (*${casa}*)!\n` +
            `🟡 Reservaste con éxito el número: *${result.numero}*\n\n` +
            `📲 *Te enviamos los datos de pago por mensaje privado.*`
        );
        await sendPrivate(client, serializedId, datosPagoMsg);
    } else {
        await msg.reply(datosPagoMsg);
    }
}

async function cmdLibres(msg, senderPhone, serializedId, isGroup, client) {
    const libres = db.getAvailableNumbers();
    const total = config.NUMERO_MAX - config.NUMERO_MIN + 1;

    if (libres.length === 0) {
        await msg.reply('🔥 ¡Todos los números ya han sido reservados o comprados! No quedan números disponibles.');
        return;
    }

    const fullListText = `📋 *Números Disponibles (${libres.length}/${total}):*\n\n` +
        libres.join(' - ') +
        `\n\n💡 Para elegir tu número, escribí: *!elegir <número> <TuNombre> <TuCasa>*`;

    if (isGroup && libres.length > 50) {
        const muestra = libres.slice(0, 30).join(' - ');
        await msg.reply(
            `📋 *NÚMEROS DISPONIBLES: Quedan ${libres.length} de ${total}*\n\n` +
            `*Muestra:* ${muestra}...\n\n` +
            `📲 *Te enviamos la lista completa por mensaje privado.*\n` +
            `💡 Para elegir: \`!elegir <número> <TuNombre> <TuCasa>\``
        );
        await sendPrivate(client, serializedId, fullListText);
    } else {
        await msg.reply(fullListText);
    }
}

async function cmdMisNumeros(msg, senderPhone, serializedId, isGroup, client) {
    const userNums = db.getUserNumbers(senderPhone);
    if (userNums.length === 0) {
        await msg.reply('ℹ️ No tienes ningún número reservado con este teléfono.\nEscribí *!libres* para ver los disponibles.');
        return;
    }

    let text = `🎟️ *Tus números registrados:*\n\n`;
    for (const item of userNums) {
        const estadoEmoji = item.estado === 'PAGADO' ? '🟢 PAGADO' : '🟡 PENDIENTE DE PAGO';
        text += `• Número *${item.numero}* -> ${estadoEmoji} (${item.vecino} - ${item.casa})\n`;
    }
    text += `\n💡 Escribí *!alias* para ver los datos de transferencia.`;

    if (isGroup) {
        await msg.reply(`📲 *${userNums[0].vecino}:* Te enviamos el detalle de tus números por mensaje privado.`);
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
}

async function cmdDatosPago(msg, serializedId, isGroup, client) {
    const text = 
        `💳 *DATOS DE PAGO / TRANSFERENCIA* 💳\n\n` +
        `💰 *Valor por número:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
        `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
        `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
        `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
        `• *Banco:* ${config.DATOS_PAGO.banco}\n\n` +
        `📲 Envía el comprobante al administrador para confirmar tu jugada.`;

    if (isGroup) {
        await msg.reply(
            `💳 *Datos de pago:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')} por número | Alias: \`${config.DATOS_PAGO.alias}\`\n` +
            `📲 *Detalle completo enviado por privado.*`
        );
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
}

async function cmdIdGrupo(msg) {
    try {
        const chat = await msg.getChat();
        if (chat.isGroup) {
            const groupId = chat.id._serialized;
            await msg.reply(`🆔 *ID de este Grupo:* \`${groupId}\`\n\n💡 Puedes copiar este código y colocarlo en el archivo \`.env\` como \`GRUPO_ID=${groupId}\` para los mensajes automáticos.`);
        } else {
            await msg.reply(`ℹ️ Este comando debe enviarse dentro de un *grupo de WhatsApp* para conocer su ID.`);
        }
    } catch (err) {
        const fallbackId = msg.to?.includes('@g.us') ? msg.to : (msg.from?.includes('@g.us') ? msg.from : null);
        if (fallbackId) {
            await msg.reply(`🆔 *ID de este Grupo:* \`${fallbackId}\`\n\n💡 Puedes copiar este código y colocarlo en el archivo \`.env\` como \`GRUPO_ID=${fallbackId}\` para los mensajes automáticos.`);
        } else {
            await msg.reply(`ℹ️ Este comando debe enviarse dentro de un *grupo de WhatsApp* para conocer su ID.`);
        }
    }
}

async function cmdPagado(msg, args, adminPhone, isGroup, client) {
    if (args.length === 0) {
        await msg.reply('⚠️ Debes especificar el número a confirmar. Ejemplo: `!pagado 042`');
        return;
    }

    const result = db.confirmPayment(args[0], adminPhone);
    if (!result.success) {
        await msg.reply(`❌ ${result.message}`);
        return;
    }

    const publicText = 
        `🎉 *¡PAGO CONFIRMADO!*\n\n` +
        `• Número: *${result.numero}*\n` +
        `• Participante: *${result.item.vecino}* (*${result.item.casa}*)\n` +
        `• Estado: 🟢 *PAGADO*`;

    await msg.reply(publicText);

    if (result.item.telefono) {
        await sendPrivate(
            client, 
            result.item.telefono, 
            `✅ ¡Hola *${result.item.vecino}*! Tu pago por el número *${result.numero}* ha sido confirmado. ¡Mucha suerte en el sorteo!`
        );
    }
}

async function cmdLiberar(msg, args) {
    if (args.length === 0) {
        await msg.reply('⚠️ Debes especificar el número a liberar. Ejemplo: `!liberar 042`');
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

async function cmdPendientes(msg, serializedId, isGroup, client) {
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

    if (isGroup) {
        await msg.reply('🔒 *Información privada:* Te envié la lista de deudores por mensaje privado.');
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
}

async function cmdResumen(msg, serializedId, isGroup, client) {
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

    if (isGroup) {
        await msg.reply('🔒 *Información privada:* Te envié el balance y recaudación por mensaje privado.');
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
}

async function cmdTablero(msg, serializedId, isGroup, client) {
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

    if (isGroup) {
        await msg.reply('🔒 *Información privada:* Te envié el tablero completo por mensaje privado.');
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
}

async function cmdAnuncio(msg, args, client) {
    let targetChat = config.GRUPO_ID;

    if (!targetChat) {
        try {
            const chat = await msg.getChat();
            if (chat.isGroup) {
                targetChat = chat.id._serialized;
            }
        } catch (err) {
            targetChat = msg.to?.includes('@g.us') ? msg.to : (msg.from?.includes('@g.us') ? msg.from : null);
        }
    }

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
