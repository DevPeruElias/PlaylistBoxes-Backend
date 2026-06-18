const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const ytsr = require('ytsr');
const rateLimit = require('express-rate-limit');
const axios = require('axios'); // Nueva dependencia necesaria

const app = express();
app.use(cors());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use('/api/', limiter);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const boxesState = {};
const searchCache = {};

// Función para verificar si un video se puede insertar (reproducir)
async function isVideoEmbeddable(videoId) {
    try {
        const url = `https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${videoId}&format=json`;
        const response = await axios.get(url);
        return response.status === 200;
    } catch (error) {
        // Si hay error (403), el video está bloqueado
        return false;
    }
}

function getBoxState(sede, boxId) {
    const roomKey = `${sede}-${boxId}`;
    if (!boxesState[roomKey]) {
        boxesState[roomKey] = { sede, boxId, estadoReproduccion: 'idle', cancionActual: null, playlist: [], currentIndex: 0, tiempoActual: 0 };
    }
    return boxesState[roomKey];
}

function parseDuration(durationStr) {
    if (!durationStr) return 0;
    const parts = durationStr.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
}

io.on('connection', (socket) => {
    socket.on('admin_reiniciar_box', ({ sede, boxId }) => {
        const roomKey = `${sede}-${boxId}`;
        boxesState[roomKey] = { sede, boxId, estadoReproduccion: 'idle', cancionActual: null, playlist: [], currentIndex: 0, tiempoActual: 0 };
        io.to(roomKey).emit('box_reiniciado');
        io.to(roomKey).emit('estado_box_actualizado', boxesState[roomKey]);
    });

    socket.on('buscar_cancion', async ({ query }) => {
        const cacheKey = query.toLowerCase().trim();
        if (searchCache[cacheKey] && (Date.now() - searchCache[cacheKey].timestamp < 3600000)) {
            socket.emit('resultados_busqueda', searchCache[cacheKey].results);
            return;
        }

        try {
            // Buscamos con un limit razonable
            const searchResults = await ytsr(query + " letra", { limit: 15 });

            // 🔥 SEGURIDAD: Validar si existen items antes de filtrar
            if (!searchResults || !searchResults.items) {
                throw new Error("ytsr no devolvió resultados válidos");
            }

            const items = searchResults.items.filter(item => item.type === 'video');

            const formatted = [];
            // Filtramos y validamos uno a uno
            for (const item of items) {
                if (formatted.length >= 5) break; // Solo queremos 5 resultados

                const author = (item.author?.name || '').toLowerCase();
                const title = (item.title || '').toLowerCase();

                // 1. Filtro agresivo de Palabras (Blacklist)
                const blackList = ['vevo', 'official video', 'video oficial', 'official', 'umg', 'sme', 'wmg', 'sonymusic', 'warnermusic', 'latinautor', 'umpg', 'topic'];
                const esBloqueado = blackList.some(word => author.includes(word) || title.includes(word));

                if (esBloqueado) continue; // Si está en lista negra, lo saltamos

                // 2. Verificación de red (OEmbed)
                const esSeguro = await isVideoEmbeddable(item.id);
                if (esSeguro) {
                    formatted.push({
                        id: Math.random().toString(36),
                        title: item.title,
                        videoId: item.id,
                        thumbnail: item.bestThumbnail?.url || '',
                        duration: parseDuration(item.duration)
                    });
                }
            }

            searchCache[cacheKey] = { results: formatted, timestamp: Date.now() };
            socket.emit('resultados_busqueda', formatted);
        } catch (e) {
            console.error("Error en búsqueda:", e.message);
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
        if (!state.cancionActual) { state.cancionActual = nuevaCancion; state.estadoReproduccion = 'playing'; state.currentIndex = state.playlist.length - 1; }
        io.to(`${sede}-${boxId}`).emit('estado_box_actualizado', state);
    });

    socket.on('eliminar_cancion', ({ sede, boxId, cancionId }) => {
        const state = getBoxState(sede, boxId);
        const indexToDelete = state.playlist.findIndex(c => c.id === cancionId);
        if (indexToDelete !== -1) {
            state.playlist.splice(indexToDelete, 1);
            if (indexToDelete < state.currentIndex) { state.currentIndex--; }
            else if (indexToDelete === state.currentIndex) {
                if (state.playlist.length > state.currentIndex) { state.cancionActual = state.playlist[state.currentIndex]; state.tiempoActual = 0; state.estadoReproduccion = 'playing'; io.to(`${sede}-${boxId}`).emit('ejecutar_comando', { comando: 'seek', valor: 0 }); }
                else { state.cancionActual = null; state.estadoReproduccion = 'idle'; state.currentIndex = 0; state.tiempoActual = 0; }
            }
        }
        io.to(`${sede}-${boxId}`).emit('estado_box_actualizado', state);
    });

    socket.on('reordenar_playlist', ({ sede, boxId, startIndex, endIndex }) => {
        const state = getBoxState(sede, boxId);
        const [removed] = state.playlist.splice(startIndex, 1);
        state.playlist.splice(endIndex, 0, removed);
        if (state.cancionActual) { state.currentIndex = state.playlist.findIndex(c => c.id === state.cancionActual.id); }
        io.to(`${sede}-${boxId}`).emit('estado_box_actualizado', state);
    });

    socket.on('comando_reproductor', ({ sede, boxId, comando, valor }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);
        if (comando === 'play') state.estadoReproduccion = 'playing';
        if (comando === 'pause') state.estadoReproduccion = 'paused';
        if (comando === 'next') {
            if (state.currentIndex < state.playlist.length - 1) { state.currentIndex++; state.cancionActual = state.playlist[state.currentIndex]; state.estadoReproduccion = 'playing'; state.tiempoActual = 0; }
            else { state.estadoReproduccion = 'idle'; state.cancionActual = null; }
        }
        if (comando === 'prev') {
            if (state.currentIndex > 0) { state.currentIndex--; state.cancionActual = state.playlist[state.currentIndex]; state.estadoReproduccion = 'playing'; state.tiempoActual = 0; }
        }
        if (comando === 'jump_to' && valor !== undefined) {
            if (valor >= 0 && valor < state.playlist.length) {
                state.currentIndex = valor;
                state.cancionActual = state.playlist[state.currentIndex];
                state.estadoReproduccion = 'playing';
                state.tiempoActual = 0;
            }
        }
        if (comando === 'seek' || comando === 'volumen') {
            io.to(roomKey).emit('ejecutar_comando', { comando, valor });
        } else {
            io.to(roomKey).emit('estado_box_actualizado', state);
        }
    });
});

setInterval(() => { console.log("Sopranos Heartbeat: Servidor activo..."); }, 300000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en ${PORT}`));