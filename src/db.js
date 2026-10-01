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

        for (let i = config.NUMERO_MIN; i <= config.NUMERO_MAX; i++) {
            const numStr = padNumber(i);
            initialData.numeros[numStr] = {
                estado: 'LIBRE', // 'LIBRE' | 'RESERVADO' | 'PAGADO'
                vecino: null,
                casa: null,
                telefono: null,
                fechaReserva: null,
                fechaPago: null,
                confirmadoPor: null
            };
        }

        saveRawData(initialData);
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
        return JSON.parse(raw);
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
    const parsed = parseInt(numInput, 10);
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
function confirmPayment(numInput, adminPhone) {
    const numStr = normalizeNumber(numInput);
    if (!numStr) {
        return { success: false, error: 'NUMERO_INVALIDO', message: 'Número inválido.' };
    }

    const db = readRawData();
    const item = db.numeros[numStr];

    if (!item || item.estado === 'LIBRE') {
        return { success: false, error: 'NO_RESERVADO', message: `El número *${numStr}* no tiene ninguna reserva activa para confirmar.` };
    }

    if (item.estado === 'PAGADO') {
        return { success: false, error: 'YA_PAGADO', message: `El número *${numStr}* ya estaba registrado como pagado.` };
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
    return libres;
}

/**
 * Obtiene los números asociados a un número de teléfono
 */
function getUserNumbers(telefono) {
    const db = readRawData();
    const userNums = [];
    for (const [num, data] of Object.entries(db.numeros)) {
        if (data.telefono === telefono) {
            userNums.push({ numero: num, ...data });
        }
    }
    return userNums;
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
    return pendientes;
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
