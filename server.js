require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Permisos básicos
app.use(cors());
app.use(express.json());

// Configuración del radar en tiempo real (WebSockets)
const io = new Server(server, {
    cors: {
        origin: "*", // Permite conexiones desde cualquier pantalla
        methods: ["GET", "POST"]
    }
});

// Cuando un visitante o la ONG se conecta al mapa
io.on('connection', (socket) => {
    console.log('Un dispositivo se ha conectado al radar:', socket.id);

    socket.on('disconnect', () => {
        console.log('Dispositivo desconectado:', socket.id);
    });
});

// Ruta de prueba para saber que el servidor no se ha caído
app.get('/', (req, res) => {
    res.send('¡El servidor de BIOSPHERE está vivo y funcionando al 100%!');
});

// Encender los motores
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor encendido de forma local en http://localhost:${PORT}`);
});