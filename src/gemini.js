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

    const candidateModels = [
        'gemini-3.8-flash',
        'gemini-3.8-pro',
        'gemini-3-flash',
        'gemini-3-pro',
        'gemini-2.5-flash',
        'gemini-2.0-flash'
    ];

    const prompt = `Analiza este comprobante de transferencia o pago bancario/billetera virtual (ej: Mercado Pago, Cuenta DNI, BNA+, Ualá, Banco Galicia, Santander, BBVA, Macro, Brubank, Naranja X, etc.) y extrae los datos con la máxima fidelidad posible.

Devuelve estrictamente un objeto JSON con la siguiente estructura:
{
  "es_comprobante": true/false (true si es un comprobante de transferencia/pago, false si es una foto o documento cualquiera sin relación),
  "monto": number o null (el monto total transferido en pesos argentinos, ej: 1000, 2000, 3000, 5000; número puro sin signos $ ni puntos de miles),
  "destinatario_cbu_cvu": string o null (CBU, CVU o número de cuenta de destino que figura en el comprobante, sólo números/dígitos si es posible),
  "destinatario_alias": string o null (Alias de la cuenta de destino si figura, ej: "barrio.carolina.pagos"),
  "destinatario_nombre": string o null (nombre o titular de la cuenta receptora si figura),
  "destinatario_identificador": string o null (CBU, CVU, Alias o CUIT/CUIL de la cuenta de destino),
  "emisor_nombre": string o null (nombre y apellido de quien realizó o envió la transferencia),
  "numero_operacion": string o null (código de transferencia, número de operación, ID de transacción, código Coelsa o número de comprobante),
  "fecha_hora": string o null (fecha y hora indicada en el comprobante, ej: "04/10/2026 14:00"),
  "banco_origen": string o null (nombre de la app, banco o billetera desde donde se hizo, ej: "Mercado Pago", "Cuenta DNI", "Banco Nación"),
  "estado_operacion": string o null (ej: "EXITOSA", "REALIZADA", "PENDIENTE", "RECHAZADA"),
  "resumen_lectura": string (breve resumen de 1 línea de lo detectado, ej: "Transferencia de $3000 por Mercado Pago")
}`;

    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: mimeType || 'image/jpeg'
        }
    };

    const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    let lastError = null;

    for (const modelName of candidateModels) {
        try {
            console.log(`[Gemini] Probando análisis con modelo: ${modelName}...`);
            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.1
                }
            });

            let result = null;
            let success = false;
            let attempt = 0;

            while (attempt < 3 && !success) {
                try {
                    result = await model.generateContent([prompt, imagePart]);
                    success = true;
                } catch (apiErr) {
                    if (apiErr.message && (apiErr.message.includes('503') || apiErr.message.includes('high demand'))) {
                        attempt++;
                        console.log(`[Gemini] Reintento ${attempt}/3 por alta demanda en ${modelName}...`);
                        await new Promise(r => setTimeout(r, 1500));
                    } else {
                        throw apiErr;
                    }
                }
            }

            if (!result) throw new Error('No se obtuvo respuesta del modelo');

            const responseText = result.response.text();
            const cleanJson = responseText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

            const parsed = JSON.parse(cleanJson);
            console.log(`[Gemini] ✅ Análisis exitoso con ${modelName}:`, JSON.stringify(parsed));
            return {
                success: true,
                data: parsed
            };
        } catch (err) {
            console.log(`[Gemini] Modelo ${modelName} no disponible:`, err.message || err);
            lastError = err;
        }
    }

    console.error('[Gemini Error] Fallaron todos los modelos candidatos:', lastError?.message || lastError);
    return {
        success: false,
        error: lastError?.message || 'ERROR_ANALYZING',
        details: lastError
    };
}

module.exports = {
    isGeminiConfigured,
    analyzeReceipt
};
