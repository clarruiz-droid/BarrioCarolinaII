const config = require('./config');
const db = require('./db');
const scheduler = require('./scheduler');

// Almacenamiento en memoria de las sesiones y pasos de cada usuario
const userSessions = {};

function getSession(userId) {
    if (!userSessions[userId]) {
        userSessions[userId] = {
            step: 'IDLE',
            tempData: {},
            lastActivity: Date.now()
        };
    }
    if (Date.now() - userSessions[userId].lastActivity > 10 * 60 * 1000) {
        userSessions[userId].step = 'IDLE';
        userSessions[userId].tempData = {};
    }
    userSessions[userId].lastActivity = Date.now();
    return userSessions[userId];
}

function resetSession(userId) {
    userSessions[userId] = {
        step: 'IDLE',
        tempData: {},
        lastActivity: Date.now()
    };
}

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
        // Fallback
    }

    return { phone, serializedId };
}

function isAdmin(phone) {
    if (!config.ADMIN_PHONES || config.ADMIN_PHONES.length === 0) {
        return true;
    }
    return config.ADMIN_PHONES.some(admin => phone.endsWith(admin) || admin.endsWith(phone));
}

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
 * Manejador principal de mensajes
 */
async function handleMessage(msg, client) {
    const rawBody = (msg.body || '').trim();
    if (!rawBody) return;

    const normalizedBody = rawBody.toUpperCase();
    const { phone: senderPhone, serializedId } = await getSenderInfo(msg);
    const session = getSession(serializedId);

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

    // =============================================================
    // 1. MENSAJES DENTRO DEL GRUPO DE WHATSAPP
    // =============================================================
    if (isGroup) {
        // Comando administrativo para obtener el ID del grupo
        if (rawBody.toLowerCase() === '!idgrupo') {
            await cmdIdGrupo(msg);
            return;
        }

        // Filtro de seguridad: ignorar grupos ajenos
        if (config.GRUPO_ID && currentGroupId !== config.GRUPO_ID) {
            return;
        }

        // Si es un anuncio manual del admin en el grupo
        if (rawBody.startsWith('!anuncio') && isAdmin(senderPhone)) {
            const args = rawBody.slice('!anuncio'.length).trim().split(/\s+/);
            await cmdAnuncio(msg, args, client);
            return;
        }

        // Si alguien escribe SORTEO o comandos en el grupo: redirigir al chat privado
        if (normalizedBody === 'SORTEO' || rawBody.startsWith('!')) {
            const botNumber = client.info?.wid?.user;
            const waLink = botNumber ? `\n\n👉 *Haz clic aquí para chatear en privado:* https://wa.me/${botNumber}?text=SORTEO` : '';
            
            await msg.reply(
                `👋 ¡Hola! Para elegir tu número y ver los disponibles sin llenar el grupo de mensajes, la atención es por *chat privado* 📲.\n\n` +
                `Por favor envíame un mensaje privado con la palabra *SORTEO*.${waLink}`
            );

            // Iniciar también el menú directamente en su chat privado
            session.step = 'MENU';
            session.tempData = {};
            await sendPrivate(client, serializedId, buildMainMenu(senderPhone));
            return;
        }

        // Cualquier otro texto en el grupo no se procesa para no interferir
        return;
    }

    // =============================================================
    // 2. MENSAJES EN CHAT PRIVADO (ATENCIÓN EXCLUSIVA)
    // =============================================================

    // Apertura del menú con "SORTEO" o saludo
    if (normalizedBody === 'SORTEO' || normalizedBody === '!SORTEO' || normalizedBody === '!MENU' || normalizedBody === 'HOLA') {
        session.step = 'MENU';
        session.tempData = {};
        await msg.reply(buildMainMenu(senderPhone));
        return;
    }

    // Flujo conversacional activo
    if (session.step !== 'IDLE') {
        const handled = await handleConversationFlow(msg, rawBody, session, senderPhone, serializedId, client);
        if (handled) return;
    }

    // Comandos directos con prefijo "!" en privado
    if (rawBody.startsWith(config.PREFIX)) {
        const args = rawBody.slice(config.PREFIX.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        await handleDirectCommand(command, args, msg, senderPhone, serializedId, client);
        return;
    }

    // Si el usuario escribe algo suelto en privado y no está en menú, sugerir SORTEO
    if (session.step === 'IDLE') {
        await msg.reply(
            `👋 ¡Hola! Para ver las opciones de la *${config.EVENTO_NOMBRE}*, escribe la palabra: *SORTEO*`
        );
    }
}

// -------------------------------------------------------------
// MENÚS Y FLUJO CONVERSACIONAL EN PRIVADO
// -------------------------------------------------------------

function buildMainMenu(phone) {
    let text = `🎲 *${config.EVENTO_NOMBRE}* 🎲\n\n`;
    text += `Por favor responde con el *número* de la opción que deseas:\n\n`;
    text += `1️⃣ 🎟️ *Elegir / Reservar un número*\n`;
    text += `2️⃣ 📋 *Ver números disponibles*\n`;
    text += `3️⃣ 🔍 *Consultar mis números y pagos*\n`;
    text += `4️⃣ 💳 *Datos para transferir (Alias/CBU)*\n`;
    
    if (isAdmin(phone)) {
        text += `5️⃣ 👑 *Menú de Administrador*\n`;
    }

    text += `0️⃣ ❌ *Salir / Cancelar*`;
    return text;
}

function buildAdminMenu() {
    let text = `👑 *MENÚ DE ADMINISTRADOR* 👑\n\n`;
    text += `Elige una opción:\n`;
    text += `1️⃣ ✅ *Confirmar pago de un número*\n`;
    text += `2️⃣ ♻️ *Liberar un número*\n`;
    text += `3️⃣ ⏳ *Ver reservas pendientes de pago*\n`;
    text += `4️⃣ 📊 *Ver balance y recaudación*\n`;
    text += `5️⃣ 📋 *Ver tablero completo*\n`;
    text += `0️⃣ 🔙 *Volver al menú principal*`;
    return text;
}

async function handleConversationFlow(msg, text, session, senderPhone, serializedId, client) {
    const input = text.trim();

    if (input === '0' || input.toLowerCase() === 'cancelar' || input.toLowerCase() === 'salir') {
        resetSession(serializedId);
        await msg.reply('👋 Menú cerrado. Escribe *SORTEO* cuando quieras volver a ingresar.');
        return true;
    }

    switch (session.step) {
        case 'MENU':
            if (input === '1') {
                session.step = 'WAITING_NUMBER';
                await msg.reply(
                    `🔢 *PASO 1 de 2:*\n\n` +
                    `Escribe el *número* que deseas elegir (por ejemplo: \`042\`):\n\n` +
                    `*(Escribe 0 para cancelar)*`
                );
                return true;
            } else if (input === '2') {
                await cmdLibres(msg, senderPhone, serializedId, client);
                await msg.reply(`\nEscribe *1* si quieres reservar un número ahora, o *0* para salir.`);
                return true;
            } else if (input === '3') {
                await cmdMisNumeros(msg, senderPhone, serializedId, client);
                return true;
            } else if (input === '4') {
                await cmdDatosPago(msg, serializedId, client);
                return true;
            } else if (input === '5' && isAdmin(senderPhone)) {
                session.step = 'ADMIN_MENU';
                await msg.reply(buildAdminMenu());
                return true;
            } else {
                await msg.reply(`⚠️ Opción no válida.\nPor favor escribe un número del menú (1, 2, 3, 4 o 0 para salir):`);
                return true;
            }

        case 'WAITING_NUMBER': {
            const num = db.normalizeNumber(input);
            if (!num) {
                await msg.reply(`❌ Número inválido. Debe ser entre \`${String(config.NUMERO_MIN).padStart(config.DIGITOS_PAD, '0')}\` y \`${config.NUMERO_MAX}\`.\nIntenta con otro número (o 0 para cancelar):`);
                return true;
            }

            const item = db.getNumber(num);
            if (!item || item.estado !== 'LIBRE') {
                const ocupadoPor = item && item.vecino ? ` por *${item.vecino} (${item.casa})*` : '';
                await msg.reply(`❌ El número *${num}* ya no está disponible${ocupadoPor}.\n\nPor favor escribe otro número (o 0 para cancelar):`);
                return true;
            }

            session.tempData.numero = num;
            session.step = 'WAITING_NAME_HOUSE';
            await msg.reply(
                `✅ ¡El número *${num}* está libre!\n\n` +
                `👤 *PASO 2 de 2:*\n` +
                `Escribe tu *Nombre y Número de Casa*:\n` +
                `*(Ejemplo: \`Carlos Gomez Casa 18\`)*`
            );
            return true;
        }

        case 'WAITING_NAME_HOUSE': {
            if (input.length < 3) {
                await msg.reply(`⚠️ Por favor escribe tu nombre completo y número de casa (ej: \`Juan Perez Casa 12\`):`);
                return true;
            }

            const parts = input.split(/\s+/);
            const casa = parts.pop();
            const vecino = parts.join(' ') || casa;

            const result = db.reserveNumber(session.tempData.numero, vecino, casa, senderPhone);
            resetSession(serializedId);

            if (!result.success) {
                await msg.reply(`❌ ${result.message}`);
                return true;
            }

            const confirmacion = 
                `🎉 ¡Felicitaciones *${vecino}* (*${casa}*)!\n\n` +
                `🟡 Reservaste el número: *${result.numero}*\n` +
                `💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n` +
                `🏦 *Datos para transferir:*\n` +
                `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
                `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
                `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
                `• *Banco:* ${config.DATOS_PAGO.banco}\n\n` +
                `⚠️ *Importante:* Envía el comprobante de transferencia al administrador dentro de las *${config.HORAS_LIMITE_PAGO} hs* para confirmar tu jugada. ¡Muchas gracias!`;

            await msg.reply(confirmacion);

            // Anuncio público y limpio en el grupo oficial
            if (config.GRUPO_ID) {
                try {
                    await client.sendMessage(
                        config.GRUPO_ID,
                        `🎟️ *Nueva reserva:* El vecino *${vecino}* (*${casa}*) acaba de reservar el número *${result.numero}*.`
                    );
                } catch (e) {
                    console.error('[Error avisando al grupo]:', e);
                }
            }
            return true;
        }

        case 'ADMIN_MENU':
            if (input === '1') {
                session.step = 'ADMIN_WAITING_PAY';
                await msg.reply(`Escribe el número a confirmar como *PAGADO* (ej: \`042\`):`);
                return true;
            } else if (input === '2') {
                session.step = 'ADMIN_WAITING_RELEASE';
                await msg.reply(`Escribe el número a *LIBERAR* (ej: \`042\`):`);
                return true;
            } else if (input === '3') {
                await cmdPendientes(msg, serializedId, client);
                return true;
            } else if (input === '4') {
                await cmdResumen(msg, serializedId, client);
                return true;
            } else if (input === '5') {
                await cmdTablero(msg, serializedId, client);
                return true;
            } else if (input === '0') {
                session.step = 'MENU';
                await msg.reply(buildMainMenu(senderPhone));
                return true;
            }
            break;

        case 'ADMIN_WAITING_PAY': {
            const res = db.confirmPayment(input, senderPhone);
            resetSession(serializedId);
            if (!res.success) {
                await msg.reply(`❌ ${res.message}`);
            } else {
                await msg.reply(`✅ Pago confirmado para el número *${res.numero}* (${res.item.vecino} - ${res.item.casa}).`);
                if (config.GRUPO_ID) {
                    await client.sendMessage(config.GRUPO_ID, `🎉 *¡Pago confirmado!* Número *${res.numero}* de *${res.item.vecino}* (*${res.item.casa}*) 🟢 PAGADO.`);
                }
                if (res.item.telefono) {
                    await sendPrivate(client, res.item.telefono, `✅ ¡Hola *${res.item.vecino}*! Tu pago por el número *${res.numero}* ha sido confirmado. ¡Mucha suerte!`);
                }
            }
            return true;
        }

        case 'ADMIN_WAITING_RELEASE': {
            const res = db.releaseNumber(input);
            resetSession(serializedId);
            if (!res.success) {
                await msg.reply(`❌ ${res.message}`);
            } else {
                await msg.reply(`♻️ Número *${res.numero}* liberado y disponible nuevamente.`);
            }
            return true;
        }
    }

    return false;
}

// -------------------------------------------------------------
// COMANDOS DIRECTOS
// -------------------------------------------------------------

async function handleDirectCommand(command, args, msg, senderPhone, serializedId, client) {
    switch (command) {
        case 'ayuda':
        case 'help':
            await msg.reply(`🎲 Para ver el menú interactivo, escribe: *SORTEO*`);
            break;

        case 'libres':
            await cmdLibres(msg, senderPhone, serializedId, client);
            break;

        case 'misnumeros':
            await cmdMisNumeros(msg, senderPhone, serializedId, client);
            break;

        case 'alias':
        case 'pago':
            await cmdDatosPago(msg, serializedId, client);
            break;

        case 'pagado':
            if (isAdmin(senderPhone) && args.length > 0) {
                const res = db.confirmPayment(args[0], senderPhone);
                if (res.success) {
                    await msg.reply(`✅ Pago confirmado para el número *${res.numero}*.`);
                    if (config.GRUPO_ID) {
                        await client.sendMessage(config.GRUPO_ID, `🎉 *¡Pago confirmado!* Número *${res.numero}* de *${res.item.vecino}* (*${res.item.casa}*) 🟢 PAGADO.`);
                    }
                } else {
                    await msg.reply(`❌ ${res.message}`);
                }
            }
            break;

        case 'liberar':
            if (isAdmin(senderPhone) && args.length > 0) {
                const res = db.releaseNumber(args[0]);
                if (res.success) {
                    await msg.reply(`♻️ Número *${res.numero}* liberado.`);
                } else {
                    await msg.reply(`❌ ${res.message}`);
                }
            }
            break;

        case 'pendientes':
            if (isAdmin(senderPhone)) await cmdPendientes(msg, serializedId, client);
            break;

        case 'resumen':
            if (isAdmin(senderPhone)) await cmdResumen(msg, serializedId, client);
            break;

        case 'tablero':
            if (isAdmin(senderPhone)) await cmdTablero(msg, serializedId, client);
            break;
    }
}

// -------------------------------------------------------------
// FUNCIONES DE CONSULTA
// -------------------------------------------------------------

async function cmdLibres(msg, senderPhone, serializedId, client) {
    const libres = db.getAvailableNumbers();
    const total = config.NUMERO_MAX - config.NUMERO_MIN + 1;

    if (libres.length === 0) {
        await msg.reply('🔥 ¡Todos los números ya han sido reservados o comprados!');
        return;
    }

    const fullListText = `📋 *Números Disponibles (${libres.length}/${total}):*\n\n` + libres.join(' - ');
    await msg.reply(fullListText);
}

async function cmdMisNumeros(msg, senderPhone, serializedId, client) {
    const userNums = db.getUserNumbers(senderPhone);
    if (userNums.length === 0) {
        await msg.reply('ℹ️ No tienes ningún número reservado con este teléfono.\nEscribe *1* en el menú para elegir uno.');
        return;
    }

    let text = `🎟️ *Tus números registrados:*\n\n`;
    for (const item of userNums) {
        const estadoEmoji = item.estado === 'PAGADO' ? '🟢 PAGADO' : '🟡 PENDIENTE DE PAGO';
        text += `• Número *${item.numero}* -> ${estadoEmoji} (${item.vecino} - ${item.casa})\n`;
    }
    await msg.reply(text);
}

async function cmdDatosPago(msg, serializedId, client) {
    const text = 
        `💳 *DATOS DE PAGO / TRANSFERENCIA* 💳\n\n` +
        `💰 *Valor por número:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
        `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
        `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
        `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
        `• *Banco:* ${config.DATOS_PAGO.banco}`;
    await msg.reply(text);
}

async function cmdIdGrupo(msg) {
    try {
        const chat = await msg.getChat();
        if (chat.isGroup) {
            await msg.reply(`🆔 *ID de este Grupo:* \`${chat.id._serialized}\``);
        } else {
            await msg.reply(`ℹ️ Este comando debe enviarse dentro de un *grupo de WhatsApp*.`);
        }
    } catch {
        await msg.reply(`ℹ️ No se pudo determinar el ID del grupo.`);
    }
}

async function cmdPendientes(msg, serializedId, client) {
    const pendientes = db.getPendingPayments();
    if (pendientes.length === 0) {
        await msg.reply('👏 No hay números pendientes de pago.');
        return;
    }
    let text = `⏳ *Números Reservados Pendientes de Pago (${pendientes.length}):*\n\n`;
    for (const item of pendientes) {
        text += `• *#${item.numero}* - ${item.vecino} (${item.casa})\n`;
    }
    await msg.reply(text);
}

async function cmdResumen(msg, serializedId, client) {
    const summary = db.getSummary();
    const text = 
        `📊 *BALANCE GENERAL - ${config.EVENTO_NOMBRE}* 📊\n\n` +
        `• *Total:* ${summary.total} | 🟢 *Pagados:* ${summary.pagados} | 🟡 *Reservados:* ${summary.reservados} | ⚪ *Libres:* ${summary.libres}\n` +
        `💰 *Recaudación Confirmada:* $${summary.recaudado.toLocaleString('es-AR')}\n` +
        `🎯 *Recaudación Potencial:* $${summary.potencial.toLocaleString('es-AR')}`;
    await msg.reply(text);
}

async function cmdTablero(msg, serializedId, client) {
    const fs = require('fs');
    const path = require('path');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'quiniela.json'), 'utf-8'));
    let text = `📋 *TABLERO DE NÚMEROS:*\n\n`;
    for (const [num, data] of Object.entries(raw.numeros)) {
        if (data.estado === 'LIBRE') text += `[${num}] ⚪ Libre\n`;
        else if (data.estado === 'RESERVADO') text += `[${num}] 🟡 ${data.vecino} (${data.casa}) - Pendiente\n`;
        else if (data.estado === 'PAGADO') text += `[${num}] 🟢 ${data.vecino} (${data.casa}) - Pagado\n`;
    }
    await msg.reply(text);
}

async function cmdAnuncio(msg, args, client) {
    if (!config.GRUPO_ID) return;
    const customText = args.length > 0 ? args.join(' ') : null;
    const messageToSend = scheduler.buildReminderMessage(customText);
    try {
        await scheduler.sendBroadcast(client, config.GRUPO_ID, messageToSend);
        await msg.reply('✅ Anuncio enviado exitosamente al grupo.');
    } catch (e) {
        console.error('[Error al enviar anuncio]:', e);
    }
}

module.exports = {
    handleMessage
};
