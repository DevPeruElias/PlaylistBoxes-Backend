const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use('/api/', limiter);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const boxesState = {};
const searchCache = {};

// 🔥 RULETA DE ESPEJOS DE INVIDIOUS (Bypass de YouTube)
const INVIDIOUS_INSTANCES = [
    'https://vid.puffyan.us',
    'https://invidious.nerdvpn.de',
    'https://invidious.jing.rocks',
    'https://inv.tux.pizza'
];

async function buscarEnInvidious(query) {
    // Priorizamos resultados de Perú con region=PE para mayor precisión
    const urlQuery = encodeURIComponent(query.trim());

    for (const instancia of INVIDIOUS_INSTANCES) {
        try {
            const url = `${instancia}/api/v1/search?q=${urlQuery}&region=PE`;
            const response = await fetch(url, { timeout: 3500 }); // Si demora más de 3.5s, saltamos al siguiente

            if (response.ok) {
                return await response.json(); // Retorna el array de resultados
            }
        } catch (err) {
            console.log(`[Invidious] Instancia saturada (${instancia}), rotando...`);
            continue;
        }
    }
    throw new Error("Todas las instancias de búsqueda están ocupadas.");
}

function getBoxState(sede, boxId) {
    const roomKey = `${sede}-${boxId}`;
    if (!boxesState[roomKey]) {
        boxesState[roomKey] = { sede, boxId, estadoReproduccion: 'idle', cancionActual: null, playlist: [], currentIndex: 0, tiempoActual: 0 };
    }
    return boxesState[roomKey];
}

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
            // 1. BUSCADOR FANTASMA (Invidious API)
            const searchResults = await buscarEnInvidious(query);

            if (!searchResults || searchResults.length === 0) {
                socket.emit('resultados_busqueda', []);
                return;
            }

            // Invidious ya devuelve el tipo, filtramos videos y tomamos 6 prospectos
            const items = searchResults.filter(item => item.type === 'video').slice(0, 6);

            // 2. FILTRO LIGERO (OEmbed): Mata el error "Ver en YouTube" con 0 costo de RAM
            const validaciones = items.map(async (item) => {
                try {
                    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${item.videoId}&format=json`;
                    const oembedRes = await fetch(oembedUrl, { timeout: 2000 });

                    if (!oembedRes.ok) {
                        return null; // El autor desactivó la inserción en páginas externas
                    }

                    // Si sobrevive, formateamos los datos.
                    // Invidious ya nos da los segundos exactos (lengthSeconds)
                    return {
                        id: Math.random().toString(36),
                        title: item.title,
                        videoId: item.videoId,
                        // Forzamos la miniatura oficial de alta calidad de YouTube
                        thumbnail: `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
                        duration: item.lengthSeconds || 0
                    };
                } catch (e) {
                    return null; // Si hay error de red, lo omitimos por seguridad
                }
            });

            const resolved = await Promise.all(validaciones);
            const validItems = resolved.filter(i => i !== null).slice(0, 5);

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