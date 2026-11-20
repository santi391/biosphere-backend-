require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const ARCHIVO_HISTORIAL = './historial.json';
const HEADERS = { 'User-Agent': 'BIOSPHERE-Monitor/1.0' };

let cacheSatelital = [];
let resumenFuentes = 'Sincronizando...';
let ultimaActualizacion = 0;
let promesaEnCurso = null;

function leerHistorial() {
    if (!fs.existsSync(ARCHIVO_HISTORIAL)) {
        fs.writeFileSync(ARCHIVO_HISTORIAL, JSON.stringify([], null, 2));
    }
    try {
        return JSON.parse(fs.readFileSync(ARCHIVO_HISTORIAL));
    } catch {
        return [];
    }
}

async function fetchConTimeout(url, ms = 14000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function obtenerTelemetriaGlobal(forzar = false) {
    const ahora = Date.now();
    if (!forzar && cacheSatelital.length > 0 && (ahora - ultimaActualizacion) < 180000) {
        return cacheSatelital;
    }

    if (promesaEnCurso) {
        return await promesaEnCurso;
    }

    promesaEnCurso = (async () => {
        const eventos = [];
        let cNasa = 0, cUsgs = 0, cRios = 0, cAire = 0;

        const [resNasa, resUsgs, resRios, resAire] = await Promise.allSettled([
            fetchConTimeout('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=30'),
            fetchConTimeout('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'),
            fetchConTimeout('https://flood-api.open-meteo.com/v1/flood?latitude=-3.46,-12.04,23.81,30.04,15.12&longitude=-62.21,-77.04,90.41,31.23,105.80&daily=river_discharge,river_discharge_mean&forecast_days=1'),
            fetchConTimeout('https://air-quality-api.open-meteo.com/v1/air-quality?latitude=-3.46,0.51,-0.78,28.61,-12.04&longitude=-62.21,25.25,113.92,77.20,-77.04&current=us_aqi,pm2_5')
        ]);

        // 1. NASA EONET (Incendios, tormentas, inundaciones, volcanes)
        if (resNasa.status === 'fulfilled' && resNasa.value?.events) {
            resNasa.value.events.forEach(ev => {
                const geo = ev.geometry?.[ev.geometry.length - 1];
                if (!geo || geo.type !== 'Point') return;

                const cat = ev.categories?.[0]?.id || '';
                let ods = 'ODS 15';
                let severidad = 'ALTO';
                if (cat === 'floods' || cat === 'drought') ods = 'ODS 6';
                if (cat === 'severeStorms' || cat === 'seaLakeIce') { ods = 'ODS 14'; severidad = 'CRÍTICO'; }
                if (cat === 'volcanoes') severidad = 'CRÍTICO';

                eventos.push({
                    id: `nasa-${ev.id}`,
                    ods,
                    severidad,
                    detalle: ev.title,
                    latitud: geo.coordinates[1],
                    longitud: geo.coordinates[0],
                    fecha: new Date(geo.date).toLocaleString(),
                    fuente: '🛰️ NASA EONET',
                    urlOficial: ev.sources?.[0]?.url || ev.link || 'https://eonet.gsfc.nasa.gov/'
                });
                cNasa++;
            });
        }

        // 2. USGS Sismología y Alertas de Tsunami
        if (resUsgs.status === 'fulfilled' && resUsgs.value?.features) {
            resUsgs.value.features.slice(0, 25).forEach(sismo => {
                const coords = sismo.geometry.coordinates;
                const mag = sismo.properties.mag;
                const hayTsunami = sismo.properties.tsunami === 1;
                const ods = hayTsunami ? 'ODS 14' : 'ODS 15';
                const severidad = (mag >= 5.5 || hayTsunami) ? 'CRÍTICO' : (mag >= 4.5 ? 'ALTO' : 'MODERADO');

                eventos.push({
                    id: `usgs-${sismo.id}`,
                    ods,
                    severidad,
                    detalle: `${hayTsunami ? '🌊 ALERTA TSUNAMI + ' : ''}Sismo M${mag.toFixed(1)} - ${sismo.properties.place}`,
                    latitud: coords[1],
                    longitud: coords[0],
                    fecha: new Date(sismo.properties.time).toLocaleString(),
                    fuente: '🌋 USGS Sismología',
                    urlOficial: sismo.properties.url || 'https://earthquake.usgs.gov/'
                });
                cUsgs++;
            });
        }

        // 3. Hidrología Fluvial GloFAS (Caudal real de cuencas)
        if (resRios.status === 'fulfilled' && Array.isArray(resRios.value)) {
            const cuencas = [
                { nombre: 'Cuenca Río Amazonas (Manaos)', lat: -3.46, lng: -62.21 },
                { nombre: 'Cuenca Río Rímac / Andes (Lima)', lat: -12.04, lng: -77.04 },
                { nombre: 'Delta Ganges-Brahmaputra', lat: 23.81, lng: 90.41 },
                { nombre: 'Cuenca Baja Río Nilo', lat: 30.04, lng: 31.23 },
                { nombre: 'Cuenca Río Mekong', lat: 15.12, lng: 105.80 }
            ];

            resRios.value.forEach((rio, idx) => {
                const actual = rio.daily?.river_discharge?.[0];
                const media = rio.daily?.river_discharge_mean?.[0];
                if (actual == null || media == null) return;

                const ratio = media > 0 ? (actual / media) : 1;
                const severidad = ratio >= 1.8 ? 'CRÍTICO' : (ratio >= 1.25 ? 'ALTO' : 'MODERADO');
                const c = cuencas[idx];

                eventos.push({
                    id: `rio-${idx}`,
                    ods: 'ODS 6',
                    severidad,
                    detalle: `Caudal ${c.nombre}: ${actual.toFixed(1)} m³/s (Media histórica: ${media.toFixed(1)} m³/s)`,
                    latitud: c.lat,
                    longitud: c.lng,
                    fecha: new Date().toLocaleString(),
                    fuente: '🌊 Hidrología GloFAS',
                    urlOficial: 'https://open-meteo.com/en/docs/flood-api'
                });
                cRios++;
            });
        }

        // 4. Calidad del Aire CAMS (Ecosistemas y corredores críticos)
        if (resAire.status === 'fulfilled' && Array.isArray(resAire.value)) {
            const zonas = [
                { nombre: 'Reserva Amazónica Central', lat: -3.46, lng: -62.21 },
                { nombre: 'Selva Cuenca del Congo', lat: 0.51, lng: 25.25 },
                { nombre: 'Bosque Tropical de Borneo', lat: -0.78, lng: 113.92 },
                { nombre: 'Corredor Urbano Nueva Delhi', lat: 28.61, lng: 77.20 },
                { nombre: 'Costa Central Lima Metropolitana', lat: -12.04, lng: -77.04 }
            ];

            resAire.value.forEach((aire, idx) => {
                const aqi = aire.current?.us_aqi;
                const pm25 = aire.current?.pm2_5;
                if (aqi == null) return;

                const severidad = aqi >= 150 ? 'CRÍTICO' : (aqi >= 80 ? 'ALTO' : 'MODERADO');
                const z = zonas[idx];

                eventos.push({
                    id: `aire-${idx}`,
                    ods: 'ODS 15',
                    severidad,
                    detalle: `Atmósfera ${z.nombre}: US AQI ${aqi} | PM2.5: ${pm25} µg/m³`,
                    latitud: z.lat,
                    longitud: z.lng,
                    fecha: new Date().toLocaleString(),
                    fuente: '🌫️ Satélite CAMS',
                    urlOficial: 'https://open-meteo.com/en/docs/air-quality-api'
                });
                cAire++;
            });
        }

        resumenFuentes = `NASA: ${cNasa} | USGS: ${cUsgs} | RÍOS: ${cRios} | AIRE: ${cAire}`;
        console.log(`📡 Telemetría real -> ${resumenFuentes}`);

        if (eventos.length > 0) {
            cacheSatelital = eventos;
            ultimaActualizacion = Date.now();
        }

        promesaEnCurso = null;
        return eventos;
    })();

    return await promesaEnCurso;
}

// Endpoint HTTP directo para sincronización rápida
app.get('/api/telemetria', async (req, res) => {
    const forzar = req.query.forzar === '1';
    const globales = await obtenerTelemetriaGlobal(forzar);
    const locales = leerHistorial();
    res.json({
        eventos: [...locales, ...globales],
        resumen: resumenFuentes
    });
});

io.on('connection', async (socket) => {
    const locales = leerHistorial();
    const globales = await obtenerTelemetriaGlobal(false);
    socket.emit('historial_radar', {
        eventos: [...locales, ...globales],
        resumen: resumenFuentes
    });

    // Telemetría meteorológica y de aire en tiempo real en la ubicación GPS del usuario
    socket.on('consultar_mi_entorno', async ({ lat, lng }) => {
        try {
            const [resClima, resAire] = await Promise.all([
                fetchConTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`),
                fetchConTimeout(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}&current=us_aqi,pm2_5`)
            ]);

            socket.emit('entorno_local', {
                temp: resClima.current?.temperature_2m ?? '--',
                humedad: resClima.current?.relative_humidity_2m ?? '--',
                viento: resClima.current?.wind_speed_10m ?? '--',
                aqi: resAire.current?.us_aqi ?? '--',
                pm25: resAire.current?.pm2_5 ?? '--'
            });
        } catch (err) {
            console.error('Error escaneando entorno local:', err.message);
        }
    });

    // Registro de nuevos incidentes verificados por GPS en campo
    socket.on('nuevo_reporte', (datos) => {
        const nuevo = {
            ...datos,
            id: `campo-${Date.now()}`,
            fuente: '📍 Reporte GPS Verificado',
            urlOficial: `https://www.google.com/maps?q=${datos.latitud},${datos.longitud}`
        };
        const historial = leerHistorial();
        historial.unshift(nuevo);
        fs.writeFileSync(ARCHIVO_HISTORIAL, JSON.stringify(historial, null, 2));
        io.emit('actualizacion_radar', nuevo);
    });
});

// Refresco satelital automático cada 3 minutos
setInterval(async () => {
    const globales = await obtenerTelemetriaGlobal(true);
    const locales = leerHistorial();
    io.emit('historial_radar', {
        eventos: [...locales, ...globales],
        resumen: resumenFuentes
    });
}, 180000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`BIOSPHERE operando en http://localhost:${PORT}`);
    obtenerTelemetriaGlobal(true);
});