const config = require('./config');
const db = require('./db');
const scheduler = require('./scheduler');

// Almacenamiento en memoria de las sesiones y pasos de cada usuario
const userSessions = {};

/**
 * Obtiene o crea la sesión de un usuario
 */
function getSession(userId) {
    if (!userSessions[userId]) {
        userSessions[userId] = {
            step: 'IDLE',
            tempData: {},
            lastActivity: Date.now()
        };
    }
    // Si pasaron más de 10 minutos de inactividad, reiniciar a IDLE
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

/**
 * Obtiene la información del remitente
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

    // Filtro de grupo: solo atender en GRUPO_ID si es un grupo
    if (isGroup) {
        if (rawBody.toLowerCase() === '!idgrupo') {
            await cmdIdGrupo(msg);
            return;
        }
        if (config.GRUPO_ID && currentGroupId !== config.GRUPO_ID) {
            return; // Ignorar otros grupos
        }
    }

    // 1. PALABRA CLAVE "SORTEO" -> Despliega el menú principal
    if (normalizedBody === 'SORTEO' || normalizedBody === '!SORTEO' || normalizedBody === '!MENU') {
        session.step = 'MENU';
        session.tempData = {};

        const menuText = buildMainMenu(senderPhone);

        if (isGroup) {
            await msg.reply('👋 ¡Hola! Te enviamos el *Menú del Sorteo* por mensaje privado para que elijas cómodamente 📲');
            await sendPrivate(client, serializedId, menuText);
        } else {
            await msg.reply(menuText);
        }
        return;
    }

    // 2. SI EL USUARIO ESTÁ DENTRO DE UN FLUJO DE MENÚ (Solo en chat privado o mensaje directo)
    if (!isGroup && session.step !== 'IDLE') {
        const handled = await handleConversationFlow(msg, rawBody, session, senderPhone, serializedId, client);
        if (handled) return;
    }

    // 3. COMANDOS DIRECTOS CON PREFIJO "!" (Para quienes prefieran escribir directo)
    if (rawBody.startsWith(config.PREFIX)) {
        const args = rawBody.slice(config.PREFIX.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        await handleDirectCommand(command, args, msg, senderPhone, serializedId, isGroup, client);
    }
}

// -------------------------------------------------------------
// FLUJO CONVERSACIONAL PASO A PASO (MENÚ)
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

    // Opción para cancelar en cualquier momento
    if (input === '0' || input.toLowerCase() === 'cancelar' || input.toLowerCase() === 'salir') {
        resetSession(serializedId);
        await msg.reply('👋 Menú cerrado. Escribe *SORTEO* cuando quieras volver a ingresar.');
        return true;
    }

    switch (session.step) {
        // Menú Principal
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
                await cmdLibres(msg, senderPhone, serializedId, false, client);
                await msg.reply(`\nEscribe *1* si quieres reservar un número ahora, o *0* para salir.`);
                return true;
            } else if (input === '3') {
                await cmdMisNumeros(msg, senderPhone, serializedId, false, client);
                return true;
            } else if (input === '4') {
                await cmdDatosPago(msg, serializedId, false, client);
                return true;
            } else if (input === '5' && isAdmin(senderPhone)) {
                session.step = 'ADMIN_MENU';
                await msg.reply(buildAdminMenu());
                return true;
            } else {
                await msg.reply(`⚠️ Opción no válida.\nPor favor escribe un número del menú (1, 2, 3, 4 o 0 para salir):`);
                return true;
            }

        // Paso 1: Eligiendo número
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

            // Guardar número temporalmente y pedir Nombre y Casa
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

        // Paso 2: Guardando Nombre y Casa
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

            // Si hay un grupo configurado, anunciar brevemente la reserva en el grupo
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

        // Submenú de Administrador
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
                await cmdPendientes(msg, serializedId, false, client);
                return true;
            } else if (input === '4') {
                await cmdResumen(msg, serializedId, false, client);
                return true;
            } else if (input === '5') {
                await cmdTablero(msg, serializedId, false, client);
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
// MANEJADOR DE COMANDOS DIRECTOS (Para usuarios avanzados)
// -------------------------------------------------------------

async function handleDirectCommand(command, args, msg, senderPhone, serializedId, isGroup, client) {
    switch (command) {
        case 'ayuda':
        case 'help':
            await cmdAyuda(msg, senderPhone, isGroup, client);
            break;

        case 'elegir':
            await cmdElegir(msg, args, senderPhone, serializedId, isGroup, client);
            break;

        case 'libres':
            await cmdLibres(msg, senderPhone, serializedId, isGroup, client);
            break;

        case 'misnumeros':
            await cmdMisNumeros(msg, senderPhone, serializedId, isGroup, client);
            break;

        case 'alias':
        case 'pago':
            await cmdDatosPago(msg, serializedId, isGroup, client);
            break;

        case 'idgrupo':
            await cmdIdGrupo(msg);
            break;

        case 'pagado':
            if (isAdmin(senderPhone)) await cmdPagado(msg, args, senderPhone, isGroup, client);
            break;

        case 'liberar':
            if (isAdmin(senderPhone)) await cmdLiberar(msg, args);
            break;

        case 'pendientes':
            if (isAdmin(senderPhone)) await cmdPendientes(msg, serializedId, isGroup, client);
            break;

        case 'resumen':
            if (isAdmin(senderPhone)) await cmdResumen(msg, serializedId, isGroup, client);
            break;

        case 'anuncio':
            if (isAdmin(senderPhone)) await cmdAnuncio(msg, args, client);
            break;
    }
}

// -------------------------------------------------------------
// FUNCIONES AUXILIARES
// -------------------------------------------------------------

async function cmdAyuda(msg, senderPhone, isGroup, client) {
    let text = `🎲 *${config.EVENTO_NOMBRE}* 🎲\n\n`;
    text += `Para ver el menú interactivo, escribe: *SORTEO*\n\n`;
    text += `*O escribe el número de opción:* \`1\` para elegir número, \`2\` para ver disponibles, \`3\` para tus números, \`4\` para datos de pago.`;
    await msg.reply(text);
}

async function cmdElegir(msg, args, senderPhone, serializedId, isGroup, client) {
    if (args.length < 3) {
        await msg.reply(`⚠️ Escribe: \`!elegir <número> <Nombre> <Casa>\` o simplemente escribe *SORTEO* para usar el menú guiado.`);
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
        `⚠️ Envía el comprobante dentro de las *${config.HORAS_LIMITE_PAGO} hs*.`;

    if (isGroup) {
        await msg.reply(`🎉 ¡Felicitaciones *${vecino}* (*${casa}*)!\n🟡 Reservaste el número: *${result.numero}*. Te enviamos los datos de pago por privado 📲`);
        await sendPrivate(client, serializedId, datosPagoMsg);
    } else {
        await msg.reply(datosPagoMsg);
    }
}

async function cmdLibres(msg, senderPhone, serializedId, isGroup, client) {
    const libres = db.getAvailableNumbers();
    const total = config.NUMERO_MAX - config.NUMERO_MIN + 1;

    if (libres.length === 0) {
        await msg.reply('🔥 ¡Todos los números ya han sido reservados o comprados!');
        return;
    }

    const fullListText = `📋 *Números Disponibles (${libres.length}/${total}):*\n\n` + libres.join(' - ');

    if (isGroup && libres.length > 50) {
        const muestra = libres.slice(0, 30).join(' - ');
        await msg.reply(`📋 *NÚMEROS DISPONIBLES: Quedan ${libres.length} de ${total}*\n*Muestra:* ${muestra}...\n📲 *Lista completa enviada por mensaje privado.*`);
        await sendPrivate(client, serializedId, fullListText);
    } else {
        await msg.reply(fullListText);
    }
}

async function cmdMisNumeros(msg, senderPhone, serializedId, isGroup, client) {
    const userNums = db.getUserNumbers(senderPhone);
    if (userNums.length === 0) {
        await msg.reply('ℹ️ No tienes ningún número reservado con este teléfono.');
        return;
    }

    let text = `🎟️ *Tus números registrados:*\n\n`;
    for (const item of userNums) {
        const estadoEmoji = item.estado === 'PAGADO' ? '🟢 PAGADO' : '🟡 PENDIENTE DE PAGO';
        text += `• Número *${item.numero}* -> ${estadoEmoji} (${item.vecino} - ${item.casa})\n`;
    }

    if (isGroup) {
        await msg.reply(`📲 Detalle enviado por mensaje privado.`);
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
        `• *Banco:* ${config.DATOS_PAGO.banco}`;

    if (isGroup) {
        await msg.reply(`💳 *Alias:* \`${config.DATOS_PAGO.alias}\` | Detalle enviado por privado.`);
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
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

async function cmdPagado(msg, args, adminPhone, isGroup, client) {
    if (args.length === 0) return;
    const result = db.confirmPayment(args[0], adminPhone);
    if (!result.success) {
        await msg.reply(`❌ ${result.message}`);
        return;
    }
    await msg.reply(`🎉 *¡PAGO CONFIRMADO!*\n• Número: *${result.numero}*\n• Participante: *${result.item.vecino}* (*${result.item.casa}*)\n• Estado: 🟢 *PAGADO*`);
    if (result.item.telefono) {
        await sendPrivate(client, result.item.telefono, `✅ ¡Hola *${result.item.vecino}*! Tu pago por el número *${result.numero}* ha sido confirmado.`);
    }
}

async function cmdLiberar(msg, args) {
    if (args.length === 0) return;
    const result = db.releaseNumber(args[0]);
    if (!result.success) {
        await msg.reply(`❌ ${result.message}`);
        return;
    }
    await msg.reply(`♻️ El número *${result.numero}* ha sido liberado y queda disponible nuevamente.`);
}

async function cmdPendientes(msg, serializedId, isGroup, client) {
    const pendientes = db.getPendingPayments();
    if (pendientes.length === 0) {
        await msg.reply('👏 No hay números pendientes de pago.');
        return;
    }
    let text = `⏳ *Números Reservados Pendientes de Pago (${pendientes.length}):*\n\n`;
    for (const item of pendientes) {
        text += `• *#${item.numero}* - ${item.vecino} (${item.casa})\n`;
    }
    if (isGroup) {
        await msg.reply('🔒 Lista de deudores enviada por privado.');
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
}

async function cmdResumen(msg, serializedId, isGroup, client) {
    const summary = db.getSummary();
    const text = 
        `📊 *BALANCE GENERAL - ${config.EVENTO_NOMBRE}* 📊\n\n` +
        `• *Total:* ${summary.total} | 🟢 *Pagados:* ${summary.pagados} | 🟡 *Reservados:* ${summary.reservados} | ⚪ *Libres:* ${summary.libres}\n` +
        `💰 *Recaudación Confirmada:* $${summary.recaudado.toLocaleString('es-AR')}\n` +
        `🎯 *Recaudación Potencial:* $${summary.potencial.toLocaleString('es-AR')}`;
    if (isGroup) {
        await msg.reply('🔒 Balance enviado por privado.');
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
}

async function cmdTablero(msg, serializedId, isGroup, client) {
    const fs = require('fs');
    const path = require('path');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'quiniela.json'), 'utf-8'));
    let text = `📋 *TABLERO DE NÚMEROS:*\n\n`;
    for (const [num, data] of Object.entries(raw.numeros)) {
        if (data.estado === 'LIBRE') text += `[${num}] ⚪ Libre\n`;
        else if (data.estado === 'RESERVADO') text += `[${num}] 🟡 ${data.vecino} (${data.casa}) - Pendiente\n`;
        else if (data.estado === 'PAGADO') text += `[${num}] 🟢 ${data.vecino} (${data.casa}) - Pagado\n`;
    }
    if (isGroup) {
        await msg.reply('🔒 Tablero enviado por privado.');
        await sendPrivate(client, serializedId, text);
    } else {
        await msg.reply(text);
    }
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
