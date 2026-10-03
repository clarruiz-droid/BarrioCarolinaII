const http = require('http');
const config = require('./config');
const db = require('./db');

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

async function sendWhatsApp(client, targetChat, text) {
    if (!client || !targetChat) return;
    try {
        await client.sendMessage(targetChat, text);
    } catch (e) {
        console.error(`[Webhook WhatsApp Error a ${targetChat}]:`, e.message);
    }
}

/**
 * Consulta los datos de un pago en Mercado Pago
 */
async function fetchPaymentDetails(paymentId) {
    let token = config.MP_ACCESS_TOKEN || '';
    token = token.trim().replace(/^["']|["']$/g, '');
    if (!token) return null;

    try {
        const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            console.error(`[Webhook] Error al consultar pago ${paymentId} en MP (${response.status})`);
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error(`[Webhook] Excepción al consultar pago ${paymentId}:`, error.message);
        return null;
    }
}

/**
 * Procesa el pago aprobado de Mercado Pago y actualiza la base de datos y WhatsApp
 */
async function processApprovedPayment(client, paymentData) {
    const paymentId = paymentData.id;
    const status = paymentData.status;
    const extRef = paymentData.external_reference || '';
    
    // Extraer el número (ej: "NUM_042" -> "042")
    const numClean = extRef.replace(/^NUM_/i, '').trim();
    const num = db.normalizeNumber(numClean);

    console.log(`[Webhook] Procesando pago MP ID: ${paymentId} | Estado: ${status} | Número: ${num || 'Desconocido'}`);

    if (status !== 'approved') {
        console.log(`[Webhook] El pago ${paymentId} no está aprobado (estado actual: ${status}).`);
        return;
    }

    if (!num) {
        console.error(`[Webhook Error] No se pudo determinar el número desde external_reference: "${extRef}"`);
        return;
    }

    const itemActual = db.getNumber(num);
    if (!itemActual) {
        console.error(`[Webhook Error] El número ${num} no existe en la base de datos.`);
        return;
    }

    if (itemActual.estado === 'PAGADO') {
        console.log(`[Webhook] El número ${num} ya figuraba como PAGADO previamente.`);
        return;
    }

    // Confirmar pago en la base de datos
    const res = db.confirmPayment(num, 'Mercado Pago (Automático)');
    if (!res.success) {
        console.error(`[Webhook Error] No se pudo confirmar pago del número ${num}: ${res.message}`);
        return;
    }

    console.log(`✅ [Webhook] ¡Número #${num} acreditado automáticamente como PAGADO!`);

    const titularNombre = res.item.vecino || paymentData.payer?.first_name || 'Vecino';
    const domicilio = res.item.casa || 'Barrio Carolina II';
    const premiosTexto = (config.PREMIOS || '').replace(/\\n/g, '\n');

    // 1. Notificar al titular por WhatsApp
    if (res.item.telefono) {
        const titularWaId = formatWhatsAppId(res.item.telefono);
        if (titularWaId) {
            const reciboMsg = 
                `🎉 *¡PAGO RECIBIDO Y CONFIRMADO!* 🟢\n\n` +
                `Hola *${titularNombre}*, te confirmamos que tu pago de *$${paymentData.transaction_amount || config.PRECIO_NUMERO}* por Mercado Pago fue acreditado con éxito.\n\n` +
                `• 🎟️ *Número:* *${res.numero}*\n` +
                `• 👤 *Titular:* ${titularNombre}\n` +
                `• 🏠 *Domicilio:* ${domicilio}\n` +
                `• 🟢 *Estado:* PAGADO (Mercado Pago)\n` +
                `• 🆔 *ID de Pago:* \`${paymentId}\`\n\n` +
                `🎁 *Premios:*\n${premiosTexto}\n\n` +
                `📅 *Fecha de sorteo:* ${config.FECHA_SORTEO}\n` +
                `¡Muchísimas gracias por participar y mucha suerte! 🍀`;
            await sendWhatsApp(client, titularWaId, reciboMsg);
        }
    }

    // 2. Notificar al grupo de WhatsApp
    if (config.GRUPO_ID) {
        await sendWhatsApp(
            client, 
            config.GRUPO_ID, 
            `🎉 *¡Pago confirmado vía Mercado Pago!* Número *${res.numero}* de *${titularNombre}* (*${domicilio}*) 🟢 PAGADO.`
        );
    }

    // 3. Notificar a los administradores
    if (config.ADMIN_PHONES && config.ADMIN_PHONES.length > 0) {
        const avisoAdmin = 
            `💰 *Aviso Admin - Pago Acreditado (Mercado Pago)* 🟢\n\n` +
            `• 🎟️ *Número:* *${res.numero}*\n` +
            `• 👤 *Titular:* ${titularNombre}\n` +
            `• 🏠 *Domicilio:* ${domicilio}\n` +
            `• 📱 *Teléfono:* ${res.item.telefono || 'N/A'}\n` +
            `• 💵 *Monto:* $${paymentData.transaction_amount || config.PRECIO_NUMERO}\n` +
            `• 🆔 *ID Operación MP:* \`${paymentId}\``;

        for (const admin of config.ADMIN_PHONES) {
            const adminWaId = formatWhatsAppId(admin);
            if (adminWaId) {
                await sendWhatsApp(client, adminWaId, avisoAdmin);
            }
        }
    }
}

/**
 * Inicia el servidor HTTP para escuchar notificaciones de Mercado Pago
 */
function startWebhookServer(client, port = 3000) {
    const server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // Endpoint de salud
        if (req.method === 'GET' && parsedUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', bot: 'online', service: config.EVENTO_NOMBRE }));
            return;
        }

        // Endpoint de Webhook de Mercado Pago
        if (req.method === 'POST' && (parsedUrl.pathname === '/webhook/mercadopago' || parsedUrl.pathname === '/webhook')) {
            let bodyStr = '';
            req.on('data', chunk => {
                bodyStr += chunk;
            });

            req.on('end', async () => {
                // Responder 200 OK inmediatamente a Mercado Pago
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ received: true }));

                try {
                    let body = {};
                    if (bodyStr) {
                        body = JSON.parse(bodyStr);
                    }

                    const topic = body.type || body.topic || parsedUrl.searchParams.get('topic') || parsedUrl.searchParams.get('type');
                    const paymentId = body.data?.id || body.id || parsedUrl.searchParams.get('id') || parsedUrl.searchParams.get('data.id');

                    console.log(`[Webhook] Notificación recibida: Topic=${topic} | ID=${paymentId}`);

                    if ((topic === 'payment' || !topic) && paymentId) {
                        const paymentData = await fetchPaymentDetails(paymentId);
                        if (paymentData) {
                            await processApprovedPayment(client, paymentData);
                        }
                    }
                } catch (err) {
                    console.error('[Webhook Error procesando notificación]:', err.message);
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`🌐 [WEBHOOK] Servidor escuchando en http://0.0.0.0:${port}/webhook/mercadopago`);
    });

    return server;
}

module.exports = {
    startWebhookServer
};
