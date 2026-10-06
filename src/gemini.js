const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');

/**
 * Verifica si Gemini está configurado con una API Key
 */
function isGeminiConfigured() {
    return Boolean(config.GEMINI_API_KEY && config.GEMINI_API_KEY.trim() !== '');
}

let cachedModels = null;
let lastModelCheck = 0;

/**
 * Consulta dinámicamente la lista de modelos válidos que soportan 'generateContent'
 * para la API Key actual, evitando nombres erróneos o modelos inexistentes (404)
 */
async function getSupportedModels(apiKey) {
    const now = Date.now();
    if (cachedModels && cachedModels.length > 0 && (now - lastModelCheck < 1800000)) {
        return cachedModels;
    }

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const resp = await fetch(url);
        if (resp.ok) {
            const data = await resp.json();
            if (data && Array.isArray(data.models)) {
                const available = data.models
                    .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                    .map(m => m.name.replace(/^models\//, ''));

                // Modelos prioritarios estables con alta cuota gratuita (hasta 1.500 req/día)
                const preferredModels = [
                    'gemini-1.5-flash',
                    'gemini-2.0-flash',
                    'gemini-1.5-flash-8b',
                    'gemini-flash-latest',
                    'gemini-2.5-flash'
                ];

                // Filtrar solo los modelos prioritarios que estén activos en la cuenta
                const matched = preferredModels.filter(m => available.includes(m));

                if (matched.length > 0) {
                    console.log(`[Gemini] ✅ Modelos activos seleccionados para tu cuenta: ${matched.join(', ')}`);
                    cachedModels = matched;
                    lastModelCheck = now;
                    return cachedModels;
                }
            }
        } else {
            console.log(`[Gemini] ListModels respondió con HTTP ${resp.status}`);
        }
    } catch (e) {
        console.error('[Gemini] No se pudo consultar ListModels:', e.message);
    }

    // Modelos seguros por defecto con alta cuota gratuita (gemini-1.5-flash primero)
    return ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-8b', 'gemini-flash-latest'];
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

    const candidateModels = await getSupportedModels(config.GEMINI_API_KEY);

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
            const maxAttempts = 5;

            while (attempt < maxAttempts && !success) {
                try {
                    result = await model.generateContent([prompt, imagePart]);
                    success = true;
                } catch (apiErr) {
                    const errStr = (apiErr.message || String(apiErr)).toLowerCase();

                    // Si se agotó la cuota diaria o por minuto (429 / quota exceeded), no esperar en vano, pasar al siguiente modelo
                    if (errStr.includes('429') || errStr.includes('quota') || errStr.includes('resource_exhausted')) {
                        console.log(`[Gemini] Cuota alcanzada en ${modelName}, cambiando inmediatamente al siguiente modelo...`);
                        throw apiErr;
                    }

                    const isTransient = errStr.includes('503') || 
                                      errStr.includes('high demand') || 
                                      errStr.includes('overloaded') || 
                                      errStr.includes('fetch failed') ||
                                      errStr.includes('econnreset');

                    if (isTransient && attempt < maxAttempts - 1) {
                        attempt++;
                        const delayMs = 1500 * attempt + Math.floor(Math.random() * 500);
                        console.log(`[Gemini] Reintento ${attempt}/${maxAttempts} en ${delayMs}ms por alta demanda en ${modelName}...`);
                        await new Promise(r => setTimeout(r, delayMs));
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
            console.error(`[Gemini Error en ${modelName}]:`, err.message || err);
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
