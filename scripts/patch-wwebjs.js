const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');

if (fs.existsSync(targetFile)) {
    let content = fs.readFileSync(targetFile, 'utf-8');
    
    // Reemplaza la llamada obsoleta de WhatsApp por false seguro
    if (content.includes("canCheckStatusRankingPosterGating()")) {
        content = content.replace(
            /window\s*\.\s*require\('WAWebStatusGatingUtils'\)\s*\.\s*canCheckStatusRankingPosterGating\(\)/g,
            "false"
        );
        fs.writeFileSync(targetFile, content, 'utf-8');
        console.log('[Patch] ✅ Archivo whatsapp-web.js Utils.js parcheado con éxito.');
    } else {
        console.log('[Patch] ℹ️ El archivo ya estaba parcheado o no requiere modificación.');
    }
} else {
    console.log('[Patch] ⚠️ No se encontró whatsapp-web.js para parchear.');
}
