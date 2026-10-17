const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'quiniela.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

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
      telefono: v.telefono || '-',
      fecha: fechaStr
    };
  })
  .sort((a, b) => parseInt(a.numero, 10) - parseInt(b.numero, 10));

console.log(`TOTAL PAGADOS: ${paid.length}\n`);
console.log('| N° | Titular | Domicilio | Teléfono | Fecha de Compra |');
console.log('| :---: | :--- | :--- | :---: | :---: |');
for (const p of paid) {
  console.log(`| **${p.numero}** | ${p.vecino} | ${p.casa} | \`${p.telefono}\` | ${p.fecha} |`);
}
