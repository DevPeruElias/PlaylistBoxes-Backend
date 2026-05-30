const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const ytsr = require('ytsr'); // Nueva librería para buscar en YouTube

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const boxesState = {};

function getBoxState(sede, boxId) {
    const roomKey = `${sede}-${boxId}`;
    if (!boxesState[roomKey]) {
        boxesState[roomKey] = {
            sede,
            boxId,
            sessionId: Date.now().toString(),
            estadoReproduccion: 'idle',
            cancionActual: null,
            playlist: [],
            tiempoActual: 0
        };
    }
    return boxesState[roomKey];
}

io.on('connection', (socket) => {
    console.log('Usuario conectado:', socket.id);

    // 1. BÚSQUEDA DE YOUTUBE
    socket.on('buscar_cancion', async ({ query }) => {
        try {
            console.log('Buscando en YouTube:', query);
            const searchResults = await ytsr(query, { limit: 5 });

            const formatted = searchResults.items
                .filter(item => item.type === 'video')
                .map(item => ({
                    title: item.title,
                    videoId: item.id,
                    thumbnail: item.bestThumbnail.url
                }));

            socket.emit('resultados_busqueda', formatted);
        } catch (error) {
            console.error("Error en búsqueda:", error);
            socket.emit('resultados_busqueda', []);
        }
    });

    // 2. UNIRSE A BOX
    socket.on('unirse_box', ({ sede, boxId, tipo }) => {
        const roomKey = `${sede}-${boxId}`;
        socket.join(roomKey);
        const currentState = getBoxState(sede, boxId);
        socket.emit('estado_box_actualizado', currentState);
    });

    // 3. AGREGAR CANCIÓN
    socket.on('agregar_cancion', ({ sede, boxId, cancion, usuario }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);
        const nuevaCancion = { ...cancion, id: Date.now().toString(), agregadoPor: usuario };

        if (!state.cancionActual) {
            state.cancionActual = nuevaCancion;
            state.estadoReproduccion = 'playing';
        } else {
            state.playlist.push(nuevaCancion);
        }
        io.to(roomKey).emit('estado_box_actualizado', state);
    });

    // 4. ELIMINAR CANCIÓN
    socket.on('eliminar_cancion', ({ sede, boxId, cancionId }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);
        state.playlist = state.playlist.filter(c => c.id !== cancionId);
        io.to(roomKey).emit('estado_box_actualizado', state);
    });

    // 5. REORDENAR
    socket.on('reordenar_playlist', ({ sede, boxId, startIndex, endIndex }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);
        const [removed] = state.playlist.splice(startIndex, 1);
        state.playlist.splice(endIndex, 0, removed);
        io.to(roomKey).emit('estado_box_actualizado', state);
    });

    // 6. CONTROLES
    socket.on('comando_reproductor', ({ sede, boxId, comando }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);
        if (comando === 'play') state.estadoReproduccion = 'playing';
        if (comando === 'pause') state.estadoReproduccion = 'paused';
        if (comando === 'next') {
            if (state.playlist.length > 0) {
                state.cancionActual = state.playlist.shift();
                state.estadoReproduccion = 'playing';
            } else {
                state.cancionActual = null;
                state.estadoReproduccion = 'idle';
            }
        }
        io.to(roomKey).emit('estado_box_actualizado', state);
    });

    // 7. ADMIN REINICIAR
    socket.on('admin_reiniciar_box', ({ sede, boxId }) => {
        const roomKey = `${sede}-${boxId}`;
        boxesState[roomKey] = { sede, boxId, sessionId: Date.now().toString(), estadoReproduccion: 'idle', cancionActual: null, playlist: [], tiempoActual: 0 };
        io.to(roomKey).emit('box_reiniciado');
        io.to(roomKey).emit('estado_box_actualizado', boxesState[roomKey]);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));