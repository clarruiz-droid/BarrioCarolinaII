const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const db = require('./db');
const commands = require('./commands');
const scheduler = require('./scheduler');

console.log('====================================================');
console.log(`🤖 Iniciando Bot: ${config.EVENTO_NOMBRE}`);
console.log('====================================================');

// Inicializar la base de datos local
db.initDatabase();

const puppeteerExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'linux' ? '/usr/bin/chromium-browser' : undefined);

// Configuración del cliente de WhatsApp con persistencia de sesión
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '.wwebjs_auth'
    }),
    puppeteer: {
        headless: true,
        executablePath: puppeteerExecutablePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// Evento: Generación de código QR
client.on('qr', (qr) => {
    console.log('\n📲 [QR RECIBIDO] Escanea el siguiente código QR con WhatsApp para vincular el bot:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n💡 Instrucciones: Abre WhatsApp en tu celular > Dispositivos vinculados > Vincular dispositivo.\n');
});

// Evento: Autenticado
client.on('authenticated', () => {
    console.log('🔐 [AUTH] Sesión autenticada correctamente.');
});

// Evento: Fallo de autenticación
client.on('auth_failure', (msg) => {
    console.error('❌ [AUTH ERROR] Falló la autenticación:', msg);
});

// Evento: Bot listo para operar
client.on('ready', () => {
    console.log('\n✅ [BOT LISTO] El bot está conectado y escuchando mensajes.');
    console.log(`📌 Prefijo configurado: "${config.PREFIX}"`);
    console.log(`📌 Administradores registrados: ${config.ADMIN_PHONES.length > 0 ? config.ADMIN_PHONES.join(', ') : 'Todos (modo sin restricción)'}`);
    console.log('----------------------------------------------------\n');

    // Inicializar el programador de recordatorios automáticos
    scheduler.initScheduler(client);
});

// Evento: Mensajes recibidos (tanto privados como en grupos)
client.on('message_create', async (msg) => {
    if (msg.body) {
        await commands.handleMessage(msg, client);
    }
});

// Evento: Desconexión
client.on('disconnected', (reason) => {
    console.log('⚠️ [DESCONECTADO] El bot fue desconectado:', reason);
});

// Manejo de cierre seguro del proceso
process.on('SIGINT', async () => {
    console.log('\n🛑 Cerrando cliente de WhatsApp...');
    await client.destroy();
    console.log('👋 Bot detenido.');
    process.exit(0);
});

// Iniciar cliente
client.initialize();
