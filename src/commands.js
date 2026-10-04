const config = require('./config');
const db = require('./db');
const scheduler = require('./scheduler');
const mp = require('./mercadopago');
const gemini = require('./gemini');

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
    const cleanSender = String(phone || '').replace(/\D/g, '');
    if (!cleanSender) return false;

    const stripCountry = (p) => {
        let s = String(p || '').replace(/\D/g, '');
        if (s.startsWith('549')) s = s.slice(3);
        else if (s.startsWith('54')) s = s.slice(2);
        return s.replace(/^0+/, '');
    };

    const senderBase = stripCountry(cleanSender);

    return config.ADMIN_PHONES.some(admin => {
        const cleanAdm = String(admin || '').replace(/\D/g, '');
        if (!cleanAdm) return false;
        const admBase = stripCountry(cleanAdm);

        return senderBase === admBase || 
               cleanSender === cleanAdm || 
               cleanSender.endsWith(admBase) || 
               cleanAdm.endsWith(senderBase);
    });
}

// Registro de mensajes enviados recientemente por el bot para prevenir bucles de auto-procesamiento
const recentBotMessages = new Set();

function recordSentMessage(text) {
    if (!text) return;
    const key = String(text).trim();
    recentBotMessages.add(key);
    setTimeout(() => {
        recentBotMessages.delete(key);
    }, 30000);
}

/**
 * Detecta si un mensaje fue generado automáticamente por el bot para no responderse a sí mismo
 */
function isBotGeneratedMessage(text) {
    if (!text) return true;
    const cleanText = String(text).trim();
    if (recentBotMessages.has(cleanText)) {
        return true;
    }
    const botMarkers = [
        '🎲', '👋', '✅', '❌', '🎉', '📋', '•', '🔢', '👤', '🏠', '💳', 
        '⏳', '📊', '🔒', '📢', '♻️', 'ℹ️', '⚠️', '👉', '🔙', '👑', '🏆', 
        '🔔', '📱', '━', '📥', '🚨', '🤖', '🎁', '💰', '📅', '🎯', '🧾', 
        '💡', '📲', '🟢', '🟡', '⚪', '👏'
    ];
    if (botMarkers.some(marker => cleanText.startsWith(marker))) {
        return true;
    }
    if (config.DATOS_PAGO && config.DATOS_PAGO.alias) {
        if (cleanText.toLowerCase() === config.DATOS_PAGO.alias.toLowerCase()) {
            return true;
        }
    }
    return false;
}

/**
 * Enviar mensaje de forma directa y segura
 */
async function sendReply(client, chatId, text) {
    try {
        if (text) {
            recordSentMessage(text);
        }
        await client.sendMessage(chatId, text);
        return true;
    } catch (e) {
        console.error(`[Error enviando mensaje a ${chatId}]:`, e.message);
        return false;
    }
}

/**
 * Notifica a los administradores (grupo de admins o teléfonos directos)
 */
async function notifyAdmins(client, text) {
    try {
        if (config.ADMIN_GRUPO_ID) {
            await sendReply(client, config.ADMIN_GRUPO_ID, text);
        } else if (config.ADMIN_PHONES && config.ADMIN_PHONES.length > 0) {
            for (const admin of config.ADMIN_PHONES) {
                const adminWaId = formatWhatsAppId(admin);
                if (adminWaId) {
                    await sendReply(client, adminWaId, text);
                }
            }
        }
    } catch (e) {
        console.error('[Error notificando a administradores]:', e.message);
    }
}

/**
 * Descarga archivos multimedia con múltiples métodos de respaldo (estándar, DOM directo y buffers)
 */
async function downloadMediaCustom(client, msg) {
    // 1. Intentar método nativo de whatsapp-web.js con reintentos
    for (let i = 0; i < 2; i++) {
        try {
            const media = await msg.downloadMedia();
            if (media && media.data) {
                return media;
            }
        } catch (e) {
            console.log(`[Media] Descarga nativa intento ${i + 1} falló:`, e.message || e);
        }
        await new Promise(r => setTimeout(r, 600));
    }

    // 2. Extractor avanzado directo desde el contexto de Puppeteer / WhatsApp Web
    try {
        if (!client || !client.pupPage) return null;
        const serializedId = msg.id?._serialized || (typeof msg.id === 'string' ? msg.id : '') || msg.id?.id || '';

        console.log(`[Media] Msg info: type=${msg.type}, hasMedia=${msg.hasMedia}, mimetype=${msg.mimetype}, id=${serializedId}`);
        const debugInfo = await client.pupPage.evaluate((msgId) => {
            try {
                const idStr = String(msgId || '');
                const coll = window.require('WAWebCollections').Msg;
                const models = coll?.models || coll?._models || [];
                
                // Filtrar solo mensajes que realmente sean de tipo imagen o documento
                const realMediaMsgs = models.filter(i => 
                    i.type === 'image' || 
                    i.type === 'document' || 
                    (i.mimetype && (i.mimetype.startsWith('image/') || i.mimetype === 'application/pdf'))
                );

                let m = idStr ? coll?.get(idStr) : null;
                if (!m || m.type === 'chat') {
                    const rawId = idStr.includes('_') ? idStr.split('_')[2] : idStr;
                    m = models.find(i => (idStr && i.id?._serialized === idStr) || (rawId && i.id?.id === rawId));
                }
                if (!m || m.type === 'chat') {
                    m = realMediaMsgs[realMediaMsgs.length - 1];
                }

                if (!m) return { found: false, totalModels: models.length, totalMediaFound: realMediaMsgs.length };
                return {
                    found: true,
                    id: m.id?._serialized,
                    type: m.type,
                    mimetype: m.mimetype,
                    mediaStage: m.mediaData?.mediaStage,
                    hasMediaBlob: Boolean(m.mediaData?.mediaBlob),
                    hasPreview: Boolean(m.mediaData?.preview),
                    hasRenderableUrl: Boolean(m.mediaData?.renderableUrl),
                    totalModels: models.length,
                    totalMediaFound: realMediaMsgs.length
                };
            } catch (e) {
                return { error: e.message || String(e) };
            }
        }, serializedId);
        console.log('[Media Debug Info]:', JSON.stringify(debugInfo));

        const result = await client.pupPage.evaluate(async (msgId) => {
            try {
                const findMsg = async (idInput) => {
                    try {
                        const idStrSafe = String(idInput || '');
                        const coll = window.require('WAWebCollections').Msg;
                        if (!coll) return null;
                        const models = coll.models || coll._models || [];
                        
                        const realMediaList = models.filter(m => 
                            m.type === 'image' || 
                            m.type === 'document' || 
                            (m.mimetype && (m.mimetype.startsWith('image/') || m.mimetype === 'application/pdf'))
                        );

                        let found = idStrSafe ? coll.get(idStrSafe) : null;
                        if (!found || found.type === 'chat') {
                            const rawId = idStrSafe.includes('_') ? idStrSafe.split('_')[2] : idStrSafe;
                            found = models.find(m => (idStrSafe && m.id?._serialized === idStrSafe) || (rawId && m.id?.id === rawId));
                        }
                        if (!found || found.type === 'chat') {
                            found = realMediaList[realMediaList.length - 1];
                        }
                        return found || null;
                    } catch (e) {
                        return null;
                    }
                };

                let msgObj = await findMsg(msgId);

                if (!msgObj || !msgObj.mediaData) {
                    return null;
                }

                // Disparar descarga en segundo plano si aún no está listo
                if (msgObj.mediaData.mediaStage !== 'RESOLVED') {
                    try {
                        if (typeof msgObj.downloadMedia === 'function') {
                            await msgObj.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
                        }
                    } catch (e) {}
                }

                // Esperar a que el estado se resuelva
                let wait = 0;
                while (msgObj.mediaData.mediaStage === 'FETCHING' && wait < 8) {
                    await new Promise(r => setTimeout(r, 400));
                    wait++;
                }

                // Opción A: A través de WAWebDownloadManager con Proxy QPL seguro
                try {
                    const mockQpl = new Proxy({}, { get: () => () => mockQpl });
                    const downloadManager = window.require('WAWebDownloadManager')?.downloadManager;
                    if (downloadManager && typeof downloadManager.downloadAndMaybeDecrypt === 'function') {
                        const decryptedMedia = await downloadManager.downloadAndMaybeDecrypt({
                            directPath: msgObj.directPath,
                            encFilehash: msgObj.encFilehash,
                            filehash: msgObj.filehash,
                            mediaKey: msgObj.mediaKey,
                            mediaKeyTimestamp: msgObj.mediaKeyTimestamp,
                            type: msgObj.type,
                            signal: new AbortController().signal,
                            downloadQpl: mockQpl,
                        });

                        if (decryptedMedia) {
                            const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
                            return {
                                data,
                                mimetype: msgObj.mimetype || 'image/jpeg',
                                filename: msgObj.filename || 'comprobante.jpg'
                            };
                        }
                    }
                } catch (errDM) {
                    console.log('Error en downloadAndMaybeDecrypt:', errDM);
                }

                const hash = msgObj.filehash || msgObj.mediaData?.filehash;

                // Opción B: A través de WAWebMediaInMemoryBlobCache (alta resolución)
                try {
                    if (hash) {
                        const cacheObj = window.require('WAWebMediaInMemoryBlobCache')?.InMemoryMediaBlobCache?.get(hash);
                        if (cacheObj) {
                            let buf = null;
                            if (typeof cacheObj.arrayBuffer === 'function') buf = await cacheObj.arrayBuffer();
                            else if (cacheObj instanceof ArrayBuffer) buf = cacheObj;
                            else if (cacheObj.buffer instanceof ArrayBuffer) buf = cacheObj.buffer;
                            if (buf) {
                                const data = await window.WWebJS.arrayBufferToBase64Async(buf);
                                return {
                                    data,
                                    mimetype: msgObj.mimetype || 'image/jpeg',
                                    filename: msgObj.filename || 'comprobante.jpg'
                                };
                            }
                        }
                    }
                } catch (errCache) {}

                // Opción C: A través de WAWebMediaStorage (alta resolución)
                try {
                    if (hash) {
                        const mediaObj = window.require('WAWebMediaStorage')?.getOrCreateMediaObject(hash);
                        const blob = mediaObj?.mediaBlob;
                        if (blob && typeof blob.arrayBuffer === 'function') {
                            const buf = await blob.arrayBuffer();
                            const data = await window.WWebJS.arrayBufferToBase64Async(buf);
                            return {
                                data,
                                mimetype: msgObj.mimetype || 'image/jpeg',
                                filename: msgObj.filename || 'comprobante.jpg'
                            };
                        }
                    }
                } catch (errStorage) {}

                // Opción D: A través de Blob en mediaData
                try {
                    const blob = msgObj.mediaData.mediaBlob || msgObj.mediaData._blob;
                    if (blob && typeof blob.arrayBuffer === 'function') {
                        const buf = await blob.arrayBuffer();
                        const data = await window.WWebJS.arrayBufferToBase64Async(buf);
                        return {
                            data,
                            mimetype: msgObj.mimetype || 'image/jpeg',
                            filename: msgObj.filename || 'comprobante.jpg'
                        };
                    }
                } catch (errBlob) {}

                // Opción E: A través de renderableUrl si está cargado
                try {
                    if (msgObj.mediaData.renderableUrl) {
                        const resp = await fetch(msgObj.mediaData.renderableUrl);
                        const buf = await resp.arrayBuffer();
                        const data = await window.WWebJS.arrayBufferToBase64Async(buf);
                        return {
                            data,
                            mimetype: msgObj.mimetype || 'image/jpeg',
                            filename: msgObj.filename || 'comprobante.jpg'
                        };
                    }
                } catch (errUrl) {}

                // Opción D: A través del preview thumbnail en base64 o buffer
                try {
                    if (msgObj.mediaData.preview) {
                        let prev = msgObj.mediaData.preview;
                        let b64 = prev._b64 || (typeof prev === 'string' ? prev : null);
                        if (b64 && typeof b64 === 'string') {
                            b64 = b64.replace(/^data:image\/[a-z]+;base64,/, '');
                            return {
                                data: b64,
                                mimetype: 'image/jpeg',
                                filename: 'comprobante.jpg'
                            };
                        } else if (prev instanceof ArrayBuffer || prev?.buffer instanceof ArrayBuffer) {
                            const buf = prev instanceof ArrayBuffer ? prev : prev.buffer;
                            const data = await window.WWebJS.arrayBufferToBase64Async(buf);
                            return {
                                data,
                                mimetype: 'image/jpeg',
                                filename: 'comprobante.jpg'
                            };
                        }
                    }
                } catch (errPrev) {}

            } catch (errEval) {
                console.error('Error dentro de evaluate media:', errEval);
            }

            // Opción E: Extractor directo del DOM buscando elementos <img> con src blob o base64
            try {
                const imgs = Array.from(document.querySelectorAll('img')).filter(img => 
                    img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:image'))
                );
                if (imgs.length > 0) {
                    const lastImg = imgs[imgs.length - 1];
                    if (lastImg.src.startsWith('data:image')) {
                        const parts = lastImg.src.split(',');
                        const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
                        return {
                            data: parts[1],
                            mimetype: mime,
                            filename: 'comprobante.jpg'
                        };
                    } else if (lastImg.src.startsWith('blob:')) {
                        const resp = await fetch(lastImg.src);
                        const buf = await resp.arrayBuffer();
                        const data = await window.WWebJS.arrayBufferToBase64Async(buf);
                        return {
                            data,
                            mimetype: 'image/jpeg',
                            filename: 'comprobante.jpg'
                        };
                    }
                }
            } catch (eDOM) {}

            return null;
        }, serializedId);

        if (result && result.data) {
            console.log('[Media] ✅ Archivo multimedia extraído exitosamente vía DOM / Blob.');
            return result;
        }
    } catch (errCustom) {
        console.error('[Media Custom Extractor Error]:', errCustom.message || errCustom);
    }

    return null;
}

/**
 * Procesa y valida automáticamente comprobantes de pago enviados por imágenes o PDF
 */
async function handleReceiptMedia(msg, client, chatId, senderPhone, isUserAdmin) {
    try {
        console.log(`[Media] Recibido archivo multimedia de ${senderPhone}, extrayendo...`);
        const media = await downloadMediaCustom(client, msg);
        if (!media || !media.data) {
            console.error(`[Media Error] No se pudo descargar el archivo de ${senderPhone}`);
            return false;
        }

        const isImageOrPdf = media.mimetype && (
            media.mimetype.startsWith('image/') || 
            media.mimetype === 'application/pdf'
        );

        if (!isImageOrPdf) {
            console.log(`[Media] Tipo no compatible: ${media.mimetype}`);
            return false;
        }

        // Si Gemini no está configurado, avisar y derivar a admin
        if (!gemini.isGeminiConfigured()) {
            await sendReply(
                client, 
                chatId, 
                `📥 *Comprobante recibido.*\n\nUn administrador revisará la imagen para confirmar tu número a la brevedad.`
            );
            await notifyAdmins(
                client, 
                `📥 *[NUEVO COMPROBANTE RECIBIDO]*\n\n` +
                `📱 *Remitente:* ${senderPhone}\n` +
                `⚠️ _La API de Gemini no está configurada (.env), requiere verificación manual._`
            );
            return true;
        }

        // Mensaje de feedback inmediato
        await sendReply(client, chatId, `⏳ *Analizando tu comprobante de pago con Inteligencia Artificial...*`);

        const analysis = await gemini.analyzeReceipt(media.data, media.mimetype);

        if (!analysis.success || !analysis.data) {
            await sendReply(
                client, 
                chatId, 
                `⚠️ No pudimos procesar automáticamente el comprobante.\n` +
                `No te preocupes, ya dimos aviso a los administradores para que lo verifiquen manualmente.`
            );
            await notifyAdmins(
                client, 
                `⚠️ *[COMPROBANTE NO LEÍDO]*\n\n` +
                `📱 *Remitente:* ${senderPhone}\n` +
                `❌ *Detalle:* ${analysis.error || 'Error al procesar'}\n` +
                `💡 Por favor verificar la imagen enviada por el vecino.`
            );
            return true;
        }

        const data = analysis.data;

        // Si la IA detecta que la imagen NO es un comprobante
        if (!data.es_comprobante) {
            await sendReply(
                client, 
                chatId, 
                `ℹ️ La imagen enviada no parece ser un comprobante de transferencia bancaria.\n\n` +
                `Si realizaste una transferencia, por favor envía una foto o captura clara donde figure el monto y la fecha.`
            );
            return true;
        }

        // 1. Anti-Fraude: Comprobante ya utilizado
        if (data.numero_operacion && db.isReceiptProcessed(data.numero_operacion)) {
            await sendReply(
                client, 
                chatId, 
                `⚠️ *Atención:* Este comprobante (Op. N° *${data.numero_operacion}*) ya fue registrado y procesado anteriormente.\n\n` +
                `Si crees que es un error, por favor comunícate con la comisión.`
            );
            await notifyAdmins(
                client, 
                `🚨 *[ALERTA: COMPROBANTE REUTILIZADO]*\n\n` +
                `📱 *Remitente:* ${senderPhone}\n` +
                `🧾 *N° Operación:* ${data.numero_operacion}\n` +
                `💰 *Monto:* $${(data.monto || 0).toLocaleString('es-AR')}\n` +
                `⚠️ Se intentó ingresar un comprobante que ya figura acreditado.`
            );
            return true;
        }

        // 2. Buscar reservas pendientes del comprador
        const userNums = db.getUserNumbers(senderPhone);
        const pendingNums = userNums.filter(n => n.estado === 'RESERVADO');

        const montoDetectado = Number(data.monto) || 0;
        const deudaTotal = pendingNums.length * config.PRECIO_NUMERO;

        // Validar si el monto cubre la deuda y la auto-aprobación está activa
        if (pendingNums.length > 0 && montoDetectado >= deudaTotal && deudaTotal > 0 && config.AUTO_APROBAR_COMPROBANTES) {
            const vecNombre = pendingNums[0].vecino || 'Vecino';
            const vecCasa = pendingNums[0].casa || '-';
            const numerosConfirmados = [];

            for (const item of pendingNums) {
                const res = db.confirmPayment(item.numero, 'AUTO_GEMINI_AI');
                if (res.success) {
                    numerosConfirmados.push(res.numero);
                }
            }

            const opId = data.numero_operacion || `AI_${Date.now()}`;
            db.registerReceipt(opId, {
                telefono: senderPhone,
                vecino: vecNombre,
                casa: vecCasa,
                monto: montoDetectado,
                numeros: numerosConfirmados,
                banco: data.banco_origen || 'No especificado',
                fechaComprobante: data.fecha_hora || '-',
                emisor: data.emisor_nombre || '-'
            });

            const numerosStr = numerosConfirmados.map(n => `*${n}*`).join(', ');

            // Confirmación directa al comprador
            await sendReply(
                client, 
                chatId, 
                `🎉 *¡PAGO VERIFICADO Y CONFIRMADO!* 🎉\n\n` +
                `Hola *${vecNombre}*, tu comprobante por *$${montoDetectado.toLocaleString('es-AR')}* fue validado con éxito.\n\n` +
                `🎟️ *Tus números confirmados:* ${numerosStr}\n` +
                `🏦 *Origen:* ${data.banco_origen || 'Transferencia'}\n` +
                `🧾 *N° Operación:* \`${opId}\`\n\n` +
                `¡Muchas gracias por apoyar al Barrio Carolina II y mucha suerte en el sorteo! 🍀`
            );

            // Notificación al grupo de administradores
            await notifyAdmins(
                client, 
                `🤖 *[PAGO AUTO-CONFIRMADO POR IA]* 🤖\n\n` +
                `👤 *Titular:* ${vecNombre} (${vecCasa})\n` +
                `📱 *Celular:* ${senderPhone}\n` +
                `🎟️ *Números Pagados:* ${numerosStr}\n` +
                `💰 *Monto:* $${montoDetectado.toLocaleString('es-AR')}\n` +
                `🏦 *Entidad:* ${data.banco_origen || 'Transferencia'}\n` +
                `🧾 *N° Operación:* \`${opId}\`\n` +
                `📅 *Fecha:* ${data.fecha_hora || '-'}`
            );
            return true;
        }

        // Si no se pudo auto-aprobar (monto parcial, sin reservas o auto-aprobación desactivada)
        let motivo = '';
        if (pendingNums.length === 0) {
            motivo = 'No se encontraron números reservados a nombre de este teléfono.';
        } else if (montoDetectado < deudaTotal) {
            motivo = `El monto ($${montoDetectado.toLocaleString('es-AR')}) no cubre el total de tus reservas ($${deudaTotal.toLocaleString('es-AR')}).`;
        } else {
            motivo = 'Derivado para confirmación de los administradores.';
        }

        await sendReply(
            client, 
            chatId, 
            `📋 *Comprobante recibido por $${montoDetectado.toLocaleString('es-AR')}*.\n\n` +
            `ℹ️ *Estado:* En revisión.\n` +
            `Motivo: ${motivo}\n\n` +
            `Los administradores verificarán los datos y confirmarán tu jugada a la brevedad.`
        );

        let detallePendientes = '';
        if (pendingNums.length > 0) {
            detallePendientes = `\n🎟️ *Números pendientes:* ${pendingNums.map(n => n.numero).join(', ')}\n` +
                                `💡 *Para aprobar:* \`!pagado ${pendingNums.map(n => n.numero).join(' ')}\``;
        }

        await notifyAdmins(
            client, 
            `⚠️ *[COMPROBANTE PARA REVISIÓN MANUAL]* ⚠️\n\n` +
            `📱 *Remitente:* ${senderPhone}\n` +
            `💰 *Monto detectado:* $${montoDetectado.toLocaleString('es-AR')}\n` +
            `🏦 *Entidad:* ${data.banco_origen || '-'}\n` +
            `👤 *Emisor:* ${data.emisor_nombre || '-'}\n` +
            `🎯 *Destinatario:* ${data.destinatario_nombre || '-'}\n` +
            `🧾 *N° Operación:* \`${data.numero_operacion || '-'}\`\n` +
            `📅 *Fecha:* ${data.fecha_hora || '-'}\n` +
            `ℹ️ *Resumen IA:* ${data.resumen_lectura || '-'}${detallePendientes}`
        );

        return true;
    } catch (err) {
        console.error('[Error en handleReceiptMedia]:', err);
        return false;
    }
}

async function handleMessage(msg, client) {
    const rawBody = (msg.body || '').trim();
    const hasMedia = Boolean(msg.hasMedia);
    if (!rawBody && !hasMedia) return;

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

    // Si el mensaje incluye archivo multimedia (imagen o PDF de comprobante) en chat privado
    if (hasMedia && !isGroup) {
        const mediaHandled = await handleReceiptMedia(msg, client, senderChatId, senderPhone, isUserAdmin);
        if (mediaHandled) {
            return;
        } else {
            console.log(`[Media] No se pudo interpretar el archivo de ${senderPhone} como comprobante.`);
            await sendReply(client, senderChatId, `📥 Recibimos tu archivo multimedia.\n\nSi es un comprobante de pago, por favor asegúrate de enviar una imagen clara (o documento PDF) donde se lea el importe y la fecha.`);
            return;
        }
    }

    const normalizedBody = rawBody.toUpperCase();

    // =============================================================
    // 1. SI EL MENSAJE ES EN UN GRUPO
    // =============================================================
    if (isGroup) {
        if (rawBody.toLowerCase() === '!idgrupo') {
            await sendReply(client, currentGroupId, `🆔 *ID de este Grupo:* \`${currentGroupId}\``);
            return;
        }

        const isAdminGroup = (config.ADMIN_GRUPO_ID && currentGroupId === config.ADMIN_GRUPO_ID);
        const isPublicGroup = (config.GRUPO_ID && currentGroupId === config.GRUPO_ID);

        // Si hay un grupo de admin configurado y no es el grupo de admin ni el público, ignorar
        if (config.ADMIN_GRUPO_ID && !isAdminGroup && !isPublicGroup) {
            return;
        }

        // Comandos en el grupo de administración (o ejecutados por un administrador)
        if (rawBody.startsWith(config.PREFIX) && (isUserAdmin || isAdminGroup)) {
            const args = rawBody.slice(config.PREFIX.length).trim().split(/\s+/);
            const command = args.shift().toLowerCase();
            
            if (command === 'anuncio') {
                await cmdAnuncio(client, config.GRUPO_ID || currentGroupId, args);
                if (isAdminGroup && config.GRUPO_ID && config.GRUPO_ID !== currentGroupId) {
                    await sendReply(client, currentGroupId, `📢 Anuncio enviado exitosamente al grupo de vecinos.`);
                }
                return;
            }
            if (command === 'invitacion' || command === 'link' || command === 'texto') {
                await cmdInvitacion(client, currentGroupId);
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
            if (command === 'pendientes') {
                await cmdPendientes(client, currentGroupId);
                return;
            }
            if (command === 'resumen' || command === 'balance') {
                await cmdResumen(client, currentGroupId);
                return;
            }
            if (command === 'tablero') {
                await cmdTablero(client, currentGroupId);
                return;
            }
            if (command === 'libres') {
                await cmdLibres(client, currentGroupId);
                return;
            }
            if (command === 'liberar') {
                await cmdLiberar(client, currentGroupId, args);
                return;
            }
            if (command === 'ayuda' || command === 'help' || command === 'comandos') {
                await sendReply(
                    client,
                    currentGroupId,
                    `👑 *COMANDOS DEL GRUPO DE ADMINISTRACIÓN:*\n\n` +
                    `• \`!pagado <numero>\` ➡️ Confirma el pago de un número.\n` +
                    `• \`!liberar <numero>\` ➡️ Libera un número reservado.\n` +
                    `• \`!pendientes\` ➡️ Lista de reservas pendientes de pago.\n` +
                    `• \`!pagados\` ➡️ Lista de números pagados.\n` +
                    `• \`!balance\` ➡️ Balance y recaudación total.\n` +
                    `• \`!tablero\` ➡️ Tablero completo de números.\n` +
                    `• \`!libres\` ➡️ Lista de números disponibles.\n` +
                    `• \`!invitacion\` ➡️ Genera el texto con link directo para enviar a vecinos.\n` +
                    `• \`!anuncio <texto>\` ➡️ Envía un aviso al grupo de vecinos.`
                );
                return;
            }
        }

        // Si alguien escribe SORTEO en cualquier grupo, lo derivamos al privado con link
        if (normalizedBody === 'SORTEO') {
            const botNumber = client.info?.wid?.user;
            const waLink = botNumber ? `\n\n👉 *Haz clic aquí:* https://wa.me/${botNumber}?text=SORTEO` : '';
            
            await sendReply(
                client, 
                currentGroupId,
                `👋 ¡Hola! Para reservar tu número y ver los disponibles, la atención es por *chat privado* 📲.\n\n` +
                `Por favor envíame un mensaje privado con la palabra *SORTEO*.${waLink}`
            );
            return;
        }

        return;
    }

    // =============================================================
    // 2. SI EL MENSAJE ES EN CHAT PRIVADO (O CHAT CON UNO MISMO)
    // =============================================================

    // Apertura directa con ADMIN o !ADMIN
    if (normalizedBody === 'ADMIN' || normalizedBody === '!ADMIN' || normalizedBody === 'MENU ADMIN') {
        if (isUserAdmin) {
            session.step = 'ADMIN_MENU';
            session.tempData = {};
            await sendReply(client, senderChatId, buildAdminMenu());
            return;
        }
    }

    // Salir o cerrar la conversación
    if (normalizedBody === 'X' || normalizedBody === 'SALIR' || normalizedBody === 'FIN' || normalizedBody === 'CHAU' || normalizedBody === 'CERRAR' || normalizedBody === 'CANCELAR') {
        resetSession(senderChatId);
        await sendReply(client, senderChatId, `👋 ¡Gracias por comunicarte! Cuando quieras volver a consultar o reservar un número, solo escribe *SORTEO*. ¡Que tengas un gran día! 🍀`);
        return;
    }

    // Apertura o reinicio del menú con SORTEO o MENU
    if (normalizedBody === 'SORTEO' || normalizedBody === '!SORTEO' || normalizedBody === 'MENU' || normalizedBody === '!MENU') {
        session.step = 'MENU';
        session.tempData = {};
        await sendReply(client, senderChatId, buildMainMenu(isUserAdmin));
        return;
    }

    // Si está dentro de una sesión interactiva activa del menú
    if (session.step !== 'IDLE') {
        const handled = await handleConversationFlow(client, senderChatId, rawBody, session, senderPhone, isUserAdmin);
        if (handled) return;
    }

    // Comandos directos de administrador en privado (con prefijo !)
    if (rawBody.startsWith(config.PREFIX) && isUserAdmin) {
        const args = rawBody.slice(config.PREFIX.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        await handleDirectCommand(client, senderChatId, command, args, senderPhone);
        return;
    }

    // Si no está en una sesión activa y no escribió la palabra clave, ignorar en silencio
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
    text += `📋 *Por favor responde con el número de la opción:*\n\n`;
    text += `1️⃣ 🎟️ *Elegir / Reservar un número*\n`;
    text += `2️⃣ 📋 *Ver números disponibles*\n`;
    text += `3️⃣ 🔍 *Consultar mis números y pagos*\n`;
    text += `4️⃣ 💳 *Datos para transferir (Alias/CBU)*\n`;
    text += `5️⃣ 🏆 *Ver premios y bases completas*\n`;
    
    if (isAdminUser) {
        text += `6️⃣ 👑 *Menú de Administrador*\n`;
    }

    text += `0️⃣ ❌ *Cerrar / Salir*\n\n`;
    text += `💡 *Escribe el número de la opción (o escribe X para salir).*`;
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
    const upperInput = input.toUpperCase();

    // Salir o cerrar la conversación desde cualquier paso
    if (upperInput === 'X' || upperInput === 'SALIR' || upperInput === 'FIN' || upperInput === 'CHAU' || upperInput === 'CERRAR' || upperInput === 'CANCELAR') {
        resetSession(chatId);
        await sendReply(client, chatId, `👋 ¡Conversación finalizada! Cuando quieras volver a consultar o reservar un número, solo escribe *SORTEO*. ¡Que tengas un gran día! 🍀`);
        return true;
    }

    // Cancelar o volver atrás en cualquier paso
    if (input === '0' || upperInput === 'VOLVER') {
        if (session.step === 'MENU') {
            resetSession(chatId);
            await sendReply(client, chatId, `👋 ¡Conversación finalizada! Cuando quieras volver a consultar o reservar un número, solo escribe *SORTEO*. ¡Que tengas un gran día! 🍀`);
            return true;
        }
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

        const paymentLink = await mp.createPaymentLink(result.numero, nombre, config.PRECIO_NUMERO);

        let medioPagoTexto = '';
        if (paymentLink) {
            medioPagoTexto += `💳 *Pagar con Mercado Pago:*\n👉 ${paymentLink}\n\n`;
            medioPagoTexto += `🏦 *O por Transferencia:*\n• *Alias:* \`${config.DATOS_PAGO.alias}\`\n📸 Compartir el comprobante a este mismo número.`;
        } else {
            medioPagoTexto += `🏦 *Transferencia:*\n• *Alias:* \`${config.DATOS_PAGO.alias}\`\n📸 Compartir el comprobante a este mismo número.`;
        }

        const confirmacion = 
            `🎉 *¡RESERVA CONFIRMADA!*\n\n` +
            `• 🎟️ *Número:* *${result.numero}*\n` +
            `• 👤 *Titular:* ${nombre}\n` +
            `• 🏠 *Domicilio:* ${domicilio}\n` +
            `• 💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n` +
            `${medioPagoTexto}\n\n` +
            `👉 _Escribe 1 para reservar otro número o 0 para volver al menú._`;

        await sendReply(client, chatId, confirmacion);
        if (config.DATOS_PAGO.alias) {
            await sendReply(client, chatId, `${config.DATOS_PAGO.alias}`);
        }

        // Notificar al titular por WhatsApp si es un teléfono diferente al que escribió
        const titularWaId = formatWhatsAppId(telefonoFinal);
        if (titularWaId && titularWaId !== chatId) {
            const avisoTitular = 
                `🎉 *¡RESERVA CONFIRMADA - ${config.EVENTO_NOMBRE}!*\n\n` +
                `Hola *${nombre}*, se reservó a tu nombre el número:\n` +
                `• 🎟️ *Número:* *${result.numero}*\n` +
                `• 🏠 *Domicilio:* ${domicilio}\n` +
                `• 💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n\n` +
                `${medioPagoTexto}`;
            await sendReply(client, titularWaId, avisoTitular);
            if (config.DATOS_PAGO.alias) {
                await sendReply(client, titularWaId, `${config.DATOS_PAGO.alias}`);
            }
        }

        // Notificar al Grupo de Administración / Administradores
        const avisoAdmin = 
            `🔔 *Aviso Comisión - Nueva Reserva:*\n\n` +
            `• 🎟️ *Número:* *${result.numero}*\n` +
            `• 👤 *Titular:* ${nombre}\n` +
            `• 🏠 *Domicilio:* ${domicilio}\n` +
            `• 📱 *Teléfono:* ${telefonoFinal}\n` +
            `• 💰 *Monto:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')}\n` +
            `• 📲 *Registrado desde:* ${senderPhone}`;

        if (config.ADMIN_GRUPO_ID) {
            await sendReply(client, config.ADMIN_GRUPO_ID, avisoAdmin);
        } else if (config.ADMIN_PHONES && config.ADMIN_PHONES.length > 0) {
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
        `💳 *DATOS DE PAGO* 💳\n\n` +
        `💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')} por número\n\n` +
        `🏦 *Transferencia por Alias:*\n` +
        `• *Alias:* \`${config.DATOS_PAGO.alias}\`\n` +
        `📸 Compartir el comprobante a este mismo número.`;
    await sendReply(client, chatId, text);
    if (config.DATOS_PAGO.alias) {
        await sendReply(client, chatId, `${config.DATOS_PAGO.alias}`);
    }
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
        await sendReply(client, targetChat, `✅ *¡Pago Confirmado!* Número *${res.numero}* (${res.item.vecino} - ${res.item.casa}) registrado como 🟢 *PAGADO*.`);
        
        // Si se ejecutó desde privado y hay grupo de admin, avisar al grupo de admin
        if (config.ADMIN_GRUPO_ID && targetChat !== config.ADMIN_GRUPO_ID) {
            await sendReply(client, config.ADMIN_GRUPO_ID, `💰 *Pago Confirmado:* Número *${res.numero}* de *${res.item.vecino}* (*${res.item.casa}*) 🟢 PAGADO.`);
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
                    `¡Mucha suerte! 🍀`;
                await sendReply(client, titularWaId, reciboMsg);
            }
        }
    } else {
        await sendReply(client, targetChat, `❌ ${res.message}`);
    }
}

async function cmdInvitacion(client, chatId) {
    const botNumber = client.info?.wid?.user;
    const waLink = botNumber ? `https://wa.me/${botNumber}?text=SORTEO` : '(Envía un mensaje privado con la palabra SORTEO a este número)';
    const premiosTexto = (config.PREMIOS || '').replace(/\\n/g, '\n');
    const modalidadTexto = (config.MODALIDAD_SORTEO || '').replace(/\\n/g, '\n');

    const texto = 
        `🎲 *¡${config.EVENTO_NOMBRE.toUpperCase()}!* 🎲\n\n` +
        `Vecinos/as, ya están habilitados los números para participar del sorteo para la construcción de la Sede Social.\n\n` +
        `🎁 *Premios:*\n${premiosTexto}\n\n` +
        `💰 *Valor:* $${config.PRECIO_NUMERO.toLocaleString('es-AR')} por número\n` +
        `📅 *Fecha de sorteo:* ${config.FECHA_SORTEO}\n` +
        `🎲 *Modalidad:* ${modalidadTexto}\n\n` +
        `👉 *¿Cómo elegir y reservar tu número?*\n` +
        `Para ver los números disponibles y reservar el tuyo en 1 minuto, haz clic en el siguiente enlace y envíale la palabra *SORTEO* a nuestro asistente virtual:\n\n` +
        `📲 *Haz clic aquí para reservar:* ${waLink}\n\n` +
        `_(El Asistente te atenderá por chat privado al instante)_ 🍀`;

    await sendReply(client, chatId, texto);
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
