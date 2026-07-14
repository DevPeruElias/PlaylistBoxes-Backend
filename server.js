const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const ytsr = require('ytsr');
const youtubedl = require('youtube-dl-exec'); // 🔥 Motor Multiproceso de Python

const app = express();
app.use(cors());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use('/api/', limiter);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const boxesState = {};
const searchCache = {};

function getBoxState(sede, boxId) {
    const roomKey = `${sede}-${boxId}`;
    if (!boxesState[roomKey]) {
        boxesState[roomKey] = { sede, boxId, estadoReproduccion: 'idle', cancionActual: null, playlist: [], currentIndex: 0, tiempoActual: 0 };
    }
    return boxesState[roomKey];
}

// Movido afuera para que esté disponible globalmente
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
            // 🔥 EL PIVOTE A ROCOLA: Forzamos la búsqueda estricta de Karaokes
            const queryRocola = query.trim() + " karaoke";

            // Buscamos 12 resultados rápidos usando ytsr
            const searchResults = await ytsr(queryRocola, { limit: 12 });

            if (!searchResults || !searchResults.items) {
                socket.emit('resultados_busqueda', []);
                return;
            }

            let items = searchResults.items.filter(item => item.type === 'video');

            // Filtro manual de limpieza
            const blackList = ['vevo', 'official video', 'video oficial', 'official', 'umg', 'sme', 'wmg', 'sonymusic', 'warnermusic', 'topic'];

            let preFilteredItems = items.filter(item => {
                const author = (item.author?.name || '').toLowerCase();
                const title = (item.title || '').toLowerCase();
                return !blackList.some(word => author.includes(word) || title.includes(word));
            });

            // Seleccionamos exactamente 5 candidatos para lanzar los 5 subprocesos (no más para no saturar la RAM)
            const candidates = preFilteredItems.slice(0, 5);

            // 🔥 EL MULTIPROCESO (Python al rescate evaluando todos al mismo tiempo)
            const validaciones = candidates.map(async (item) => {
                try {
                    // El motor de Python lee la API interna directamente
                    const videoData = await youtubedl(`https://www.youtube.com/watch?v=${item.id}`, {
                        dumpSingleJson: true,
                        skipDownload: true, // Solo metadata, no descargamos nada
                        simulate: true,
                        noWarnings: true,
                        callHome: false
                    });

                    return {
                        id: Math.random().toString(36),
                        title: videoData.title || item.title,
                        videoId: videoData.id || item.id,
                        thumbnail: item.bestThumbnail?.url || '',
                        // Python devuelve la duración en segundos enteros
                        duration: videoData.duration || parseDuration(item.duration)
                    };
                } catch (errorPython) {
                    // Si el video tiene copyright duro o bloqueos extraños, el binario revienta y lo atrapamos
                    console.log(`[Python Escáner] ❌ Eliminando video restringido: ${item.title}`);
                    return null;
                }
            });

            // Esperamos que los 5 clones de Python terminen su trabajo
            const resolved = await Promise.all(validaciones);
            // Filtramos los que dieron error (null)
            const validItems = resolved.filter(i => i !== null);

            searchCache[cacheKey] = { results: validItems, timestamp: Date.now() };
            socket.emit('resultados_busqueda', validItems);

        } catch (e) {
            console.error("Error crítico en búsqueda multiproceso:", e.message);
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

setInterval(() => { console.log("Heartbeat: Servidor activo..."); }, 300000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en ${PORT}`));