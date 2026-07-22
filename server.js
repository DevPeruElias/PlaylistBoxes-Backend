const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const ytSearch = require('yt-search');
const youtubedl = require('youtube-dl-exec');

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 SOLUCIÓN AL ERROR DE RENDER: Confiar en el proxy para el rate limiter
app.set('trust proxy', 1);

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
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

// 🔥 ENDPOINT HTTP OPTIMIZADO: Python extrae el .mp4 puro para la TV
app.get('/api/stream/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        const output = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
            format: 'best[ext=mp4]/best',
            getUrl: true,
            noWarnings: true,
            callHome: false
        });

        const directUrl = typeof output === 'string' ? output.trim().split('\n')[0] : '';
        if (!directUrl) {
            return res.status(404).json({ error: 'No se pudo extraer el enlace' });
        }

        res.json({ url: directUrl });
    } catch (error) {
        console.error('Error extrayendo stream con Python:', error.message);
        res.status(500).json({ error: 'Error interno al procesar el video' });
    }
});

io.on('connection', (socket) => {
    socket.on('admin_reiniciar_box', ({ sede, boxId }) => {
        const roomKey = `${sede}-${boxId}`;
        boxesState[roomKey] = { sede, boxId, estadoReproduccion: 'idle', cancionActual: null, playlist: [], currentIndex: 0, tiempoActual: 0 };
        io.to(roomKey).emit('box_reiniciado');
        io.to(roomKey).emit('estado_box_actualizado', boxesState[roomKey]);
    });

    // 🔥 BÚSQUEDA INSTÁNTANEA: Sin bloqueos pesados, responde al vuelo
    socket.on('buscar_cancion', async ({ query }) => {
        if (!query) return;
        const cacheKey = query.toLowerCase().trim();

        if (searchCache[cacheKey] && (Date.now() - searchCache[cacheKey].timestamp < 3600000)) {
            socket.emit('resultados_busqueda', searchCache[cacheKey].results);
            return;
        }

        try {
            const r = await ytSearch(query.trim());

            if (!r || !r.videos || r.videos.length === 0) {
                socket.emit('resultados_busqueda', []);
                return;
            }

            // Devolvemos los resultados inmediatamente sin validar OEmbed lento
            const validItems = r.videos.slice(0, 5).map(v => ({
                id: Math.random().toString(36),
                title: v.title,
                videoId: v.videoId,
                thumbnail: v.thumbnail,
                duration: v.seconds
            }));

            searchCache[cacheKey] = { results: validItems, timestamp: Date.now() };
            socket.emit('resultados_busqueda', validItems);

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en ${PORT}`));