/**
 * Módulo para conversión de documentos PDF a imagen utilizando la instancia
 * de Chromium/Puppeteer ya activa en WhatsApp Web (client.pupBrowser).
 */

/**
 * Renderiza la primera página de un PDF a una imagen JPEG en base64
 * para que pueda ser leída por modelos de visión de IA (como Groq Qwen 3.8 27B).
 * 
 * @param {object} client - Instancia de Client de whatsapp-web.js
 * @param {string} pdfBase64 - Contenido del PDF en base64
 * @returns {Promise<{base64: string, mimeType: string}|null>}
 */
async function convertPdfToImage(client, pdfBase64) {
    if (!client || !client.pupBrowser) {
        console.warn('[PDF] No hay instancia de pupBrowser activa en el cliente.');
        return null;
    }

    let page = null;
    try {
        page = await client.pupBrowser.newPage();
        await page.setViewport({ width: 1024, height: 1400 });

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
        </head>
        <body style="margin:0; padding:0; background:white; display:flex; justify-content:center;">
          <canvas id="pdf-canvas"></canvas>
          <script>
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            const rawData = atob('${pdfBase64}');
            pdfjsLib.getDocument({ data: rawData }).promise
              .then(pdf => pdf.getPage(1))
              .then(page => {
                const viewport = page.getViewport({ scale: 2.0 });
                const canvas = document.getElementById('pdf-canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const ctx = canvas.getContext('2d');
                return page.render({ canvasContext: ctx, viewport: viewport }).promise;
              })
              .then(() => { window.__PDF_RENDER_DONE__ = true; })
              .catch(err => { window.__PDF_RENDER_ERROR__ = err.message || String(err); });
          </script>
        </body>
        </html>`;

        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

        await page.waitForFunction(
            () => window.__PDF_RENDER_DONE__ || window.__PDF_RENDER_ERROR__, 
            { timeout: 15000 }
        );

        const renderError = await page.evaluate(() => window.__PDF_RENDER_ERROR__);
        if (renderError) {
            console.error('[PDF Error en renderizado]:', renderError);
            return null;
        }

        const canvasElement = await page.$('#pdf-canvas');
        if (!canvasElement) {
            return null;
        }

        const screenshotBase64 = await canvasElement.screenshot({
            encoding: 'base64',
            type: 'jpeg',
            quality: 90
        });

        return {
            base64: screenshotBase64,
            mimeType: 'image/jpeg'
        };
    } catch (err) {
        console.error('[PDF] Error convirtiendo documento PDF a imagen:', err.message);
        return null;
    } finally {
        if (page) {
            try { await page.close(); } catch (_) {}
        }
    }
}

module.exports = {
    convertPdfToImage
};
