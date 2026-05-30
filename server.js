const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Configuración de Socket.io permitiendo conexiones desde cualquier lugar (Vercel o local)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// MEMORIA DEL SISTEMA: Aquí guardaremos el estado de los 34 boxes
// Estructura: { "Angamos-1": { playlist: [], estadoReproduccion: 'idle', cancionActual: null, sessionId: '123' } }
const boxesState = {};

// Función auxiliar para obtener o inicializar el estado de un box
function getBoxState(sede, boxId) {
    const roomKey = `${sede}-${boxId}`;
    if (!boxesState[roomKey]) {
        boxesState[roomKey] = {
            sede,
            boxId,
            sessionId: Date.now().toString(), // ID único de la sesión actual
            estadoReproduccion: 'idle',
            cancionActual: null,
            playlist: [],
            tiempoActual: 0
        };
    }
    return boxesState[roomKey];
}

io.on('connection', (socket) => {
    console.log('Un usuario se ha conectado:', socket.id);

    // 1. UNIRSE A UN BOX (Mobile, TV o Admin)
    socket.on('unirse_box', ({ sede, boxId, tipo }) => {
        const roomKey = `${sede}-${boxId}`;
        socket.join(roomKey);
        console.log(`${tipo} se unió a la sala: ${roomKey}`);

        // Le enviamos el estado actual del box al instante
        const currentState = getBoxState(sede, boxId);
        socket.emit('estado_box_actualizado', currentState);
    });

    // 2. AGREGAR CANCIÓN (Desde el Móvil)
    socket.on('agregar_cancion', ({ sede, boxId, cancion, usuario }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);

        const nuevaCancion = {
            ...cancion,
            id: Date.now().toString(), // ID único para la lista
            agregadoPor: usuario
        };

        // Si no hay nada sonando, la ponemos directo; si no, a la cola
        if (!state.cancionActual) {
            state.cancionActual = nuevaCancion;
            state.estadoReproduccion = 'playing';
        } else {
            state.playlist.push(nuevaCancion);
        }

        // Avisamos a todos en el box (TV y celulares)
        io.to(roomKey).emit('estado_box_actualizado', state);
    });

    // 3. ELIMINAR CANCIÓN (Desde el Móvil)
    socket.on('eliminar_cancion', ({ sede, boxId, cancionId }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);

        state.playlist = state.playlist.filter(c => c.id !== cancionId);
        io.to(roomKey).emit('estado_box_actualizado', state);
    });

    // 4. REORDENAR PLAYLIST (Drag & Drop desde el Móvil)
    socket.on('reordenar_playlist', ({ sede, boxId, startIndex, endIndex }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);

        // Lógica para mover el elemento en el array
        const [removed] = state.playlist.splice(startIndex, 1);
        state.playlist.splice(endIndex, 0, removed);

        // Transmitir a todos menos al que hizo el movimiento para evitar parpadeos visuales
        socket.to(roomKey).emit('estado_box_actualizado', state);
    });

    // 5. CONTROLES DEL REPRODUCTOR (Play, Pause, Next)
    socket.on('comando_reproductor', ({ sede, boxId, comando, valor }) => {
        const roomKey = `${sede}-${boxId}`;
        const state = getBoxState(sede, boxId);

        if (comando === 'play') state.estadoReproduccion = 'playing';
        if (comando === 'pause') state.estadoReproduccion = 'paused';

        if (comando === 'next') {
            if (state.playlist.length > 0) {
                state.cancionActual = state.playlist.shift(); // Saca la primera de la cola
                state.estadoReproduccion = 'playing';
            } else {
                state.cancionActual = null;
                state.estadoReproduccion = 'idle';
            }
        }

        io.to(roomKey).emit('estado_box_actualizado', state);
    });

    // 6. ADMIN: REINICIAR BOX
    socket.on('admin_reiniciar_box', ({ sede, boxId }) => {
        const roomKey = `${sede}-${boxId}`;

        // Reseteamos el estado a cero y cambiamos el sessionId
        boxesState[roomKey] = {
            sede,
            boxId,
            sessionId: Date.now().toString(),
            estadoReproduccion: 'idle',
            cancionActual: null,
            playlist: [],
            tiempoActual: 0
        };

        // Avisamos a todos para que la TV se limpie y los celulares sean expulsados
        io.to(roomKey).emit('box_reiniciado');
        io.to(roomKey).emit('estado_box_actualizado', boxesState[roomKey]);
    });

    socket.on('disconnect', () => {
        console.log('Usuario desconectado:', socket.id);
    });
});

// Endpoint de prueba para verificar que el servidor está vivo
app.get('/', (req, res) => {
    res.send('Backend de PlaylistBoxes operativo 🚀');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});