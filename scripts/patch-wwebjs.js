const fs = require('fs');
const path = require('path');

// 1. Parche para Utils.js (Status gating)
const utilsFile = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
if (fs.existsSync(utilsFile)) {
    let content = fs.readFileSync(utilsFile, 'utf-8');
    if (content.includes("canCheckStatusRankingPosterGating()")) {
        content = content.replace(
            /window\s*\.\s*require\('WAWebStatusGatingUtils'\)\s*\.\s*canCheckStatusRankingPosterGating\(\)/g,
            "false"
        );
        fs.writeFileSync(utilsFile, content, 'utf-8');
        console.log('[Patch] ✅ Archivo whatsapp-web.js Utils.js parcheado con éxito.');
    }
}

// 2. Parche para Message.js (evitar excepciones 'r' al descargar media)
const messageFile = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'structures', 'Message.js');
if (fs.existsSync(messageFile)) {
    let content = fs.readFileSync(messageFile, 'utf-8');
    const targetCode = `if (msg.mediaData.mediaStage != 'RESOLVED') {\n                // try to resolve media\n                await msg.downloadMedia({\n                    downloadEvenIfExpensive: true,\n                    rmrReason: 1,\n                });\n            }`;
    const safeCode = `if (msg.mediaData.mediaStage != 'RESOLVED') {\n                try {\n                    await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });\n                } catch (e) {}\n            }`;

    if (content.includes("if (msg.mediaData.mediaStage != 'RESOLVED') {")) {
        content = content.replace(/if\s*\(\s*msg\.mediaData\.mediaStage\s*!=\s*'RESOLVED'\s*\)\s*\{[\s\S]*?await\s+msg\.downloadMedia\([\s\S]*?\);\s*\}/g, safeCode);
        fs.writeFileSync(messageFile, content, 'utf-8');
        console.log('[Patch] ✅ Archivo whatsapp-web.js Message.js parcheado con éxito.');
    }
}
