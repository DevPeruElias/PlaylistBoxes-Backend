const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const ytSearch = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());

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

// 🚀 EL EXTRACTOR PROXY CON DIAGNÓSTICO PROFUNDO
app.get('/api/stream/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const targetUrl = 'https://co.wuk.sh/api/json';

    try {
        console.log(`\n[Proxy] Intentando extraer video: ${videoId}...`);

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                // 🔥 CAMUFLAJE: Hacemos creer al servidor que somos un humano navegando en la web oficial
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Origin': 'https://cobalt.tools',
                'Referer': 'https://cobalt.tools/'
            },
            body: JSON.stringify({
                url: `https://www.youtube.com/watch?v=${videoId}`,
                vQuality: '720',
                isAudioOnly: false,
                isNoTTWatermark: true
            }),
            timeout: 10000 // Le damos 10 segundos antes de rendirnos
        });

        if (!response.ok) {
            // Si el servidor responde pero nos da un error (ej. 403 Forbidden)
            const errorText = await response.text();
            console.error(`\n🔴 [ERROR DE API COBALT] Status: ${response.status}`);
            console.error(`🔴 Motivo del rechazo: ${errorText}\n`);
            return res.status(response.status).json({ error: 'La API rechazó la extracción', detalle: errorText });
        }

        const data = await response.json();

        if (data && data.url) {
            console.log(`[Proxy] ✅ Éxito! URL limpia obtenida para ${videoId}`);
            return res.json({ url: data.url });
        } else {
            console.error(`\n🔴 [ERROR DE DATOS] La API respondió, pero no envió ninguna URL. Respuesta:`, data);
            return res.status(404).json({ error: 'No se obtuvo URL válida' });
        }

    } catch (error) {
        // 🔥 EL COMENTARIO Y DIAGNÓSTICO EXACTO QUE PEDISTE
        console.error('\n======================================================');
        console.error('🔴 ERROR CRÍTICO DE RED EN LA EXTRACCIÓN (FETCH FAILED)');
        console.error('======================================================');
        console.error('1. Mensaje general :', error.message);
        console.error('2. Causa interna   :', error.cause ? error.cause : 'Ninguna (Bloqueo directo o Timeout)');
        console.error('3. Código de error :', error.code || 'Desconocido');
        console.error('4. Pila de error   :\n', error.stack);
        console.error('======================================================\n');

        res.status(500).json({
            error: 'Fallo la conexión de red desde Render',
            mensaje: error.message,
            causa: error.cause ? error.cause.toString() : 'Desconocida'
        });
    }
});

io.on('connection', (socket) => {
    socket.on('admin_reiniciar_box', ({ sede, boxId }) => {
        const roomKey = `${sede}-${boxId}`;
        boxesState[roomKey] = { sede, boxId, estadoReproduccion: 'idle', cancionActual: null, playlist: [], currentIndex: 0, tiempoActual: 0 };
        io.to(roomKey).emit('box_reiniciado');
        io.to(roomKey).emit('estado_box_actualizado', boxesState[roomKey]);
    });

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