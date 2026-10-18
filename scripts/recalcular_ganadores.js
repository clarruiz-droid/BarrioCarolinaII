const fs = require('fs');
const path = require('path');

const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'quiniela.json'), 'utf8'));

console.log('Estado de ventas:', db.ventasAbiertas ? 'ABIERTAS' : 'CERRADAS');

const sorteo = [
    { pos: 1, full: "5274" },
    { pos: 2, full: "5097" },
    { pos: 3, full: "9338" },
    { pos: 4, full: "9915" },
    { pos: 5, full: "2442" },
    { pos: 6, full: "9640" },
    { pos: 7, full: "2253" },
    { pos: 8, full: "4865" },
    { pos: 9, full: "1089" },
    { pos: 10, full: "8582" },
    { pos: 11, full: "9485" },
    { pos: 12, full: "4416" },
    { pos: 13, full: "6854" },
    { pos: 14, full: "8112" },
    { pos: 15, full: "3544" },
    { pos: 16, full: "5296" },
    { pos: 17, full: "4899" },
    { pos: 18, full: "2505" },
    { pos: 19, full: "1681" },
    { pos: 20, full: "8594" }
];

const premios = [
    { premio: "1° Premio", desc: "Boucher para Pizzería Verona (1 Pizza 12 porciones a elección)" },
    { premio: "2° Premio", desc: "Boucher para pastelería Carolina Meschini (4/4 postre)" },
    { premio: "3° Premio", desc: "Boucher Almacén Ganesha (1 estuche de vinos Finca Natalina)" },
    { premio: "4° Premio", desc: "Boucher Verdulería Menta (1 canasta de verduras)" },
    { premio: "5° Premio", desc: "Boucher de Tiara_Lashh (laminado de cejas y lifting de pestañas)" }
];

const tablaDetalle = [];
const ganadoresAsignados = [];
const suplentes = [];

for (const s of sorteo) {
    const u3 = s.full.slice(-3);
    const item = db.numeros[u3];
    const estado = item ? item.estado : 'LIBRE';
    let fechaStr = '-';
    if (item && (item.fechaPago || item.fechaReserva)) {
        const dObj = new Date(item.fechaPago || item.fechaReserva);
        fechaStr = dObj.toLocaleString('es-AR', {
            timeZone: 'America/Argentina/San_Juan',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }) + ' hs';
    }

    const fila = {
        pos: s.pos,
        full: s.full,
        numero: u3,
        estado: estado,
        vecino: item ? (item.vecino || '-') : '-',
        casa: item ? (item.casa || '-') : '-',
        telefono: item ? (item.telefono || '-') : '-',
        fechaCompra: fechaStr,
        pagadorBancario: item ? item.pagadorBancario : null,
        confirmadoPor: item ? item.confirmadoPor : null
    };

    if (estado === 'PAGADO') {
        if (ganadoresAsignados.length < premios.length) {
            const premioObj = premios[ganadoresAsignados.length];
            fila.premioAsignado = `${premioObj.premio} (${premioObj.desc})`;
            ganadoresAsignados.push({
                ...premioObj,
                ...fila
            });
        } else {
            fila.premioAsignado = 'Suplente';
            suplentes.push(fila);
        }
    } else {
        fila.premioAsignado = 'Vacante (Pasa al siguiente)';
    }

    tablaDetalle.push(fila);
}

console.log(JSON.stringify({ ganadoresAsignados, suplentes, tablaDetalle }, null, 2));
