const config = require('./config');

/**
 * Crea una preferencia de pago en Mercado Pago y retorna el link directo (init_point)
 * @param {string} numero - Número reservado (ej: "042")
 * @param {string} titular - Nombre del titular
 * @param {number} monto - Monto a cobrar
 * @returns {Promise<string|null>} - URL del link de pago o null si no está configurado / error
 */
async function createPaymentLink(numero, titular = '', monto = null) {
    let token = config.MP_ACCESS_TOKEN || '';
    token = token.trim().replace(/^["']|["']$/g, '');

    if (!token) {
        console.log('[MercadoPago] No hay MP_ACCESS_TOKEN configurado en .env.');
        return null;
    }

    const valor = Number(monto || config.PRECIO_NUMERO);
    const nombreTitular = (titular || 'Vecino').trim().substring(0, 30);

    const payload = {
        items: [
            {
                title: `${config.EVENTO_NOMBRE} - N° ${numero}`,
                description: `Reserva número #${numero}`,
                quantity: 1,
                unit_price: valor,
                currency_id: 'ARS'
            }
        ],
        payer: {
            name: nombreTitular
        },
        external_reference: `NUM_${numero}`
    };

    if (config.WEBHOOK_URL && config.WEBHOOK_URL.trim() !== '') {
        payload.notification_url = config.WEBHOOK_URL.trim();
    }

    try {
        console.log(`[MercadoPago] Creando link de pago para número #${numero} ($${valor})...`);
        const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            console.error(`[MercadoPago Error ${response.status}]:`, JSON.stringify(data));
            return null;
        }

        const link = data.init_point || data.sandbox_init_point || null;
        console.log(`[MercadoPago] Link generado con éxito: ${link}`);
        return link;
    } catch (error) {
        console.error('[MercadoPago Exception]:', error.message);
        return null;
    }
}

module.exports = {
    createPaymentLink
};
