const fs = require('fs');
const path = require('path');

const db = JSON.parse(fs.readFileSync('data/quiniela.json', 'utf8'));

const paid = Object.entries(db.numeros || {})
  .filter(([_, v]) => v.estado === 'PAGADO')
  .map(([num, v]) => {
    let fechaStr = '-';
    const rawFecha = v.fechaPago || v.fechaReserva;
    if (rawFecha) {
      const dObj = new Date(rawFecha);
      fechaStr = dObj.toLocaleString('es-AR', {
        timeZone: 'America/Argentina/San_Juan',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }) + ' hs';
    }
    return {
      numero: num,
      vecino: v.vecino ? v.vecino.replace(/[\r\n]+/g, ' ').trim() : '-',
      casa: v.casa ? v.casa.replace(/[\r\n]+/g, ' ').trim() : '-',
      telefono: v.telefono && v.telefono.length > 15 ? v.telefono.slice(0, 14) + '…' : (v.telefono || '-'),
      fecha: fechaStr,
      confirmadoPor: v.confirmadoPor || '-'
    };
  })
  .sort((a, b) => parseInt(a.numero, 10) - parseInt(b.numero, 10));

let md = `# 📋 Listado Oficial de Números Pagados\n\n`;
md += `**Bono Contribución Sede Social - Barrio Carolina II**\n`;
md += `*Fecha de corte:* ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/San_Juan' })} hs\n`;
md += `*Total de números vendidos y pagados:* **${paid.length}** / 1000\n`;
md += `*Total recaudado:* **$${(paid.length * 3000).toLocaleString('es-AR')}**\n\n`;
md += `| N° | Titular | Domicilio / Manzana y Casa | Teléfono | Fecha de Compra / Pago |\n`;
md += `| :---: | :--- | :--- | :---: | :---: |\n`;

for (const p of paid) {
  md += `| **${p.numero}** | ${p.vecino} | ${p.casa} | \`${p.telefono}\` | ${p.fecha} |\n`;
}

fs.writeFileSync('C:/Users/clarr/.gemini/antigravity/brain/956c21d1-14d8-4092-b486-8338554ec650/listado_numeros_pagados.md', md, 'utf8');
console.log('Artifact written successfully. Size:', md.length, 'bytes');
