const config = require('./config');

/**
 * Crea una preferencia de pago en Mercado Pago y retorna el link directo (init_point)
 * @param {string} numero - Número reservado (ej: "042")
 * @param {string} titular - Nombre del titular
 * @param {number} monto - Monto a cobrar
 * @returns {Promise<string|null>} - URL del link de pago o null si no está configurado / error
 */
async function createPaymentLink(numero, titular = '', monto = null) {
    const token = config.MP_ACCESS_TOKEN;
    if (!token || token.trim() === '') {
        return null;
    }

    const valor = monto || config.PRECIO_NUMERO;

    const payload = {
        items: [
            {
                title: `${config.EVENTO_NOMBRE} - Número #${numero}`,
                description: `Reserva del número #${numero} para ${titular || 'Vecino'}`,
                quantity: 1,
                unit_price: Number(valor),
                currency_id: 'ARS'
            }
        ],
        payer: {
            name: titular || 'Vecino'
        },
        external_reference: `NUMERO_${numero}`,
        statement_descriptor: "QUINIELA VECINAL",
        back_urls: {
            success: "https://www.mercadopago.com.ar",
            failure: "https://www.mercadopago.com.ar",
            pending: "https://www.mercadopago.com.ar"
        },
        auto_return: "approved"
    };

    try {
        const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token.trim()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[MercadoPago Error ${response.status}]:`, errText);
            return null;
        }

        const data = await response.json();
        return data.init_point || data.sandbox_init_point || null;
    } catch (error) {
        console.error('[MercadoPago Exception]:', error.message);
        return null;
    }
}

module.exports = {
    createPaymentLink
};
