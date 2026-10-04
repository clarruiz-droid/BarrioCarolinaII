const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');

/**
 * Verifica si Gemini está configurado con una API Key
 */
function isGeminiConfigured() {
    return Boolean(config.GEMINI_API_KEY && config.GEMINI_API_KEY.trim() !== '');
}

/**
 * Analiza una imagen o documento de comprobante de pago utilizando Gemini AI
 * @param {string} base64Data - Contenido en base64 de la imagen o archivo
 * @param {string} mimeType - Tipo de medio (image/jpeg, image/png, application/pdf, etc.)
 * @returns {Promise<{success: boolean, data?: Object, error?: string, raw?: string}>}
 */
async function analyzeReceipt(base64Data, mimeType = 'image/jpeg') {
    if (!isGeminiConfigured()) {
        return {
            success: false,
            error: 'API_KEY_MISSING',
            message: 'La variable GEMINI_API_KEY no está configurada en el archivo .env'
        };
    }

    try {
        const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
        // gemini-1.5-flash o gemini-2.0-flash: muy rápido y preciso para extracción de texto en imágenes
        const model = genAI.getGenerativeModel({
            model: 'gemini-1.5-flash',
            generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.1
            }
        });

        const prompt = `Analiza este comprobante de transferencia o pago bancario/billetera virtual (ej: Mercado Pago, Cuenta DNI, BNA+, Ualá, Banco Galicia, Santander, BBVA, Macro, Brubank, Naranja X, etc.) y extrae los datos con la máxima fidelidad posible.

Devuelve estrictamente un objeto JSON con la siguiente estructura:
{
  "es_comprobante": true/false (true si es un comprobante de transferencia/pago, false si es una foto o documento cualquiera sin relación),
  "monto": number o null (el monto total transferido en pesos argentinos, ej: 1000, 2000, 5000; número puro sin signos $ ni puntos de miles),
  "destinatario_nombre": string o null (nombre del titular o cuenta receptora que recibió el dinero),
  "destinatario_identificador": string o null (CBU, CVU, Alias o CUIT/CUIL de la cuenta de destino si aparece),
  "emisor_nombre": string o null (nombre de quien envió el dinero si figura),
  "numero_operacion": string o null (código de transferencia, número de operación, ID de transacción, código Coelsa o número de comprobante),
  "fecha_hora": string o null (fecha y hora indicada en el comprobante, ej: "04/10/2026 14:00"),
  "banco_origen": string o null (nombre de la app, banco o billetera desde donde se hizo, ej: "Mercado Pago", "Cuenta DNI", "Banco Nación"),
  "estado_operacion": string o null (ej: "EXITOSA", "REALIZADA", "PENDIENTE", "RECHAZADA"),
  "resumen_lectura": string (breve resumen de 1 línea de lo detectado, ej: "Transferencia de $2000 a Comisión Vecinal por Mercado Pago")
}`;

        const imagePart = {
            inlineData: {
                data: base64Data,
                mimeType: mimeType
            }
        };

        const result = await model.generateContent([prompt, imagePart]);
        const responseText = result.response.text();
        const cleanJson = responseText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

        const parsed = JSON.parse(cleanJson);
        return {
            success: true,
            data: parsed
        };
    } catch (error) {
        console.error('[Gemini Error] Error al analizar comprobante:', error.message || error);
        return {
            success: false,
            error: error.message || 'ERROR_ANALYZING',
            details: error
        };
    }
}

module.exports = {
    isGeminiConfigured,
    analyzeReceipt
};
