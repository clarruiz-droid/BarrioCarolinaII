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

// 2. Parche completo para Message.js downloadMedia
const messageFile = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'structures', 'Message.js');
if (fs.existsSync(messageFile)) {
    let content = fs.readFileSync(messageFile, 'utf-8');

    const patchedDownloadMedia = `    async downloadMedia() {
        if (!this.hasMedia) {
            return undefined;
        }

        const result = await this.client.pupPage.evaluate(async (msgId) => {
            const findMsg = async (idStr) => {
                try {
                    const coll = window.require('WAWebCollections').Msg;
                    if (!coll) return null;
                    let found = coll.get(idStr);
                    if (found) return found;
                    const models = coll.models || coll._models || [];
                    found = models.find(m => m.id?._serialized === idStr || (m.id?.id && idStr.includes(m.id.id)));
                    if (found) return found;
                    try {
                        const fetched = await coll.getMessagesById([idStr]);
                        found = fetched?.messages?.[0] || fetched?.[0];
                        if (found) return found;
                    } catch (e) {}
                    const mediaList = models.filter(m => m.isMedia || m.mediaData || m.type === 'image' || m.type === 'document');
                    return mediaList[mediaList.length - 1] || null;
                } catch (e) {
                    return null;
                }
            };

            const msg = await findMsg(msgId);

            if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') {
                return null;
            }

            if (msg.mediaData.mediaStage !== 'RESOLVED') {
                try {
                    await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
                } catch (e) {}
            }

            let waitCount = 0;
            while ((msg.mediaData.mediaStage === 'FETCHING' || msg.mediaData.mediaStage === 'INIT') && waitCount < 20) {
                await new Promise(r => setTimeout(r, 300));
                waitCount++;
            }

            const directPath = msg.directPath || msg.mediaData?.directPath;
            const encFilehash = msg.encFilehash || msg.mediaData?.encFilehash;
            const filehash = msg.filehash || msg.mediaData?.filehash;
            const mediaKey = msg.mediaKey || msg.mediaData?.mediaKey;
            const mediaKeyTimestamp = msg.mediaKeyTimestamp || msg.mediaData?.mediaKeyTimestamp;
            const mediaType = msg.type || msg.mediaData?.type || 'image';

            const mime = msg.mimetype || msg.mediaData?.mimetype || 'image/jpeg';

            try {
                const mockQpl = new Proxy({}, { get: () => () => mockQpl });
                const decryptedMedia = await window
                    .require('WAWebDownloadManager')
                    .downloadManager.downloadAndMaybeDecrypt({
                        directPath: directPath,
                        encFilehash: encFilehash,
                        filehash: filehash,
                        mediaKey: mediaKey,
                        mediaKeyTimestamp: mediaKeyTimestamp,
                        type: mediaType,
                        mimetype: mime,
                        signal: new AbortController().signal,
                        downloadQpl: mockQpl,
                    });

                const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
                if (data && data.length > 500) {
                    return {
                        data,
                        mimetype: msg.mimetype || msg.mediaData?.mimetype || 'image/jpeg',
                        filename: msg.filename || msg.mediaData?.filename || 'comprobante.jpg',
                        filesize: msg.size || data.length,
                    };
                }
            } catch (e) {
                // Fallback 1: Si existe mediaBlob OpaqueData
                try {
                    const blob = msg.mediaData.mediaBlob || msg.mediaData._blob;
                    if (blob) {
                        const buffer = typeof blob.arrayBuffer === 'function' ? await blob.arrayBuffer() : null;
                        if (buffer) {
                            const data = await window.WWebJS.arrayBufferToBase64Async(buffer);
                            return {
                                data,
                                mimetype: msg.mimetype || 'image/jpeg',
                                filename: msg.filename || 'comprobante.jpg',
                                filesize: msg.size || 0,
                            };
                        }
                    }
                } catch (eBlob) {}

                // Fallback 2: Thumbnail / Preview base64
                try {
                    if (msg.mediaData && msg.mediaData.preview) {
                        let b64 = msg.mediaData.preview._b64 || msg.mediaData.preview;
                        if (typeof b64 === 'string') {
                            b64 = b64.replace(/^data:image\\/[a-z]+;base64,/, '');
                            return {
                                data: b64,
                                mimetype: msg.mimetype || 'image/jpeg',
                                filename: msg.filename || 'comprobante.jpg',
                                filesize: msg.size || 0,
                            };
                        }
                    }
                } catch (ePrev) {}

                return undefined;
            }
        }, this.id._serialized);

        if (!result) return undefined;
        return new MessageMedia(
            result.mimetype,
            result.data,
            result.filename,
            result.filesize,
        );
    }`;

    // Reemplaza todo el bloque async downloadMedia() {...} en Message.js
    const downloadMediaRegex = /async\s+downloadMedia\(\)\s*\{[\s\S]*?if\s*\(!result\)\s*return\s*undefined;[\s\S]*?return\s+new\s+MessageMedia\([\s\S]*?\);\s*\}/;
    if (downloadMediaRegex.test(content)) {
        content = content.replace(downloadMediaRegex, patchedDownloadMedia);
        fs.writeFileSync(messageFile, content, 'utf-8');
        console.log('[Patch] ✅ Archivo whatsapp-web.js Message.js parcheado con éxito (downloadMedia mejorado).');
    } else {
        console.log('[Patch] ℹ️ Message.js ya cuenta con el parche.');
    }
}
