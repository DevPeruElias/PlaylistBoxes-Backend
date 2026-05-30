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
            playlist: [], // El historial completo
            currentIndex: 0,
            tiempoActual: 0
        };
    }
    return boxesState[roomKey];
}

io.on('connection', (socket) => {

    socket.on('admin_reiniciar_box', ({ sede, boxId }) => {
        const roomKey = `${sede}-${boxId}`;
        // Reseteamos el estado a cero
        boxesState[roomKey] = {
            sede, boxId,
            estadoReproduccion: 'idle',
            cancionActual: null,
            playlist: [],
            currentIndex: 0,
            tiempoActual: 0
        };
        // Avisamos a los celulares que se reinició (para mostrar la alerta)
        io.to(roomKey).emit('box_reiniciado');
        // Mandamos el estado vacío a la TV y celulares
        io.to(roomKey).emit('estado_box_actualizado', boxesState[roomKey]);
    });


    socket.on('buscar_cancion', async ({ query }) => {
        try {
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
        } catch (e) {
            socket.emit('resultados_busqueda', []);
        }
    });

    socket.on('unirse_box', ({ sede, boxId }) => {
        const roomKey = `${sede}-${boxId}`;
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

        if (!state.cancionActual) {
            state.cancionActual = nuevaCancion;
            state.estadoReproduccion = 'playing';
            state.currentIndex = state.playlist.length - 1;
        }

        io.to(`${sede}-${boxId}`).emit('estado_box_actualizado', state);
    });

    // RECUPERADO: ELIMINAR CANCIÓN
    socket.on('eliminar_cancion', ({ sede, boxId, cancionId }) => {
        const state = getBoxState(sede, boxId);
        const indexToDelete = state.playlist.findIndex(c => c.id === cancionId);

        if (indexToDelete !== -1) {
            state.playlist.splice(indexToDelete, 1);

            // Ajustamos el índice para no perder el hilo de la reproducción
            if (indexToDelete < state.currentIndex) {
                state.currentIndex--;
            } else if (indexToDelete === state.currentIndex) {
                // Si borramos la canción que está sonando, pasamos a la siguiente
                if (state.playlist.length > state.currentIndex) {
                    state.cancionActual = state.playlist[state.currentIndex];
                    state.tiempoActual = 0;
                } else {
                    state.cancionActual = null;
                    state.estadoReproduccion = 'idle';
                    state.currentIndex = 0;
                }
            }
        }
        io.to(`${sede}-${boxId}`).emit('estado_box_actualizado', state);
    });

    // RECUPERADO: REORDENAR PLAYLIST
    socket.on('reordenar_playlist', ({ sede, boxId, startIndex, endIndex }) => {
        const state = getBoxState(sede, boxId);
        const [removed] = state.playlist.splice(startIndex, 1);
        state.playlist.splice(endIndex, 0, removed);

        // Si reordenamos, buscamos dónde quedó la canción actual para actualizar el índice
        if (state.cancionActual) {
            state.currentIndex = state.playlist.findIndex(c => c.id === state.cancionActual.id);
        }

        io.to(`${sede}-${boxId}`).emit('estado_box_actualizado', state);
    });

    // CONTROLES: PLAY, PAUSE, NEXT, PREV, SEEK
    socket.on('comando_reproductor', ({ sede, boxId, comando, valor }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);

        if (comando === 'play') state.estadoReproduccion = 'playing';
        if (comando === 'pause') state.estadoReproduccion = 'paused';

        if (comando === 'next') {
            if (state.currentIndex < state.playlist.length - 1) {
                state.currentIndex++;
                state.cancionActual = state.playlist[state.currentIndex];
                state.estadoReproduccion = 'playing';
                state.tiempoActual = 0;
            } else {
                state.estadoReproduccion = 'idle';
                state.cancionActual = null;
            }
        }

        if (comando === 'prev') {
            if (state.currentIndex > 0) {
                state.currentIndex--;
                state.cancionActual = state.playlist[state.currentIndex];
                state.estadoReproduccion = 'playing';
                state.tiempoActual = 0;
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