const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const config = require('./config');

/**
 * Prompt estándar para análisis de comprobantes bancarios
 */
const RECEIPT_PROMPT = `Analiza este comprobante de transferencia o pago bancario/billetera virtual (ej: Mercado Pago, Cuenta DNI, BNA+, Ualá, Banco Galicia, Santander, BBVA, Macro, Brubank, Naranja X, etc.) y extrae los datos con la máxima fidelidad posible.

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

/**
 * Verifica si algún proveedor de IA (Groq o Gemini) está configurado
 */
function isAIConfigured() {
    return Boolean(
        (config.GROQ_API_KEY && config.GROQ_API_KEY.trim() !== '') ||
        (config.GEMINI_API_KEY && config.GEMINI_API_KEY.trim() !== '')
    );
}

function isGeminiConfigured() {
    return isAIConfigured();
}

/**
 * Extrae texto digital nativo de un archivo PDF en base64
 */
async function extractTextFromPdf(base64Data) {
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        const data = await pdfParse(buffer);
        return data && data.text ? data.text.trim() : '';
    } catch (err) {
        console.error('[PDF] Error al extraer texto del documento:', err.message);
        return '';
    }
}

// --------------------------------------------------------------------------
// PROVEEDOR 1: GROQ (Llama 3.3 70B para texto / Qwen 2.5 27B para visión)
// --------------------------------------------------------------------------

/**
 * Analiza el texto digital extraído de un comprobante PDF utilizando Groq Llama 3.3 70B
 */
async function analyzeReceiptTextGroq(extractedText) {
    if (!config.GROQ_API_KEY || !extractedText || extractedText.length < 10) return null;

    const groqTextModels = [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant'
    ];

    const promptText = `${RECEIPT_PROMPT}\n\nA continuación se presenta el texto completo extraído digitalmente del comprobante:\n\n"""\n${extractedText}\n"""`;

    for (const modelName of groqTextModels) {
        try {
            console.log(`[Groq] Analizando texto digital de PDF con modelo ${modelName}...`);
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: [
                        {
                            role: 'user',
                            content: promptText
                        }
                    ],
                    max_tokens: 500,
                    temperature: 0.1,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                console.log(`[Groq Error en ${modelName}]: HTTP ${response.status} - ${errText}`);
                continue;
            }

            const resData = await response.json();
            const rawContent = resData.choices?.[0]?.message?.content;
            if (!rawContent) continue;

            const cleanJson = rawContent
                .replace(/^```json\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();

            const parsed = JSON.parse(cleanJson);
            console.log(`[Groq] ✅ Análisis exitoso de PDF con ${modelName}:`, JSON.stringify(parsed));
            return {
                success: true,
                data: parsed,
                provider: 'groq'
            };
        } catch (err) {
            console.error(`[Groq Error en ${modelName}]:`, err.message || err);
        }
    }

    return null;
}

/**
 * Analiza una imagen de comprobante (JPG/PNG) utilizando el modelo multimodal de Groq
 */
async function analyzeReceiptGroq(base64Data, mimeType = 'image/jpeg') {
    if (!config.GROQ_API_KEY) return null;

    if (mimeType && mimeType.includes('pdf')) {
        return null;
    }

    const groqModels = [
        'qwen/qwen3.8-27b'
    ];

    const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64Data}`;

    for (const modelName of groqModels) {
        try {
            console.log(`[Groq] Analizando comprobante con modelo ${modelName}...`);
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: RECEIPT_PROMPT },
                                { type: 'image_url', image_url: { url: dataUrl } }
                            ]
                        }
                    ],
                    max_tokens: 500,
                    temperature: 0.1,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                console.log(`[Groq Error en ${modelName}]: HTTP ${response.status} - ${errText}`);
                continue;
            }

            const resData = await response.json();
            const rawContent = resData.choices?.[0]?.message?.content;
            if (!rawContent) continue;

            const cleanJson = rawContent
                .replace(/^```json\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();

            const parsed = JSON.parse(cleanJson);
            console.log(`[Groq] ✅ Análisis exitoso con ${modelName}:`, JSON.stringify(parsed));
            return {
                success: true,
                data: parsed,
                provider: 'groq'
            };
        } catch (err) {
            console.error(`[Groq Error en ${modelName}]:`, err.message || err);
        }
    }

    return null;
}

// --------------------------------------------------------------------------
// PROVEEDOR 2: GOOGLE GEMINI
// --------------------------------------------------------------------------
let cachedGeminiModels = null;
let lastModelCheck = 0;

async function getSupportedGeminiModels(apiKey) {
    const now = Date.now();
    if (cachedGeminiModels && cachedGeminiModels.length > 0 && (now - lastModelCheck < 1800000)) {
        return cachedGeminiModels;
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

                const preferredModels = [
                    'gemini-3.5-flash',
                    'gemini-2.5-flash',
                    'gemini-flash-latest',
                    'gemini-3.7-flash',
                    'gemini-3.8-flash'
                ];

                const matched = preferredModels.filter(m => available.includes(m));
                if (matched.length > 0) {
                    console.log(`[Gemini] ✅ Modelos disponibles: ${matched.join(', ')}`);
                    cachedGeminiModels = matched;
                    lastModelCheck = now;
                    return cachedGeminiModels;
                }
            }
        }
    } catch (e) {
        console.error('[Gemini] Error consultando ListModels:', e.message);
    }

    return ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
}

async function analyzeReceiptGemini(base64Data, mimeType = 'image/jpeg') {
    if (!config.GEMINI_API_KEY) return null;

    const candidateModels = await getSupportedGeminiModels(config.GEMINI_API_KEY);
    const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

    const imagePart = {
        inlineData: {
            data: base64Data,
            mimeType: mimeType || 'image/jpeg'
        }
    };

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
            const maxAttempts = 3;

            while (attempt < maxAttempts && !success) {
                try {
                    result = await model.generateContent([RECEIPT_PROMPT, imagePart]);
                    success = true;
                } catch (apiErr) {
                    const errStr = (apiErr.message || String(apiErr)).toLowerCase();

                    if (errStr.includes('429') || errStr.includes('quota') || errStr.includes('resource_exhausted')) {
                        console.log(`[Gemini] Cuota alcanzada en ${modelName}, cambiando al siguiente modelo...`);
                        throw apiErr;
                    }

                    const isTransient = errStr.includes('503') || 
                                      errStr.includes('high demand') || 
                                      errStr.includes('overloaded') || 
                                      errStr.includes('fetch failed') ||
                                      errStr.includes('econnreset');

                    if (isTransient && attempt < maxAttempts - 1) {
                        attempt++;
                        const delayMs = 1500 * attempt;
                        console.log(`[Gemini] Reintento ${attempt}/${maxAttempts} en ${delayMs}ms en ${modelName}...`);
                        await new Promise(r => setTimeout(r, delayMs));
                    } else {
                        throw apiErr;
                    }
                }
            }

            if (!result) throw new Error('No se obtuvo respuesta del modelo');

            const responseText = result.response.text();
            const cleanJson = responseText
                .replace(/^```json\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();

            const parsed = JSON.parse(cleanJson);
            console.log(`[Gemini] ✅ Análisis exitoso con ${modelName}:`, JSON.stringify(parsed));
            return {
                success: true,
                data: parsed,
                provider: 'gemini'
            };
        } catch (err) {
            console.error(`[Gemini Error en ${modelName}]:`, err.message || err);
            lastError = err;
        }
    }

    return null;
}

// --------------------------------------------------------------------------
// CONTROLADOR PRINCIPAL CON CONMUTACIÓN AUTOMÁTICA (FALLBACK)
// --------------------------------------------------------------------------
/**
 * Analiza un comprobante de pago intentando primero Groq (gratis y rápido)
 * y conmutando automáticamente a Gemini (o viceversa según disponibilidad).
 */
async function analyzeReceipt(base64Data, mimeType = 'image/jpeg') {
    if (!isAIConfigured()) {
        return {
            success: false,
            error: 'AI_NOT_CONFIGURED',
            message: 'No hay ninguna clave de IA configurada (GROQ_API_KEY o GEMINI_API_KEY en .env)'
        };
    }

    const isPdf = Boolean(mimeType && mimeType.toLowerCase().includes('pdf'));

    // 1. Si es un documento PDF:
    if (isPdf) {
        // Opción primaria: Extraer texto digital y analizar con Groq Llama 3.3 70B (gratis y ultra veloz)
        if (config.GROQ_API_KEY) {
            console.log('[AI] 📄 Documento PDF detectado. Extrayendo texto digital para análisis en Groq...');
            const extractedText = await extractTextFromPdf(base64Data);
            if (extractedText && extractedText.length >= 15) {
                const groqTextResult = await analyzeReceiptTextGroq(extractedText);
                if (groqTextResult && groqTextResult.success) {
                    return groqTextResult;
                }
            } else {
                console.log('[AI] El PDF no contiene suficiente texto digital directo.');
            }
        }

        // Respaldo secundario: Gemini multimodal si está configurado
        if (config.GEMINI_API_KEY) {
            console.log('[AI] 📄 Procesando PDF de forma nativa con Gemini como respaldo...');
            const geminiResult = await analyzeReceiptGemini(base64Data, 'application/pdf');
            if (geminiResult && geminiResult.success) {
                return geminiResult;
            }
        } else if (!config.GROQ_API_KEY) {
            console.warn('[AI] ⚠️ Se recibió un PDF pero no hay ningún proveedor de IA configurado.');
        }
    } else {
        // 2. Si es una imagen (JPG/PNG), usar Groq como opción primaria (alta velocidad)
        if (config.GROQ_API_KEY) {
            const groqResult = await analyzeReceiptGroq(base64Data, mimeType);
            if (groqResult && groqResult.success) {
                return groqResult;
            }
            if (config.GEMINI_API_KEY) {
                console.log('[AI] Groq no pudo procesar la imagen, cambiando automáticamente a Gemini...');
            }
        }

        // 3. Respaldo en Gemini para imágenes
        if (config.GEMINI_API_KEY) {
            const geminiResult = await analyzeReceiptGemini(base64Data, mimeType);
            if (geminiResult && geminiResult.success) {
                return geminiResult;
            }
        }
    }

    return {
        success: false,
        error: 'ALL_PROVIDERS_FAILED',
        message: 'No se pudo procesar automáticamente el comprobante con los proveedores de IA disponibles.'
    };
}

module.exports = {
    isAIConfigured,
    isGeminiConfigured,
    analyzeReceipt
};
