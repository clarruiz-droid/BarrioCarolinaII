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

function isAdmin(phone) {
    if (!config.ADMIN_PHONES || config.ADMIN_PHONES.length === 0) {
        return true;
    }
    return config.ADMIN_PHONES.some(admin => phone.endsWith(admin) || admin.endsWith(phone));
}

/**
 * Enviar mensaje de forma directa y segura
 */
async function sendReply(client, chatId, text) {
    try {
        await client.sendMessage(chatId, text);
        return true;
    } catch (e) {
        console.error(`[Error enviando mensaje a ${chatId}]:`, e.message);
        return false;
    }
}

/**
 * Manejador principal de mensajes entrantes
 */
async function handleMessage(msg, client) {
    const rawBody = (msg.body || '').trim();
    if (!rawBody) return;

    // Detectar si es grupo o privado de forma directa y rápida
    const isGroup = msg.from.endsWith('@g.us') || (msg.fromMe && (msg.to || '').endsWith('@g.us'));
    const currentGroupId = isGroup ? (msg.from.endsWith('@g.us') ? msg.from : msg.to) : null;
    
    // Identificar al remitente
    const senderChatId = isGroup ? (msg.author || msg.from) : msg.from;
    const senderPhone = senderChatId.replace(/@.*/, '');
    const session = getSession(senderChatId);

    console.log(`\n📩 [MSG RECIBIDO] De: ${senderPhone} (${senderChatId}) | Grupo: ${isGroup ? currentGroupId : 'NO (Privado)'} | Texto: "${rawBody}"`);

    const normalizedBody = rawBody.toUpperCase();

    // =============================================================
    // 1. SI EL MENSAJE ES EN UN GRUPO
    // =============================================================
    if (isGroup) {
        // Comando administrativo para ver el ID
        if (rawBody.toLowerCase() === '!idgrupo') {
            await sendReply(client, currentGroupId, `🆔 *ID de este Grupo:* \`${currentGroupId}\``);
            return;
        }

        // Si hay GRUPO_ID configurado y no coincide con este grupo, ignorar
        if (config.GRUPO_ID && currentGroupId !== config.GRUPO_ID) {
            console.log(`[Filtro] Mensaje ignorado porque el grupo ${currentGroupId} no coincide con GRUPO_ID (${config.GRUPO_ID})`);
            return;
        }

        // Anuncios manuales del admin en el grupo
        if (rawBody.startsWith('!anuncio') && isAdmin(senderPhone)) {
            const args = rawBody.slice('!anuncio'.length).trim().split(/\s+/);
            await cmdAnuncio(client, currentGroupId, args);
            return;
        }

        // Si escriben SORTEO o comandos en el grupo: avisar e invitar al privado
        if (normalizedBody === 'SORTEO' || rawBody.startsWith('!')) {
            const botNumber = client.info?.wid?.user;
            const waLink = botNumber ? `\n\n👉 *Haz clic aquí:* https://wa.me/${botNumber}?text=SORTEO` : '';
            
            await sendReply(
                client, 
                currentGroupId,
                `👋 ¡Hola! Para reservar tu número y ver los disponibles, la atención es por *chat privado* 📲.\n\n` +
                `Por favor envíame un mensaje privado con la palabra *SORTEO*.${waLink}`
            );

            // Iniciar también el menú en su privado
            session.step = 'MENU';
            session.tempData = {};
            await sendReply(client, senderChatId, buildMainMenu(senderPhone));
            return;
        }

        return;
    }

    // =============================================================
    // 2. SI EL MENSAJE ES EN CHAT PRIVADO
    // =============================================================

    // Palabra clave "SORTEO", "HOLA", "MENU", etc.
    if (normalizedBody === 'SORTEO' || normalizedBody === '!SORTEO' || normalizedBody === 'HOLA' || normalizedBody === '!MENU') {
        session.step = 'MENU';
        session.tempData = {};
        await sendReply(client, senderChatId, buildMainMenu(senderPhone));
        return;
    }

    // Si el usuario está dentro de un flujo del menú
    if (session.step !== 'IDLE') {
        const handled = await handleConversationFlow(client, senderChatId, rawBody, session, senderPhone);
        if (handled) return;
    }

    // Comandos directos en privado
    if (rawBody.startsWith(config.PREFIX)) {
        const args = rawBody.slice(config.PREFIX.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        await handleDirectCommand(client, senderChatId, command, args, senderPhone);
        return;
    }

    // Mensaje libre en privado: ofrecer menú
    if (session.step === 'IDLE') {
        await sendReply(
            client, 
            senderChatId, 
            `👋 ¡Hola! Para ver las opciones de la *${config.EVENTO_NOMBRE}*, escribe la palabra: *SORTEO*`
        );
    }
}

// -------------------------------------------------------------
// MENÚ Y FLUJO CONVERSACIONAL EN PRIVADO
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

async function handleConversationFlow(client, chatId, text, session, senderPhone) {
    const input = text.trim();

    if (input === '0' || input.toLowerCase() === 'cancelar' || input.toLowerCase() === 'salir') {
        resetSession(chatId);
        await sendReply(client, chatId, '👋 Menú cerrado. Escribe *SORTEO* cuando quieras volver a ingresar.');
        return true;
    }

    switch (session.step) {
        case 'MENU':
            if (input === '1') {
                session.step = 'WAITING_NUMBER';
                await sendReply(
                    client,
                    chatId,
                    `🔢 *PASO 1 de 2:*\n\n` +
                    `Escribe el *número* que deseas elegir (por ejemplo: \`042\`):\n\n` +
                    `*(Escribe 0 para cancelar)*`
                );
                return true;
            } else if (input === '2') {
                await cmdLibres(client, chatId);
                await sendReply(client, chatId, `\nEscribe *1* si quieres reservar un número ahora, o *0* para salir.`);
                return true;
            } else if (input === '3') {
                await cmdMisNumeros(client, chatId, senderPhone);
                return true;
            } else if (input === '4') {
                await cmdDatosPago(client, chatId);
                return true;
            } else if (input === '5' && isAdmin(senderPhone)) {
                session.step = 'ADMIN_MENU';
                await sendReply(client, chatId, buildAdminMenu());
                return true;
            } else {
                await sendReply(client, chatId, `⚠️ Opción no válida.\nPor favor responde con 1, 2, 3, 4 o 0 para salir:`);
                return true;
            }

        case 'WAITING_NUMBER': {
            const num = db.normalizeNumber(input);
            if (!num) {
                await sendReply(client, chatId, `❌ Número inválido. Debe ser entre \`${String(config.NUMERO_MIN).padStart(config.DIGITOS_PAD, '0')}\` y \`${config.NUMERO_MAX}\`.\nIntenta con otro número (o 0 para cancelar):`);
                return true;
            }

            const item = db.getNumber(num);
            if (!item || item.estado !== 'LIBRE') {
                const ocupadoPor = item && item.vecino ? ` por *${item.vecino} (${item.casa})*` : '';
                await sendReply(client, chatId, `❌ El número *${num}* ya no está disponible${ocupadoPor}.\n\nPor favor escribe otro número (o 0 para cancelar):`);
                return true;
            }

            session.tempData.numero = num;
            session.step = 'WAITING_NAME_HOUSE';
            await sendReply(
                client,
                chatId,
                `✅ ¡El número *${num}* está libre!\n\n` +
                `👤 *PASO 2 de 2:*\n` +
                `Escribe tu *Nombre y Número de Casa*:\n` +
                `*(Ejemplo: \`Carlos Gomez Casa 18\`)*`
            );
            return true;
        }

        case 'WAITING_NAME_HOUSE': {
            if (input.length < 3) {
                await sendReply(client, chatId, `⚠️ Por favor escribe tu nombre completo y número de casa (ej: \`Juan Perez Casa 12\`):`);
                return true;
            }

            const parts = input.split(/\s+/);
            const casa = parts.pop();
            const vecino = parts.join(' ') || casa;

            const result = db.reserveNumber(session.tempData.numero, vecino, casa, senderPhone);
            resetSession(chatId);

            if (!result.success) {
                await sendReply(client, chatId, `❌ ${result.message}`);
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

            await sendReply(client, chatId, confirmacion);

            if (config.GRUPO_ID) {
                await sendReply(
                    client,
                    config.GRUPO_ID,
                    `🎟️ *Nueva reserva:* El vecino *${vecino}* (*${casa}*) acaba de reservar el número *${result.numero}*.`
                );
            }
            return true;
        }

        case 'ADMIN_MENU':
            if (input === '1') {
                session.step = 'ADMIN_WAITING_PAY';
                await sendReply(client, chatId, `Escribe el número a confirmar como *PAGADO* (ej: \`042\`):`);
                return true;
            } else if (input === '2') {
                session.step = 'ADMIN_WAITING_RELEASE';
                await sendReply(client, chatId, `Escribe el número a *LIBERAR* (ej: \`042\`):`);
                return true;
            } else if (input === '3') {
                await cmdPendientes(client, chatId);
                return true;
            } else if (input === '4') {
                await cmdResumen(client, chatId);
                return true;
            } else if (input === '5') {
                await cmdTablero(client, chatId);
                return true;
            } else if (input === '0') {
                session.step = 'MENU';
                await sendReply(client, chatId, buildMainMenu(senderPhone));
                return true;
            }
            break;

        case 'ADMIN_WAITING_PAY': {
            const res = db.confirmPayment(input, senderPhone);
            resetSession(chatId);
            if (!res.success) {
                await sendReply(client, chatId, `❌ ${res.message}`);
            } else {
                await sendReply(client, chatId, `✅ Pago confirmado para el número *${res.numero}* (${res.item.vecino} - ${res.item.casa}).`);
                if (config.GRUPO_ID) {
                    await sendReply(client, config.GRUPO_ID, `🎉 *¡Pago confirmado!* Número *${res.numero}* de *${res.item.vecino}* (*${res.item.casa}*) 🟢 PAGADO.`);
                }
                if (res.item.telefono) {
                    await sendReply(client, res.item.telefono + '@c.us', `✅ ¡Hola *${res.item.vecino}*! Tu pago por el número *${res.numero}* ha sido confirmado. ¡Mucha suerte!`);
                }
            }
            return true;
        }

        case 'ADMIN_WAITING_RELEASE': {
            const res = db.releaseNumber(input);
            resetSession(chatId);
            if (!res.success) {
                await sendReply(client, chatId, `❌ ${res.message}`);
            } else {
                await sendReply(client, chatId, `♻️ Número *${res.numero}* liberado y disponible nuevamente.`);
            }
            return true;
        }
    }

    return false;
}

async function handleDirectCommand(client, chatId, command, args, senderPhone) {
    switch (command) {
        case 'ayuda':
        case 'help':
            await sendReply(client, chatId, `🎲 Para ver el menú interactivo, escribe: *SORTEO*`);
            break;

        case 'libres':
            await cmdLibres(client, chatId);
            break;

        case 'misnumeros':
            await cmdMisNumeros(client, chatId, senderPhone);
            break;

        case 'alias':
        case 'pago':
            await cmdDatosPago(client, chatId);
            break;

        case 'pagado':
            if (isAdmin(senderPhone) && args.length > 0) {
                const res = db.confirmPayment(args[0], senderPhone);
                if (res.success) {
                    await sendReply(client, chatId, `✅ Pago confirmado para el número *${res.numero}*.`);
                    if (config.GRUPO_ID) {
                        await sendReply(client, config.GRUPO_ID, `🎉 *¡Pago confirmado!* Número *${res.numero}* de *${res.item.vecino}* (*${res.item.casa}*) 🟢 PAGADO.`);
                    }
                } else {
                    await sendReply(client, chatId, `❌ ${res.message}`);
                }
            }
            break;

        case 'liberar':
            if (isAdmin(senderPhone) && args.length > 0) {
                const res = db.releaseNumber(args[0]);
                if (res.success) {
                    await sendReply(client, chatId, `♻️ Número *${res.numero}* liberado.`);
                } else {
                    await sendReply(client, chatId, `❌ ${res.message}`);
                }
            }
            break;

        case 'pendientes':
            if (isAdmin(senderPhone)) await cmdPendientes(client, chatId);
            break;

        case 'resumen':
            if (isAdmin(senderPhone)) await cmdResumen(client, chatId);
            break;

        case 'tablero':
            if (isAdmin(senderPhone)) await cmdTablero(client, chatId);
            break;
    }
}

// -------------------------------------------------------------
// FUNCIONES DE CONSULTA
// -------------------------------------------------------------

async function cmdLibres(client, chatId) {
    const libres = db.getAvailableNumbers();
    const total = config.NUMERO_MAX - config.NUMERO_MIN + 1;

    if (libres.length === 0) {
        await sendReply(client, chatId, '🔥 ¡Todos los números ya han sido reservados o comprados!');
        return;
    }

    const fullListText = `📋 *Números Disponibles (${libres.length}/${total}):*\n\n` + libres.join(' - ');
    await sendReply(client, chatId, fullListText);
}

async function cmdMisNumeros(client, chatId, senderPhone) {
    const userNums = db.getUserNumbers(senderPhone);
    if (userNums.length === 0) {
        await sendReply(client, chatId, 'ℹ️ No tienes ningún número reservado con este teléfono.\nEscribe *1* en el menú para elegir uno.');
        return;
    }

    let text = `🎟️ *Tus números registrados:*\n\n`;
    for (const item of userNums) {
        const estadoEmoji = item.estado === 'PAGADO' ? '🟢 PAGADO' : '🟡 PENDIENTE DE PAGO';
        text += `• Número *${item.numero}* -> ${estadoEmoji} (${item.vecino} - ${item.casa})\n`;
    }
    await sendReply(client, chatId, text);
}

async function cmdDatosPago(client, chatId) {
    const text = 
        `💳 *DATOS DE PAGO / TRANSFERENCIA* 💳\n\n` +
        `💰 *Valor por número:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
        `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
        `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
        `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
        `• *Banco:* ${config.DATOS_PAGO.banco}`;
    await sendReply(client, chatId, text);
}

async function cmdPendientes(client, chatId) {
    const pendientes = db.getPendingPayments();
    if (pendientes.length === 0) {
        await sendReply(client, chatId, '👏 No hay números pendientes de pago.');
        return;
    }
    let text = `⏳ *Números Reservados Pendientes de Pago (${pendientes.length}):*\n\n`;
    for (const item of pendientes) {
        text += `• *#${item.numero}* - ${item.vecino} (${item.casa})\n`;
    }
    await sendReply(client, chatId, text);
}

async function cmdResumen(client, chatId) {
    const summary = db.getSummary();
    const text = 
        `📊 *BALANCE GENERAL - ${config.EVENTO_NOMBRE}* 📊\n\n` +
        `• *Total:* ${summary.total} | 🟢 *Pagados:* ${summary.pagados} | 🟡 *Reservados:* ${summary.reservados} | ⚪ *Libres:* ${summary.libres}\n` +
        `💰 *Recaudación Confirmada:* $${summary.recaudado.toLocaleString('es-AR')}\n` +
        `🎯 *Recaudación Potencial:* $${summary.potencial.toLocaleString('es-AR')}`;
    await sendReply(client, chatId, text);
}

async function cmdTablero(client, chatId) {
    const fs = require('fs');
    const path = require('path');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'quiniela.json'), 'utf-8'));
    let text = `📋 *TABLERO DE NÚMEROS:*\n\n`;
    for (const [num, data] of Object.entries(raw.numeros)) {
        if (data.estado === 'LIBRE') text += `[${num}] ⚪ Libre\n`;
        else if (data.estado === 'RESERVADO') text += `[${num}] 🟡 ${data.vecino} (${data.casa}) - Pendiente\n`;
        else if (data.estado === 'PAGADO') text += `[${num}] 🟢 ${data.vecino} (${data.casa}) - Pagado\n`;
    }
    await sendReply(client, chatId, text);
}

async function cmdAnuncio(client, groupId, args) {
    const customText = args.length > 0 ? args.join(' ') : null;
    const messageToSend = scheduler.buildReminderMessage(customText);
    try {
        await scheduler.sendBroadcast(client, groupId, messageToSend);
    } catch (e) {
        console.error('[Error al enviar anuncio]:', e);
    }
}

module.exports = {
    handleMessage
};
