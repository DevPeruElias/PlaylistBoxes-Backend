const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const ytsr = require('ytsr');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const boxesState = {};

function getBoxState(sede, boxId) {
    const roomKey = `${sede}-${boxId}`;
    if (!boxesState[roomKey]) {
        boxesState[roomKey] = {
            sede, boxId,
            estadoReproduccion: 'idle',
            cancionActual: null,
            playlist: [], // Lista completa
            currentIndex: 0, // Índice de la canción que suena
            tiempoActual: 0
        };
    }
    return boxesState[roomKey];
}

io.on('connection', (socket) => {

    socket.on('buscar_cancion', async ({ query }) => {
        const searchResults = await ytsr(query, { limit: 5 });
        const formatted = searchResults.items
            .filter(item => item.type === 'video')
            .map(item => ({
                id: Math.random().toString(36),
                title: item.title,
                videoId: item.id,
                thumbnail: item.bestThumbnail.url
            }));
        socket.emit('resultados_busqueda', formatted);
    });

    socket.on('unirse_box', ({ sede, boxId }) => {
        const roomKey = `${sede}-${boxId}`;
        console.log("➡️ Un usuario se unió a:", roomKey);
        socket.join(roomKey);
        socket.emit('estado_box_actualizado', getBoxState(sede, boxId));
    });

    socket.on('actualizar_progreso', ({ sede, boxId, tiempoActual }) => {
        const state = getBoxState(sede, boxId);
        state.tiempoActual = tiempoActual;
        io.to(`${sede}-${boxId}`).emit('progreso_actualizado', tiempoActual);
    });

    socket.on('agregar_cancion', ({ sede, boxId, cancion, usuario }) => {
        const state = getBoxState(sede, boxId);
        const nuevaCancion = { ...cancion, agregadoPor: usuario };

        state.playlist.push(nuevaCancion);

        // Si no hay nada sonando, seleccionamos esta como la primera
        if (!state.cancionActual) {
            state.cancionActual = nuevaCancion;
            state.estadoReproduccion = 'playing';
            state.currentIndex = state.playlist.length - 1;
        }

        io.to(`${sede}-${boxId}`).emit('estado_box_actualizado', state);
    });

    socket.on('comando_reproductor', ({ sede, boxId, comando, valor }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);

        if (comando === 'play') state.estadoReproduccion = 'playing';
        if (comando === 'pause') state.estadoReproduccion = 'paused';

        if (comando === 'next') {
            // Avanzamos el índice sin hacer shift()
            if (state.currentIndex < state.playlist.length - 1) {
                state.currentIndex++;
                state.cancionActual = state.playlist[state.currentIndex];
                state.estadoReproduccion = 'playing';
                state.tiempoActual = 0;
            } else {
                state.estadoReproduccion = 'idle';
            }
        }

        if (comando === 'seek') {
            io.to(roomKey).emit('ejecutar_comando', { comando, valor });
        } else {
            io.to(roomKey).emit('estado_box_actualizado', state);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en ${PORT}`));