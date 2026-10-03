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
    if (Date.now() - userSessions[userId].lastActivity > 15 * 60 * 1000) {
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

function cleanPhone(num) {
    if (!num) return '';
    let cleaned = String(num).replace(/\D/g, '');
    if (cleaned.startsWith('549')) {
        cleaned = '54' + cleaned.slice(3);
    }
    return cleaned;
}

function formatPhoneNumber(phone) {
    if (!phone) return null;
    let clean = String(phone).replace(/\D/g, '');
    if (!clean || clean.length < 8) return null;
    if (clean.startsWith('54') && !clean.startsWith('549')) {
        clean = '549' + clean.slice(2);
    } else if (!clean.startsWith('54')) {
        clean = '549' + clean;
    }
    return clean;
}

function formatWhatsAppId(phone) {
    const formatted = formatPhoneNumber(phone);
    if (!formatted) return null;
    return formatted + '@c.us';
}

function isAdmin(phone, msg) {
    if (msg && msg.fromMe) {
        return true;
    }
    if (!config.ADMIN_PHONES || config.ADMIN_PHONES.length === 0) {
        return true;
    }
    const cleanSender = cleanPhone(phone);
    return config.ADMIN_PHONES.some(admin => {
        const cleanAdm = cleanPhone(admin);
        if (!cleanAdm || !cleanSender) return false;
        return cleanSender === cleanAdm || cleanSender.endsWith(cleanAdm) || cleanAdm.endsWith(cleanSender);
    });
}

/**
 * Detecta si un mensaje fue generado automáticamente por el bot para no responderse a sí mismo
 */
function isBotGeneratedMessage(text) {
    if (!text) return true;
    const botMarkers = ['🎲', '👋', '✅', '❌', '🎉', '📋', '•', '🔢', '👤', '🏠', '💳', '⏳', '📊', '🔒', '📢', '♻️', 'ℹ️', '⚠️', '👉', '🔙', '👑', '🏆', '🔔', '📱'];
    return botMarkers.some(marker => text.startsWith(marker));
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

async function handleMessage(msg, client) {
    const rawBody = (msg.body || '').trim();
    if (!rawBody) return;

    // Si el mensaje fue enviado por la propia cuenta del bot:
    // Solo lo procesamos si NO es una respuesta generada por el bot (para evitar bucles)
    if (msg.fromMe && isBotGeneratedMessage(rawBody)) {
        return;
    }

    const isGroup = msg.from.endsWith('@g.us') || (msg.fromMe && (msg.to || '').endsWith('@g.us'));
    const currentGroupId = isGroup ? (msg.from.endsWith('@g.us') ? msg.from : msg.to) : null;
    
    // Identificar al remitente (si es fromMe, es el admin mismo en su chat propio)
    const senderChatId = isGroup ? (msg.author || msg.from) : (msg.fromMe ? (msg.to || msg.from) : msg.from);
    const senderPhone = senderChatId.replace(/@.*/, '');
    const session = getSession(senderChatId);
    const isUserAdmin = Boolean(msg.fromMe || isAdmin(senderPhone, msg));

    const normalizedBody = rawBody.toUpperCase();

    // =============================================================
    // 1. SI EL MENSAJE ES EN UN GRUPO
    // =============================================================
    if (isGroup) {
        if (rawBody.toLowerCase() === '!idgrupo') {
            await sendReply(client, currentGroupId, `🆔 *ID de este Grupo:* \`${currentGroupId}\``);
            return;
        }

        if (config.GRUPO_ID && currentGroupId !== config.GRUPO_ID) {
            return;
        }

        // Comandos de administrador en el grupo (ej: !anuncio, !pagado, !pagados, !liberar)
        if (rawBody.startsWith(config.PREFIX) && isUserAdmin) {
            const args = rawBody.slice(config.PREFIX.length).trim().split(/\s+/);
            const command = args.shift().toLowerCase();
            
            if (command === 'anuncio') {
                await cmdAnuncio(client, currentGroupId, args);
                return;
            }
            if (command === 'pagado') {
                await cmdPagado(client, currentGroupId, args, senderPhone);
                return;
            }
            if (command === 'pagados' || command === 'listapagados' || command === 'comprados') {
                await cmdPagados(client, currentGroupId);
                return;
            }
            if (command === 'liberar') {
                await cmdLiberar(client, currentGroupId, args);
                return;
            }
        }

        // Si alguien escribe SORTEO en el grupo
        if (normalizedBody === 'SORTEO') {
            const botNumber = client.info?.wid?.user;
            const waLink = botNumber ? `\n\n👉 *Haz clic aquí:* https://wa.me/${botNumber}?text=SORTEO` : '';
            
            await sendReply(
                client, 
                currentGroupId,
                `👋 ¡Hola! Para reservar tu número y ver los disponibles, la atención es por *chat privado* 📲.\n\n` +
                `Por favor envíame un mensaje privado con la palabra *SORTEO*.${waLink}`
            );

            session.step = 'MENU';
            session.tempData = {};
            await sendReply(client, senderChatId, buildMainMenu(isUserAdmin));
            return;
        }

        return;
    }

    // =============================================================
    // 2. SI EL MENSAJE ES EN CHAT PRIVADO (O CHAT CON UNO MISMO)
    // =============================================================

    // Apertura o reinicio del menú con SORTEO o MENU
    if (normalizedBody === 'SORTEO' || normalizedBody === '!SORTEO' || normalizedBody === 'MENU' || normalizedBody === '!MENU') {
        session.step = 'MENU';
        session.tempData = {};
        await sendReply(client, senderChatId, buildMainMenu(isUserAdmin));
        return;
    }

    // Si el usuario escribe 0 o VOLVER
    if (normalizedBody === '0' || normalizedBody === 'VOLVER') {
        session.step = 'MENU';
        session.tempData = {};
        await sendReply(client, senderChatId, buildMainMenu(isUserAdmin));
        return;
    }

    // Si está dentro de una sesión interactiva del menú
    if (session.step !== 'IDLE') {
        const handled = await handleConversationFlow(client, senderChatId, rawBody, session, senderPhone, isUserAdmin);
        if (handled) return;
    }

    // Comandos directos de administrador en privado
    if (rawBody.startsWith(config.PREFIX) && isUserAdmin) {
        const args = rawBody.slice(config.PREFIX.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        await handleDirectCommand(client, senderChatId, command, args, senderPhone);
        return;
    }

    // Cualquier otro mensaje inicial en privado abre el menú con toda la información
    session.step = 'MENU';
    session.tempData = {};
    await sendReply(client, senderChatId, buildMainMenu(isUserAdmin));
    return;
}

// -------------------------------------------------------------
// MENÚS Y TEXTOS
// -------------------------------------------------------------

function buildMainMenu(isAdminUser) {
    const premiosTexto = (config.PREMIOS || '').replace(/\\n/g, '\n');
    const modalidadTexto = (config.MODALIDAD_SORTEO || '').replace(/\\n/g, '\n');

    let text = `🎲 *${config.EVENTO_NOMBRE}* 🎲\n\n`;
    text += `🎁 *Premios:*\n${premiosTexto}\n\n`;
    text += `📅 *Fecha del sorteo:* ${config.FECHA_SORTEO}\n`;
    text += `🎲 *Modalidad:* ${modalidadTexto}\n`;
    text += `💰 *Valor del número:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📋 *Por favor responde con el número de la opción que deseas:*\n\n`;
    text += `1️⃣ 🎟️ *Elegir / Reservar un número*\n`;
    text += `2️⃣ 📋 *Ver números disponibles*\n`;
    text += `3️⃣ 🔍 *Consultar mis números y pagos*\n`;
    text += `4️⃣ 💳 *Datos para transferir (Alias/CBU)*\n`;
    text += `5️⃣ 🏆 *Ver premios y bases completas*\n`;
    
    if (isAdminUser) {
        text += `6️⃣ 👑 *Menú de Administrador*\n`;
    }

    text += `\n💡 *Responde con el número de la opción (1, 2, 3, 4, 5${isAdminUser ? ' o 6' : ''}).*`;
    return text;
}

function buildAdminMenu() {
    let text = `👑 *MENÚ DE ADMINISTRADOR* 👑\n\n`;
    text += `Elige una opción:\n\n`;
    text += `1️⃣ ✅ *Confirmar pago de un número*\n`;
    text += `2️⃣ ♻️ *Liberar un número*\n`;
    text += `3️⃣ ⏳ *Ver reservas pendientes de pago*\n`;
    text += `4️⃣ 🟢 *Ver listado de números pagados*\n`;
    text += `5️⃣ 📊 *Ver balance y recaudación*\n`;
    text += `6️⃣ 📋 *Ver tablero completo*\n\n`;
    text += `0️⃣ 🔙 *Volver al menú principal*`;
    return text;
}

// -------------------------------------------------------------
// FLUJO CONVERSACIONAL PASO A PASO
// -------------------------------------------------------------

async function handleConversationFlow(client, chatId, text, session, senderPhone, isUserAdmin) {
    const input = text.trim();

    // Cancelar o volver atrás en cualquier paso
    if (input === '0' || input.toUpperCase() === 'VOLVER') {
        if (session.step.startsWith('ADMIN_WAITING_')) {
            session.step = 'ADMIN_MENU';
            await sendReply(client, chatId, buildAdminMenu());
            return true;
        }
        session.step = 'MENU';
        session.tempData = {};
        await sendReply(client, chatId, buildMainMenu(isUserAdmin));
        return true;
    }

    // Manejador del Menú Principal
    if (session.step === 'MENU') {
        if (input === '1') {
            session.step = 'WAITING_NUMBER';
            session.tempData = {};
            await sendReply(
                client,
                chatId,
                `🔢 *PASO 1 de 4: Elección de Número*\n\n` +
                `Escribe el *número* que deseas reservar (por ejemplo: \`042\`):\n\n` +
                `🔙 _Escribe 0 para volver al menú principal_`
            );
            return true;
        } else if (input === '2') {
            await cmdLibres(client, chatId);
            await sendReply(
                client, 
                chatId, 
                `👉 *Opciones:*\n` +
                `• Escribe *1* para reservar un número ahora\n` +
                `• Escribe *0* para volver al menú principal`
            );
            return true;
        } else if (input === '3') {
            await cmdMisNumeros(client, chatId, senderPhone);
            await sendReply(client, chatId, `🔙 _Escribe 0 para volver al menú principal_`);
            return true;
        } else if (input === '4') {
            await cmdDatosPago(client, chatId);
            await sendReply(client, chatId, `🔙 _Escribe 0 para volver al menú principal_`);
            return true;
        } else if (input === '5') {
            await cmdPremios(client, chatId);
            await sendReply(
                client, 
                chatId, 
                `👉 *Opciones:*\n` +
                `• Escribe *1* para reservar un número\n` +
                `• Escribe *0* para volver al menú principal`
            );
            return true;
        } else if (input === '6' && isUserAdmin) {
            session.step = 'ADMIN_MENU';
            await sendReply(client, chatId, buildAdminMenu());
            return true;
        } else {
            const validOptions = isUserAdmin ? '1, 2, 3, 4, 5, 6 o 0' : '1, 2, 3, 4, 5 o 0';
            await sendReply(client, chatId, `⚠️ Opción no válida.\nPor favor responde con ${validOptions} para volver al menú:`);
            return true;
        }
    }

    // Paso 1: Validando el Número
    if (session.step === 'WAITING_NUMBER') {
        const num = db.normalizeNumber(input);
        if (!num) {
            await sendReply(
                client, 
                chatId, 
                `❌ Número inválido. Debe ser entre \`${String(config.NUMERO_MIN).padStart(config.DIGITOS_PAD, '0')}\` y \`${config.NUMERO_MAX}\`.\n\n` +
                `Por favor escribe un número válido (o escribe *0* para volver al menú):`
            );
            return true;
        }

        const item = db.getNumber(num);
        if (!item || item.estado !== 'LIBRE') {
            const ocupadoPor = item && item.vecino ? ` por *${item.vecino}*` : '';
            await sendReply(
                client, 
                chatId, 
                `❌ El número *${num}* ya no está disponible${ocupadoPor}.\n\n` +
                `Por favor escribe otro número libre (o escribe *0* para volver al menú):`
            );
            return true;
        }

        session.tempData.numero = num;
        session.step = 'WAITING_NAME';
        await sendReply(
            client,
            chatId,
            `✅ ¡El número *${num}* está disponible!\n\n` +
            `👤 *PASO 2 de 4: Nombre y Apellido*\n` +
            `Escribe el *Nombre y Apellido* de la persona titular del número:\n` +
            `*(Ejemplo: \`Carlos Gomez\`)*\n\n` +
            `🔙 _Escribe 0 para volver al menú principal_`
        );
        return true;
    }

    // Paso 2: Validando Nombre y Apellido
    if (session.step === 'WAITING_NAME') {
        if (input.length < 3) {
            await sendReply(client, chatId, `⚠️ Por favor ingresa un nombre y apellido válido (ej: \`Juan Perez\`):\n\n🔙 _Escribe 0 para volver_`);
            return true;
        }

        session.tempData.nombre = input;
        session.step = 'WAITING_ADDRESS';
        await sendReply(
            client,
            chatId,
            `🏠 *PASO 3 de 4: Domicilio / Dirección*\n\n` +
            `Escribe el *Domicilio* o *Número de Casa* de la persona:\n` +
            `*(Ejemplo: \`Barrio Carolina II Casa 18\` o \`Av. Libertador 450\`)*\n\n` +
            `🔙 _Escribe 0 para volver al menú principal_`
        );
        return true;
    }

    // Paso 3: Validando Domicilio
    if (session.step === 'WAITING_ADDRESS') {
        if (input.length < 2) {
            await sendReply(client, chatId, `⚠️ Por favor ingresa un domicilio válido:\n\n🔙 _Escribe 0 para volver_`);
            return true;
        }

        session.tempData.domicilio = input;
        session.step = 'WAITING_PHONE';
        await sendReply(
            client,
            chatId,
            `📱 *PASO 4 de 4: Teléfono de WhatsApp*\n\n` +
            `Escribe el *número de celular* de la persona para enviarle las confirmaciones por WhatsApp:\n` +
            `*(Ejemplo: \`2644863938\` o escribe \`-\` para usar este mismo teléfono)*\n\n` +
            `🔙 _Escribe 0 para volver al menú principal_`
        );
        return true;
    }

    // Paso 4: Validando Teléfono y Guardando la Reserva
    if (session.step === 'WAITING_PHONE') {
        let telefonoFinal = senderPhone;
        const cleanInput = input.trim();

        if (cleanInput && cleanInput !== '-' && cleanInput !== '0') {
            const formatted = formatPhoneNumber(cleanInput);
            if (!formatted || cleanPhone(cleanInput).length < 8) {
                await sendReply(
                    client,
                    chatId,
                    `⚠️ Número de teléfono no válido.\nPor favor ingresa un número de celular con código de área (ej: \`2644863938\`) o escribe \`-\` para usar este mismo teléfono:\n\n🔙 _Escribe 0 para volver al menú_`
                );
                return true;
            }
            telefonoFinal = formatted;
        }

        const nombre = session.tempData.nombre;
        const numero = session.tempData.numero;
        const domicilio = session.tempData.domicilio;

        const result = db.reserveNumber(numero, nombre, domicilio, telefonoFinal);
        session.step = 'MENU';
        session.tempData = {};

        if (!result.success) {
            await sendReply(client, chatId, `❌ ${result.message}\n\n🔙 _Escribe 0 para volver al menú_`);
            return true;
        }

        const confirmacion = 
            `🎉 *¡RESERVA CONFIRMADA!*\n\n` +
            `• 🎟️ *Número:* *${result.numero}*\n` +
            `• 👤 *Titular:* ${nombre}\n` +
            `• 🏠 *Domicilio:* ${domicilio}\n` +
            `• 📱 *Teléfono:* ${telefonoFinal}\n` +
            `• 💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n` +
            `🏦 *Datos para transferir:*\n` +
            `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
            `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
            `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
            `• *Banco:* ${config.DATOS_PAGO.banco}\n\n` +
            `⚠️ *Importante:* Envía el comprobante de transferencia al administrador dentro de las *${config.HORAS_LIMITE_PAGO} hs* para confirmar tu jugada.\n\n` +
            `👉 *¿Deseas elegir otro número?* Escribe *1* para reservar otro o *0* para volver al menú principal.`;

        await sendReply(client, chatId, confirmacion);

        // Notificar al titular por WhatsApp si es un teléfono diferente al que escribió
        const titularWaId = formatWhatsAppId(telefonoFinal);
        if (titularWaId && titularWaId !== chatId) {
            const avisoTitular = 
                `🎉 *¡RESERVA CONFIRMADA - ${config.EVENTO_NOMBRE}!*\n\n` +
                `Hola *${nombre}*, te informamos que se reservó a tu nombre el número:\n` +
                `• 🎟️ *Número:* *${result.numero}*\n` +
                `• 🏠 *Domicilio:* ${domicilio}\n` +
                `• 💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n` +
                `🏦 *Datos para transferir:*\n` +
                `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
                `• *CBU:* \`${config.DATOS_PAGO.cbu}\`\n` +
                `• *Titular:* ${config.DATOS_PAGO.titular}\n` +
                `• *Banco:* ${config.DATOS_PAGO.banco}\n\n` +
                `⚠️ *Importante:* Envía el comprobante dentro de las *${config.HORAS_LIMITE_PAGO} hs* para confirmar tu jugada.`;
            await sendReply(client, titularWaId, avisoTitular);
        }

        // Notificar al grupo si está configurado
        if (config.GRUPO_ID) {
            await sendReply(
                client,
                config.GRUPO_ID,
                `🎟️ *Nueva reserva:* Se reservó el número *${result.numero}* a nombre de *${nombre}* (*${domicilio}*).`
            );
        }

        // Notificar a los administradores
        if (config.ADMIN_PHONES && config.ADMIN_PHONES.length > 0) {
            const avisoAdmin = 
                `🔔 *Aviso Admin - Nueva Reserva:*\n` +
                `• 🎟️ *Número:* *${result.numero}*\n` +
                `• 👤 *Titular:* ${nombre}\n` +
                `• 🏠 *Domicilio:* ${domicilio}\n` +
                `• 📱 *Teléfono:* ${telefonoFinal}\n` +
                `• 📲 *Registrado desde:* ${senderPhone}`;
            
            for (const admin of config.ADMIN_PHONES) {
                const adminWaId = formatWhatsAppId(admin);
                if (adminWaId && adminWaId !== chatId) {
                    await sendReply(client, adminWaId, avisoAdmin);
                }
            }
        }
        return true;
    }

    // Submenú de Administrador
    if (session.step === 'ADMIN_MENU') {
        if (input === '1') {
            session.step = 'ADMIN_WAITING_PAY';
            session.tempData = {};
            await sendReply(
                client, 
                chatId, 
                `🔢 *CONFIRMAR O REGISTRAR PAGO*\n\n` +
                `Escribe el *número* a cobrar o confirmar (ej: \`042\`):\n\n` +
                `💡 _Si el número ya está reservado se confirmará el pago directamente. Si está libre, te pedirá los datos para registrar la venta._\n\n` +
                `🔙 _Escribe 0 para volver_`
            );
            return true;
        } else if (input === '2') {
            session.step = 'ADMIN_WAITING_RELEASE';
            session.tempData = {};
            await sendReply(client, chatId, `Escribe el número a *LIBERAR* (ej: \`042\`):\n\n🔙 _Escribe 0 para volver_`);
            return true;
        } else if (input === '3') {
            await cmdPendientes(client, chatId);
            await sendReply(client, chatId, `👉 Responde con *1* (Confirmar pago), *2* (Liberar), *4* (Pagados), *5* (Balance), *6* (Tablero) o *0* (Volver)`);
            return true;
        } else if (input === '4') {
            await cmdPagados(client, chatId);
            await sendReply(client, chatId, `👉 Responde con *1* (Confirmar pago), *2* (Liberar), *3* (Pendientes), *5* (Balance), *6* (Tablero) o *0* (Volver)`);
            return true;
        } else if (input === '5') {
            await cmdResumen(client, chatId);
            await sendReply(client, chatId, `👉 Responde con *1* (Confirmar pago), *2* (Liberar), *3* (Pendientes), *4* (Pagados), *6* (Tablero) o *0* (Volver)`);
            return true;
        } else if (input === '6') {
            await cmdTablero(client, chatId);
            await sendReply(client, chatId, `👉 Responde con *1* (Confirmar pago), *2* (Liberar), *3* (Pendientes), *4* (Pagados), *5* (Balance) o *0* (Volver)`);
            return true;
        } else if (input === '0') {
            session.step = 'MENU';
            session.tempData = {};
            await sendReply(client, chatId, buildMainMenu(isUserAdmin));
            return true;
        } else {
            await sendReply(client, chatId, `⚠️ Opción no válida.\nPor favor responde con 1, 2, 3, 4, 5, 6 o 0 para volver al menú principal:`);
            return true;
        }
    }

    if (session.step === 'ADMIN_WAITING_PAY') {
        const num = db.normalizeNumber(input);
        if (!num) {
            await sendReply(
                client, 
                chatId, 
                `❌ Número inválido. Debe ser entre \`${String(config.NUMERO_MIN).padStart(config.DIGITOS_PAD, '0')}\` y \`${config.NUMERO_MAX}\`.\n\n` +
                `Por favor escribe un número válido (o escribe *0* para volver al menú):`
            );
            return true;
        }

        const item = db.getNumber(num);
        if (!item) {
            await sendReply(client, chatId, `❌ El número no existe.\n\n🔙 _Escribe 0 para volver al menú_`);
            return true;
        }

        if (item.estado === 'PAGADO') {
            await sendReply(client, chatId, `⚠️ El número *${num}* ya figura como *PAGADO* por *${item.vecino}* (${item.casa}).\n\n🔙 _Escribe 0 para volver o elige otro número:_`);
            return true;
        }

        if (item.estado === 'RESERVADO') {
            // Confirmar pago de reserva existente
            const res = db.confirmPayment(num, senderPhone);
            session.step = 'ADMIN_MENU';
            session.tempData = {};
            await sendReply(client, chatId, `✅ *¡Pago Confirmado!* Número *${res.numero}* (${res.item.vecino} - ${res.item.casa}) registrado como 🟢 *PAGADO*.`);
            
            if (config.GRUPO_ID) {
                await sendReply(client, config.GRUPO_ID, `🎉 *¡Pago confirmado!* Número *${res.numero}* de *${res.item.vecino}* (*${res.item.casa}*) 🟢 PAGADO.`);
            }
            
            if (res.item.telefono) {
                const titularWaId = formatWhatsAppId(res.item.telefono);
                if (titularWaId) {
                    const premiosTexto = (config.PREMIOS || '').replace(/\\n/g, '\n');
                    const reciboMsg = 
                        `🎉 *¡PAGO CONFIRMADO!* 🟢\n\n` +
                        `Hola *${res.item.vecino}*, te confirmamos que tu pago por el número *${res.numero}* ha sido registrado correctamente.\n\n` +
                        `• 🎟️ *Número:* *${res.numero}*\n` +
                        `• 👤 *Titular:* ${res.item.vecino}\n` +
                        `• 🏠 *Domicilio:* ${res.item.casa}\n` +
                        `• 💰 *Monto:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
                        `• 🟢 *Estado:* PAGADO\n\n` +
                        `🎁 *Premios:*\n${premiosTexto}\n\n` +
                        `📅 *Fecha de sorteo:* ${config.FECHA_SORTEO}\n` +
                        `¡Mucha suerte!`;
                    await sendReply(client, titularWaId, reciboMsg);
                }
            }
            await sendReply(client, chatId, buildAdminMenu());
            return true;
        }

        if (item.estado === 'LIBRE') {
            // Iniciar venta directa
            session.tempData.numero = num;
            session.step = 'ADMIN_DIRECT_PAY_NAME';
            await sendReply(
                client, 
                chatId, 
                `ℹ️ El número *${num}* está actualmente *LIBRE*.\n\n` +
                `👤 *Paso 1 de 3: Nombre y Apellido*\n` +
                `Escribe el *Nombre y Apellido* del comprador para registrar la venta directa:\n\n` +
                `🔙 _Escribe 0 para volver_`
            );
            return true;
        }
    }

    if (session.step === 'ADMIN_DIRECT_PAY_NAME') {
        if (input.length < 2) {
            await sendReply(client, chatId, `⚠️ Por favor ingresa un nombre válido:\n\n🔙 _Escribe 0 para cancelar_`);
            return true;
        }
        session.tempData.nombre = input;
        session.step = 'ADMIN_DIRECT_PAY_ADDRESS';
        await sendReply(
            client, 
            chatId, 
            `🏠 *Paso 2 de 3: Domicilio / Casa*\n` +
            `Escribe el *Domicilio* o *Número de Casa* de *${input}* (o escribe \`-\` si no lo sabes):\n\n` +
            `🔙 _Escribe 0 para cancelar_`
        );
        return true;
    }

    if (session.step === 'ADMIN_DIRECT_PAY_ADDRESS') {
        session.tempData.domicilio = (input === '-' || input.trim() === '') ? 'Barrio Carolina II' : input;
        session.step = 'ADMIN_DIRECT_PAY_PHONE';
        await sendReply(
            client,
            chatId,
            `📱 *Paso 3 de 3: Teléfono de WhatsApp*\n` +
            `Escribe el *número de celular* del comprador para enviarle el comprobante (o escribe \`-\` si no tiene):\n\n` +
            `🔙 _Escribe 0 para cancelar_`
        );
        return true;
    }

    if (session.step === 'ADMIN_DIRECT_PAY_PHONE') {
        let telefonoFinal = null;
        const cleanInput = input.trim();
        if (cleanInput && cleanInput !== '-' && cleanInput !== '0') {
            telefonoFinal = formatPhoneNumber(cleanInput) || cleanInput;
        }

        const nombre = session.tempData.nombre;
        const numero = session.tempData.numero;
        const domicilio = session.tempData.domicilio;

        const res = db.confirmPayment(numero, senderPhone, nombre, domicilio, telefonoFinal);
        session.step = 'ADMIN_MENU';
        session.tempData = {};

        if (!res.success) {
            await sendReply(client, chatId, `❌ ${res.message}\n\n🔙 _Escribe 0 para volver al menú_`);
        } else {
            await sendReply(
                client, 
                chatId, 
                `🎉 *¡Venta Directa Registrada y Pagada!* 🟢\n\n` +
                `• 🎟️ *Número:* *${res.numero}*\n` +
                `• 👤 *Titular:* ${nombre}\n` +
                `• 🏠 *Domicilio:* ${domicilio}\n` +
                `• 📱 *Teléfono:* ${telefonoFinal || 'No registrado'}\n` +
                `• 💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
                `• 🟢 *Estado:* PAGADO`
            );
            if (config.GRUPO_ID) {
                await sendReply(client, config.GRUPO_ID, `🎉 *¡Nuevo número vendido!* Número *${res.numero}* de *${nombre}* (*${domicilio}*) 🟢 PAGADO.`);
            }
            if (telefonoFinal) {
                const titularWaId = formatWhatsAppId(telefonoFinal);
                if (titularWaId) {
                    const premiosTexto = (config.PREMIOS || '').replace(/\\n/g, '\n');
                    const reciboMsg = 
                        `🎉 *¡PAGO CONFIRMADO - COMPROBANTE!* 🟢\n\n` +
                        `Hola *${nombre}*, te confirmamos el pago de tu número para el *${config.EVENTO_NOMBRE}*:\n\n` +
                        `• 🎟️ *Número:* *${res.numero}*\n` +
                        `• 👤 *Titular:* ${nombre}\n` +
                        `• 🏠 *Domicilio:* ${domicilio}\n` +
                        `• 💰 *Monto Pagado:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
                        `• 🟢 *Estado:* PAGADO\n\n` +
                        `🎁 *Premios:*\n${premiosTexto}\n\n` +
                        `📅 *Fecha de sorteo:* ${config.FECHA_SORTEO}\n` +
                        `¡Muchas gracias por colaborar y mucha suerte!`;
                    await sendReply(client, titularWaId, reciboMsg);
                }
            }
            await sendReply(client, chatId, buildAdminMenu());
        }
        return true;
    }

    if (session.step === 'ADMIN_WAITING_RELEASE') {
        const res = db.releaseNumber(input);
        session.step = 'ADMIN_MENU';
        session.tempData = {};
        if (!res.success) {
            await sendReply(client, chatId, `❌ ${res.message}\n\n🔙 _Escribe 0 para volver al menú_`);
        } else {
            await sendReply(client, chatId, `♻️ Número *${res.numero}* liberado y disponible nuevamente.`);
            await sendReply(client, chatId, buildAdminMenu());
        }
        return true;
    }

    return false;
}

// -------------------------------------------------------------
// COMANDOS DIRECTOS
// -------------------------------------------------------------

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

        case 'premios':
        case 'sorteo':
        case 'bases':
            await cmdPremios(client, chatId);
            break;

        case 'pagado':
            if (args.length > 0) {
                await cmdPagado(client, chatId, args, senderPhone);
            }
            break;

        case 'liberar':
            if (args.length > 0) {
                await cmdLiberar(client, chatId, args);
            }
            break;

        case 'pendientes':
            await cmdPendientes(client, chatId);
            break;

        case 'pagados':
        case 'listapagados':
        case 'comprados':
            await cmdPagados(client, chatId);
            break;

        case 'resumen':
            await cmdResumen(client, chatId);
            break;

        case 'tablero':
            await cmdTablero(client, chatId);
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

async function cmdPagados(client, chatId) {
    const pagados = db.getPaidNumbers();
    const total = config.NUMERO_MAX - config.NUMERO_MIN + 1;

    if (pagados.length === 0) {
        await sendReply(client, chatId, '🟢 Aún no hay números registrados como pagados.');
        return;
    }

    const shortList = pagados.map(p => p.numero).join(' - ');
    const text = `🟢 *Números Pagados (${pagados.length}/${total}):*\n\n` + shortList;
    await sendReply(client, chatId, text);
}

async function cmdMisNumeros(client, chatId, senderPhone) {
    const userNums = db.getUserNumbers(senderPhone);
    if (userNums.length === 0) {
        await sendReply(client, chatId, 'ℹ️ No tienes ningún número registrado a nombre de este teléfono.');
        return;
    }

    let text = `🎟️ *Números registrados desde este teléfono:*\n\n`;
    for (const item of userNums) {
        const estadoEmoji = item.estado === 'PAGADO' ? '🟢 PAGADO' : '🟡 PENDIENTE DE PAGO';
        text += `• Número *${item.numero}* -> ${estadoEmoji}\n  Titular: *${item.vecino}* | Domicilio: *${item.casa}*\n`;
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

async function cmdPremios(client, chatId) {
    const premiosTexto = (config.PREMIOS || '').replace(/\\n/g, '\n');
    const modalidadTexto = (config.MODALIDAD_SORTEO || '').replace(/\\n/g, '\n');

    let text = `🏆 *PREMIOS Y BASES DEL SORTEO* 🏆\n\n`;
    text += `🎁 *Premios:*\n${premiosTexto}\n\n`;
    text += `📅 *Fecha del sorteo:* ${config.FECHA_SORTEO}\n`;
    text += `🎲 *Modalidad:* ${modalidadTexto}\n`;
    text += `💰 *Valor del número:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}`;
    
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
    const raw = db.readRawData();
    let text = `📋 *TABLERO DE NÚMEROS:*\n\n`;
    const sorted = Object.entries(raw.numeros).sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));
    for (const [num, data] of sorted) {
        if (data.estado === 'LIBRE') text += `[${num}] ⚪ Libre\n`;
        else if (data.estado === 'RESERVADO') text += `[${num}] 🟡 ${data.vecino} (${data.casa}) - Pendiente\n`;
        else if (data.estado === 'PAGADO') text += `[${num}] 🟢 ${data.vecino} (${data.casa}) - Pagado\n`;
    }
    await sendReply(client, chatId, text);
}

async function cmdPagado(client, targetChat, args, adminPhone) {
    const res = db.confirmPayment(args[0], adminPhone);
    if (res.success) {
        await sendReply(client, targetChat, `✅ *¡Pago Confirmado!* Número *${res.numero}* (${res.item.vecino} - ${res.item.casa}) 🟢 PAGADO.`);
        if (config.GRUPO_ID && targetChat !== config.GRUPO_ID) {
            await sendReply(client, config.GRUPO_ID, `🎉 *¡Pago confirmado!* Número *${res.numero}* de *${res.item.vecino}* (*${res.item.casa}*) 🟢 PAGADO.`);
        }
        if (res.item.telefono) {
            const titularWaId = formatWhatsAppId(res.item.telefono);
            if (titularWaId) {
                const premiosTexto = (config.PREMIOS || '').replace(/\\n/g, '\n');
                const reciboMsg = 
                    `🎉 *¡PAGO CONFIRMADO!* 🟢\n\n` +
                    `Hola *${res.item.vecino}*, te confirmamos que tu pago por el número *${res.numero}* ha sido registrado correctamente.\n\n` +
                    `• 🎟️ *Número:* *${res.numero}*\n` +
                    `• 👤 *Titular:* ${res.item.vecino}\n` +
                    `• 🏠 *Domicilio:* ${res.item.casa}\n` +
                    `• 💰 *Monto:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
                    `• 🟢 *Estado:* PAGADO\n\n` +
                    `🎁 *Premios:*\n${premiosTexto}\n\n` +
                    `📅 *Fecha de sorteo:* ${config.FECHA_SORTEO}\n` +
                    `¡Mucha suerte!`;
                await sendReply(client, titularWaId, reciboMsg);
            }
        }
    } else {
        await sendReply(client, targetChat, `❌ ${res.message}`);
    }
}

async function cmdLiberar(client, targetChat, args) {
    const res = db.releaseNumber(args[0]);
    if (res.success) {
        await sendReply(client, targetChat, `♻️ Número *${res.numero}* liberado y disponible nuevamente.`);
    } else {
        await sendReply(client, targetChat, `❌ ${res.message}`);
    }
}

async function cmdAnuncio(client, groupId, args) {
    if (!groupId) return;
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
