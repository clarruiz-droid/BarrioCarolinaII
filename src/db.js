const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'quiniela.json');

// Asegura que el directorio data exista
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Formatea un número al largo definido (ej. 7 -> "07")
 */
function padNumber(num) {
    return String(num).padStart(config.DIGITOS_PAD, '0');
}

/**
 * Sincroniza, limpia claves duplicadas de 2/3 cifras y asegura el orden numérico exacto
 */
function syncAndCleanDatabase(data) {
    let modified = false;
    if (!data.numeros) data.numeros = {};

    const cleanNumeros = {};

    // 1. Inicializar todas las casillas oficiales del rango en orden estricto
    for (let i = config.NUMERO_MIN; i <= config.NUMERO_MAX; i++) {
        const standardKey = padNumber(i);
        cleanNumeros[standardKey] = {
            estado: 'LIBRE',
            vecino: null,
            casa: null,
            telefono: null,
            fechaReserva: null,
            fechaPago: null,
            confirmadoPor: null
        };
    }

    // 2. Migrar datos existentes (evitando duplicados de 2 y 3 cifras)
    for (const [rawKey, rawData] of Object.entries(data.numeros)) {
        const parsed = parseInt(String(rawKey).replace(/\D/g, ''), 10);
        if (isNaN(parsed) || parsed < config.NUMERO_MIN || parsed > config.NUMERO_MAX) {
            modified = true;
            continue; // Descartar si está fuera de rango
        }

        const standardKey = padNumber(parsed);

        if (rawKey !== standardKey) {
            modified = true;
        }

        // Si tenía información (reservado o pagado), preservarla en la clave estándar
        if (rawData.estado === 'PAGADO') {
            cleanNumeros[standardKey] = { ...cleanNumeros[standardKey], ...rawData };
        } else if (rawData.estado === 'RESERVADO' && cleanNumeros[standardKey].estado !== 'PAGADO') {
            cleanNumeros[standardKey] = { ...cleanNumeros[standardKey], ...rawData };
        }
    }

    const oldKeys = Object.keys(data.numeros);
    const newKeys = Object.keys(cleanNumeros);
    if (oldKeys.length !== newKeys.length || oldKeys.some((k, idx) => k !== newKeys[idx])) {
        modified = true;
    }

    data.numeros = cleanNumeros;
    data.precioPorNumero = config.PRECIO_NUMERO;
    data.evento = config.EVENTO_NOMBRE;

    if (modified) {
        saveRawData(data);
    }

    return data;
}

/**
 * Inicializa la base de datos si no existe
 */
function initDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = {
            creadoEl: new Date().toISOString(),
            evento: config.EVENTO_NOMBRE,
            precioPorNumero: config.PRECIO_NUMERO,
            numeros: {}
        };
        saveRawData(syncAndCleanDatabase(initialData));
        console.log(`[DB] Base de datos creada con números del ${padNumber(config.NUMERO_MIN)} al ${padNumber(config.NUMERO_MAX)}`);
    }
}

/**
 * Lee la base de datos completa desde el archivo JSON
 */
function readRawData() {
    initDatabase();
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return syncAndCleanDatabase(parsed);
    } catch (error) {
        console.error('[DB Error] No se pudo leer el archivo JSON:', error);
        throw error;
    }
}

/**
 * Guarda los datos en el archivo JSON
 */
function saveRawData(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error('[DB Error] No se pudo escribir en el archivo JSON:', error);
        throw error;
    }
}

/**
 * Normaliza y valida si un número es válido dentro del rango
 */
function normalizeNumber(numInput) {
    if (numInput === null || numInput === undefined) return null;
    const clean = String(numInput).replace(/\D/g, '');
    if (!clean && String(numInput).trim() !== '0') return null;
    const parsed = parseInt(clean, 10);
    if (isNaN(parsed)) return null;
    if (parsed < config.NUMERO_MIN || parsed > config.NUMERO_MAX) return null;
    return padNumber(parsed);
}

/**
 * Obtiene el detalle de un número
 */
function getNumber(numInput) {
    const numStr = normalizeNumber(numInput);
    if (!numStr) return null;
    const db = readRawData();
    return db.numeros[numStr] || null;
}

/**
 * Reserva un número para un vecino
 */
function reserveNumber(numInput, vecino, casa, telefono) {
    const numStr = normalizeNumber(numInput);
    if (!numStr) {
        return { success: false, error: 'NUMERO_INVALIDO', message: `Número inválido. Debe ser entre ${padNumber(config.NUMERO_MIN)} y ${padNumber(config.NUMERO_MAX)}.` };
    }

    const db = readRawData();
    const item = db.numeros[numStr];

    if (!item) {
        return { success: false, error: 'NO_EXISTE', message: 'El número no existe.' };
    }

    if (item.estado === 'PAGADO') {
        return { 
            success: false, 
            error: 'YA_PAGADO', 
            message: `El número *${numStr}* ya fue comprado y pagado por *${item.vecino} (${item.casa})*.` 
        };
    }

    if (item.estado === 'RESERVADO') {
        return { 
            success: false, 
            error: 'YA_RESERVADO', 
            message: `El número *${numStr}* ya está reservado por *${item.vecino} (${item.casa})*.` 
        };
    }

    // Reservar el número
    item.estado = 'RESERVADO';
    item.vecino = vecino.trim();
    item.casa = casa.trim();
    item.telefono = telefono;
    item.fechaReserva = new Date().toISOString();

    saveRawData(db);

    return { 
        success: true, 
        numero: numStr,
        item
    };
}

/**
 * Confirma el pago de un número
 */
function confirmPayment(numInput, adminPhone, vecinoDirecto = null, casaDirecta = null, telefonoDirecto = null) {
    const numStr = normalizeNumber(numInput);
    if (!numStr) {
        return { success: false, error: 'NUMERO_INVALIDO', message: `Número inválido. Debe ser entre ${padNumber(config.NUMERO_MIN)} y ${padNumber(config.NUMERO_MAX)}.` };
    }

    const db = readRawData();
    const item = db.numeros[numStr];

    if (!item) {
        return { success: false, error: 'NO_EXISTE', message: 'El número no existe.' };
    }

    if (item.estado === 'PAGADO') {
        return { success: false, error: 'YA_PAGADO', message: `El número *${numStr}* ya estaba registrado como pagado por *${item.vecino}* (${item.casa}).` };
    }

    if (item.estado === 'LIBRE') {
        if (!vecinoDirecto) {
            return { 
                success: false, 
                error: 'ES_LIBRE', 
                needsData: true,
                numero: numStr,
                message: `El número *${numStr}* está actualmente LIBRE.` 
            };
        }
        item.vecino = vecinoDirecto.trim();
        item.casa = (casaDirecta || 'No especificado').trim();
        item.telefono = telefonoDirecto ? String(telefonoDirecto).trim() : null;
        item.fechaReserva = new Date().toISOString();
    }

    item.estado = 'PAGADO';
    item.fechaPago = new Date().toISOString();
    item.confirmadoPor = adminPhone;

    saveRawData(db);

    return {
        success: true,
        numero: numStr,
        item
    };
}

/**
 * Libera un número reservado o pagado
 */
function releaseNumber(numInput) {
    const numStr = normalizeNumber(numInput);
    if (!numStr) {
        return { success: false, error: 'NUMERO_INVALIDO', message: 'Número inválido.' };
    }

    const db = readRawData();
    const item = db.numeros[numStr];

    if (!item || item.estado === 'LIBRE') {
        return { success: false, error: 'YA_LIBRE', message: `El número *${numStr}* ya está libre.` };
    }

    const anteriorVecino = item.vecino;
    const anteriorCasa = item.casa;

    item.estado = 'LIBRE';
    item.vecino = null;
    item.casa = null;
    item.telefono = null;
    item.fechaReserva = null;
    item.fechaPago = null;
    item.confirmadoPor = null;

    saveRawData(db);

    return {
        success: true,
        numero: numStr,
        anterior: { vecino: anteriorVecino, casa: anteriorCasa }
    };
}

/**
 * Obtiene la lista de números libres
 */
function getAvailableNumbers() {
    const db = readRawData();
    const libres = [];
    for (const [num, data] of Object.entries(db.numeros)) {
        if (data.estado === 'LIBRE') {
            libres.push(num);
        }
    }
    return libres.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/**
 * Obtiene los números asociados a un número de teléfono
 */
function getUserNumbers(telefono) {
    const db = readRawData();
    const userNums = [];
    const cleanTarget = String(telefono || '').replace(/\D/g, '');
    for (const [num, data] of Object.entries(db.numeros)) {
        const cleanTel = String(data.telefono || '').replace(/\D/g, '');
        if (cleanTel && (cleanTel === cleanTarget || cleanTel.endsWith(cleanTarget) || cleanTarget.endsWith(cleanTel))) {
            userNums.push({ numero: num, ...data });
        }
    }
    return userNums.sort((a, b) => parseInt(a.numero, 10) - parseInt(b.numero, 10));
}

/**
 * Obtiene todos los números en estado RESERVADO (pendientes de pago)
 */
function getPendingPayments() {
    const db = readRawData();
    const pendientes = [];
    for (const [num, data] of Object.entries(db.numeros)) {
        if (data.estado === 'RESERVADO') {
            pendientes.push({ numero: num, ...data });
        }
    }
    return pendientes.sort((a, b) => parseInt(a.numero, 10) - parseInt(b.numero, 10));
}

/**
 * Obtiene resumen y balance general
 */
function getSummary() {
    const db = readRawData();
    let total = 0;
    let libres = 0;
    let reservados = 0;
    let pagados = 0;

    for (const data of Object.values(db.numeros)) {
        total++;
        if (data.estado === 'LIBRE') libres++;
        else if (data.estado === 'RESERVADO') reservados++;
        else if (data.estado === 'PAGADO') pagados++;
    }

    const recaudado = pagados * config.PRECIO_NUMERO;
    const potencial = (pagados + reservados) * config.PRECIO_NUMERO;

    return {
        total,
        libres,
        reservados,
        pagados,
        precioPorNumero: config.PRECIO_NUMERO,
        recaudado,
        potencial
    };
}

module.exports = {
    initDatabase,
    readRawData,
    normalizeNumber,
    getNumber,
    reserveNumber,
    confirmPayment,
    releaseNumber,
    getAvailableNumbers,
    getUserNumbers,
    getPendingPayments,
    getSummary
};
