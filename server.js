require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Permisos básicos y conexión a tu carpeta visual
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuración del radar en tiempo real (WebSockets)
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Cuando un visitante o la ONG se conecta al mapa
io.on('connection', (socket) => {
    console.log('Un dispositivo se ha conectado al radar:', socket.id);

    // Escucha el reporte desde el botón y hace el "eco" a todas las pantallas
    socket.on('nuevo_reporte', (mensaje) => {
        console.log('Alerta recibida en el servidor:', mensaje);
        io.emit('actualizacion_radar', `📢 ${mensaje} - ¡Notificación enviada a la ONG!`);
    });

    socket.on('disconnect', () => {
        console.log('Dispositivo desconectado:', socket.id);
    });
});

// Encender los motores
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor encendido de forma local en http://localhost:${PORT}`);
});