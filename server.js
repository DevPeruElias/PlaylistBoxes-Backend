const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios'); // Usaremos axios para conectarnos a RapidAPI

const app = express();
app.use(cors());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use('/api/', limiter);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const boxesState = {};
const searchCache = {};

// 🔥 LA RULETA DE CLAVES (API KEY ROULETTE)
// Pon aquí todas las claves de RapidAPI gratuitas que saques con diferentes correos.
const rapidApiKeys = [
    '806211e9ddmsh1d9355388fa1730p1cbd55jsn5db96e477194',
    '1867ec7d0bmshe65e9278e5d85f8p1fa071jsn893f8bf3afc9',
    'd7cced8d2amshf6f8a3a24ab24cbp1cf0b2jsnae7e58d83b08'
];
let currentKeyIndex = 0;

// Función inteligente que busca y rota la clave si se acaba la cuota
async function buscarEnRapidAPI(query, retries = 0) {
    if (retries >= rapidApiKeys.length) {
        throw new Error("Todas las API Keys gratuitas se han quedado sin cuota esta noche.");
    }

    const currentKey = rapidApiKeys[currentKeyIndex];
    const options = {
        method: 'GET',
        url: 'https://youtube138.p.rapidapi.com/search/',
        params: { q: query, hl: 'es', gl: 'PE' },
        headers: {
            'X-RapidAPI-Key': currentKey,
            'X-RapidAPI-Host': 'youtube138.p.rapidapi.com'
        }
    };

    try {
        const response = await axios.request(options);
        return response.data;
    } catch (error) {
        // Códigos 429 o 403 significan que se acabó la cuota de la cuenta actual
        if (error.response && (error.response.status === 429 || error.response.status === 403)) {
            console.warn(`Límite alcanzado en la clave ${currentKeyIndex + 1}. Rotando a la siguiente clave...`);
            currentKeyIndex = (currentKeyIndex + 1) % rapidApiKeys.length;
            return buscarEnRapidAPI(query, retries + 1); // Reintenta con la nueva clave automáticamente
        }
        throw error;
    }
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
        const cacheKey = query.toLowerCase().trim();
        if (searchCache[cacheKey] && (Date.now() - searchCache[cacheKey].timestamp < 3600000)) {
            socket.emit('resultados_busqueda', searchCache[cacheKey].results);
            return;
        }

        try {
            // Buscamos forzando la palabra "letra" para evadir videos oficiales
            const data = await buscarEnRapidAPI(query + " letra");

            if (!data || !data.contents) {
                socket.emit('resultados_busqueda', []);
                return;
            }

            // Extraemos solo los que son videos
            let items = data.contents.filter(item => item.video);

            // 🔥 FILTRO EXTERMINADOR LOCAL
            // Eliminamos disqueras y videos oficiales que RapidAPI haya dejado pasar
            const blackList = ['vevo', 'official video', 'video oficial', 'official', 'umg', 'sme', 'wmg', 'sonymusic', 'warnermusic', 'latinautor', 'umpg', 'topic'];

            const validItems = items.filter(item => {
                const author = (item.video.author?.title || '').toLowerCase();
                const title = (item.video.title || '').toLowerCase();
                const esBloqueado = blackList.some(word => author.includes(word) || title.includes(word));
                return !esBloqueado;
            })
                .slice(0, 5) // Tomamos los 5 mejores limpios
                .map(item => ({
                    id: Math.random().toString(36),
                    title: item.video.title,
                    videoId: item.video.videoId,
                    thumbnail: item.video.thumbnails && item.video.thumbnails.length > 0 ? item.video.thumbnails[0].url : '',
                    // RapidAPI youtube138 devuelve los segundos directos en lengthSeconds
                    duration: parseInt(item.video.lengthSeconds) || 0
                }));

            searchCache[cacheKey] = { results: validItems, timestamp: Date.now() };
            socket.emit('resultados_busqueda', validItems);

        } catch (e) {
            console.error("Error en búsqueda con RapidAPI:", e.message);
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