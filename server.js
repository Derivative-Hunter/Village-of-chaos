const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};

const ROLE_CATEGORIES = {
    town: {
        'Koruma Köylüleri': ['Doktor', 'Uyutucu', 'Tuzakçı Köylü'],
        'Silahlı Köylüler': ['Vigilante', 'Başkan'],
        'Araştırmacı Köylüler': ['Ayakçı', 'Gözcü', 'Medyum', 'Casus', 'Kahin Köylü']
    },
    hain: {
        'Silahlı Hainler': ['Gizleyici', 'Düz Hain'],
        'Destekçi Hainler': ['Suikastçi', 'Gölge Ajanı', 'Susturucu', 'Büyücü Hain', 'Duyucu Hain'],
        'Hain Köylü': ['Hain Köylü']
    },
    neutral: {
        'Silahlı Tarafsızlar': ['Kundakçı', 'Seri Katil'],
        'Normal Tarafsızlar': ['Jester', 'Hırsız']
    }
};

const ALL_HAIN_ROLES = ['Gizleyici', 'Düz Hain', 'Suikastçi', 'Gölge Ajanı', 'Susturucu', 'Büyücü Hain', 'Duyucu Hain'];
const HAIN_KOYLU_ROLE = 'Hain Köylü';
const isHainPlayer = player => Boolean(player && (player.isHain || ALL_HAIN_ROLES.includes(player.role)));
const NON_VISITING_ROLES = ['Düz Köylü', 'Medyum', 'Casus', 'Başkan', 'Hırsız', 'Jester'];

const roleNames = group => Object.values(group).flat();
const TOWN_ROLES = ['Düz Köylü', ...roleNames(ROLE_CATEGORIES.town)];
const CONFIGURABLE_ROLE_NAMES = [
    ...roleNames(ROLE_CATEGORIES.town),
    ...roleNames(ROLE_CATEGORIES.hain).filter(role => role !== HAIN_KOYLU_ROLE),
    ...roleNames(ROLE_CATEGORIES.neutral),
    'Düz Köylü'
];
const isHainKoyluPlayer = player => Boolean(player && player.isHain && !ALL_HAIN_ROLES.includes(player.role));

function createRoomCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
}

function selectRandomUniqueRoles(rolePool, count, usedRoles) {
    return shuffle(rolePool.filter(roleName => !usedRoles.has(roleName))).slice(0, Math.max(0, count));
}

function assignCategoryRoles(room, shuffledPlayers, startIndex, categoryRoles, requestedCount, usedRoles) {
    const availablePlayers = Math.max(0, shuffledPlayers.length - startIndex);
    const count = Math.min(Math.max(0, parseInt(requestedCount) || 0), categoryRoles.length, availablePlayers);
    const selectedRoles = selectRandomUniqueRoles(categoryRoles, count, usedRoles);

    selectedRoles.forEach((roleName, offset) => {
        const player = room.players.find(player => player.id === shuffledPlayers[startIndex + offset].id);
        player.role = roleName;
        player.isHain = false;
        player.isAlive = true;
        player.ammo = roleName === 'Vigilante' ? 2 : 0;
        usedRoles.add(roleName);
    });

    return startIndex + selectedRoles.length;
}

function assignHainKoyluRoles(room, shuffledPlayers, startIndex, requestedCount, usedRoles) {
    const availablePlayers = Math.max(0, shuffledPlayers.length - startIndex);
    const count = Math.min(Math.max(0, parseInt(requestedCount) || 0), availablePlayers);
    const availableRoles = TOWN_ROLES.filter(role => !usedRoles.has(role));

    shuffle(availableRoles).slice(0, count).forEach((roleName, offset) => {
        const player = room.players.find(player => player.id === shuffledPlayers[startIndex + offset].id);
        player.role = roleName;
        player.isHain = true;
        player.isAlive = true;
        player.hasGun = false;
        player.ammo = roleName === 'Vigilante' ? 2 : 0;
        usedRoles.add(roleName);
    });

    return startIndex + Math.min(count, availableRoles.length);
}

function assignConfiguredRoles(room, shuffledPlayers, roleCounts) {
    const configuredRoles = CONFIGURABLE_ROLE_NAMES.flatMap(roleName =>
        Array.from({ length: Math.max(0, parseInt(roleCounts[roleName]) || 0) }, () => roleName)
    );
    const selectedRoles = shuffle(configuredRoles).slice(0, shuffledPlayers.length);

    selectedRoles.forEach((roleName, index) => {
        const player = room.players.find(candidate => candidate.id === shuffledPlayers[index].id);
        player.role = roleName;
        player.isHain = ALL_HAIN_ROLES.includes(roleName);
        player.isAlive = true;
        player.ammo = roleName === 'Vigilante' ? 2 : 0;
    });

    return selectedRoles.length;
}

function assignGuns(room) {
    const hains = room.players.filter(p => p.isAlive && ALL_HAIN_ROLES.includes(p.role));
    hains.forEach(h => h.hasGun = false);

    const priority = ['Gizleyici', 'Düz Hain', 'Duyucu Hain', 'Suikastçi', 'Gölge Ajanı', 'Susturucu', 'Büyücü Hain'];
    for (let roleName of priority) {
        const owner = hains.find(h => h.role === roleName);
        if (owner) {
            owner.hasGun = true;
            io.to(owner.id).emit('systemAnnounce', '[SİSTEM] 🔫 Silah senin elinde! Gece saldırısını sen gerçekleştireceksin.');
            break;
        }
    }
}

function sendGameState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.players.forEach(player => {
        const isHain = isHainPlayer(player);
        
        const playerListState = room.players.map(p => {
            const isAllyTraitor = isHain && isHainPlayer(p);
            return {
                id: p.id,
                username: p.username,
                isAlive: p.isAlive,
                role: (!p.isAlive && p.role && !p.roleHidden) ? p.role : null,
                isAllyTraitor: isAllyTraitor,
                isRevealed: p.isRevealed,
                isDoused: player.role === 'Kundakçı' && p.isDoused,
                shadowRole: player.shadowRole && player.shadowRole.targetId === p.id ? player.shadowRole.role : null
            };
        });

        io.to(player.id).emit('gameStateUpdate', {
            players: playerListState,
            wizardTargets: player.role === 'Büyücü Hain'
                ? room.players
                    .filter(p => p.isAlive && p.id !== player.id && !isHainPlayer(p))
                    .map(p => ({ id: p.id, username: p.username }))
                : [],
            phase: room.phase,
            timeLeft: room.timeLeft,
            dayNumber: room.dayNumber,
            defendantId: room.defendantId,
            hasGun: player.hasGun,
            jesterShield: player.jesterShield,
            isRevealed: player.isRevealed,
            hasStolen: player.hasStolen,
            hasAssassinated: player.hasAssassinated,
            isHain: player.isHain
        });
    });
}

io.on('connection', (socket) => {

    socket.on('createRoom', ({ username }) => {
        const roomCode = createRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            hostId: socket.id,
            players: [],
            phase: 'LOBBY',
            dayNumber: 1,
            trialCount: 0,
            timer: null,
            timeLeft: 0,
            votes: {},
            defendantId: null,
            judgmentVotes: {},
            nightActions: {},
            mutedPlayerId: null,
            hainKoyluCountdown: null,
            hainKoyluCountdownPending: false,
            settings: {
                randomTownCount: 0,
                randomHainCount: 0,
                randomNeutralCount: 0,
                korumaKoylusuCount: 0,
                silahliKoyluCount: 0,
                arastirmaciKoyluCount: 0,
                silahliHainCount: 1,
                destekciHainCount: 0,
                hainKoyluCount: 0,
                silahliTarafsizCount: 0,
                normalTarafsizCount: 0,
                dayTime: 25,
                voteTime: 20,
                defenseTime: 15,
                judgmentTime: 15,
                nightTime: 15
            }
        };

        socket.roomCode = roomCode;
        const player = { 
            id: socket.id, 
            username: username || 'Oyuncu 1', 
            isHost: true, 
            role: null, 
            isAlive: true,
            hasGun: false,
            ammo: 0,
            jesterShield: 1,
            isRevealed: false,
            isDoused: false,
            hasStolen: false,
            hasAssassinated: false,
            isHain: false,
            shadowRole: null,
            roleHidden: false
        };
        rooms[roomCode].players.push(player);

        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, player, settings: rooms[roomCode].settings });
        io.to(roomCode).emit('updatePlayerList', rooms[roomCode].players);
    });

    socket.on('joinRoom', ({ username, roomCode }) => {
        if (!roomCode) return socket.emit('errorMsg', 'Oda kodu giriniz!');
        const code = roomCode.trim().toUpperCase();
        const room = rooms[code];

        if (!room) return socket.emit('errorMsg', 'Oda bulunamadı!');
        if (room.phase !== 'LOBBY') return socket.emit('errorMsg', 'Oyun zaten başladı!');

        socket.roomCode = code;
        const player = { 
            id: socket.id, 
            username: username || 'Oyuncu', 
            isHost: false, 
            role: null, 
            isAlive: true,
            hasGun: false,
            ammo: 0,
            jesterShield: 1,
            isRevealed: false,
            isDoused: false,
            hasStolen: false,
            hasAssassinated: false,
            isHain: false,
            shadowRole: null,
            roleHidden: false
        };

        socket.join(code);
        socket.emit('joinedRoom', { roomCode: code, player, settings: room.settings });
        io.to(code).emit('updatePlayerList', room.players);
    });

    socket.on('updateSettings', ({ roomCode, settings }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room || room.hostId !== socket.id || room.phase !== 'LOBBY') return;

        room.settings = { ...room.settings, ...settings };
        io.to(code).emit('settingsUpdated', room.settings);
    });

    socket.on('returnToLobby', ({ roomCode } = {}) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room) return;

        if (room.timer) clearInterval(room.timer);
        room.phase = 'LOBBY';
        room.dayNumber = 1;
        room.trialCount = 0;
        room.votes = {};
        room.defendantId = null;
        room.judgmentVotes = {};
        room.nightActions = {};
        room.mutedPlayerId = null;
        room.hainKoyluCountdown = null;
        room.hainKoyluCountdownPending = false;

        if (!room.players.some(p => p.id === room.hostId)) {
            if (room.players.length > 0) room.hostId = room.players[0].id;
        }

        room.players.forEach(p => {
            p.role = null;
            p.isAlive = true;
            p.hasGun = false;
            p.ammo = 0;
            p.jesterShield = 1;
            p.isRevealed = false;
            p.isDoused = false;
            p.hasStolen = false;
            p.hasAssassinated = false;
            p.isHain = false;
            p.shadowRole = null;
            p.roleHidden = false;
            p.isHost = (p.id === room.hostId);
        });

        io.to(code).emit('returnedToLobby', { settings: room.settings, hostId: room.hostId });
        io.to(code).emit('updatePlayerList', room.players);
    });

    socket.on('startGame', ({ roomCode } = {}) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];

        if (!room) return socket.emit('errorMsg', 'Oda bulunamadı!');
        if (room.hostId !== socket.id) return socket.emit('errorMsg', 'Sadece oda kurucusu oyunu başlatabilir!');

        const totalPlayers = room.players.length;
        const cfg = room.settings;

        const shuffled = shuffle([...room.players]);
        let idx = 0;
        const usedRoles = new Set();

        const hasConfiguredRoles = Object.values(cfg.normalRoleCounts || {}).some(count => parseInt(count) > 0);
        if (hasConfiguredRoles) {
            idx = assignConfiguredRoles(room, shuffled, cfg.normalRoleCounts);
        } else {
            idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.hain['Silahlı Hainler'], cfg.silahliHainCount, usedRoles);
            idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.hain['Destekçi Hainler'], cfg.destekciHainCount, usedRoles);
            idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.neutral['Silahlı Tarafsızlar'], cfg.silahliTarafsizCount, usedRoles);
            idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.neutral['Normal Tarafsızlar'], cfg.normalTarafsizCount, usedRoles);
            idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.town['Koruma Köylüleri'], cfg.korumaKoylusuCount, usedRoles);
            idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.town['Silahlı Köylüler'], cfg.silahliKoyluCount, usedRoles);
            idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.town['Araştırmacı Köylüler'], cfg.arastirmaciKoyluCount, usedRoles);
        }
        idx = assignHainKoyluRoles(room, shuffled, idx, cfg.hainKoyluCount, usedRoles);

        while (idx < totalPlayers) {
            const player = room.players.find(x => x.id === shuffled[idx].id);
            player.role = 'Düz Köylü';
            player.isAlive = true;
            idx++;
        }

        assignGuns(room);

        room.players.forEach(p => {
            io.to(p.id).emit('yourRole', { role: p.role, isHain: p.isHain });
        });

        room.dayNumber = 1;
        room.trialCount = 0;
        room.mutedPlayerId = null;
        io.to(code).emit('gameStarted');
        io.to(code).emit('systemAnnounce', `[SİSTEM] ☀️ 1. Gün başladı! Toplam ${totalPlayers} oyuncu katıldı.`);
        startPhase(code, 'DAY', room.settings.dayTime);
        checkWinCondition(code);
    });

    socket.on('revealBaskan', ({ roomCode }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room) return;
        if (room.phase !== 'DAY' && room.phase !== 'VOTE') return socket.emit('errorMsg', 'Başkan sadece gündüz veya oylama sırasında kendini tanıtabilir!');
        if (room.dayNumber <= 1) return socket.emit('errorMsg', 'Başkan kendini 2. günden itibaren tanıtabilir!');

        const p = room.players.find(x => x.id === socket.id);
        if (p && p.isAlive && p.role === 'Başkan' && !p.isRevealed) {
            p.isRevealed = true;
            io.to(code).emit('systemAnnounce', `👑 [BAŞKAN] ${p.username} makamını açıklayarak kendini İFŞA ETTİ! Oy gücü artık 3!`);
            sendGameState(code);
        }
    });

    socket.on('suikastAction', ({ roomCode, targetId, guessedRole }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room || (room.phase !== 'DAY' && room.phase !== 'VOTE')) return;
        if (room.dayNumber <= 1) return socket.emit('errorMsg', 'Suikast eylemi 2. günden itibaren yapılabilir!');

        const actor = room.players.find(p => p.id === socket.id);
        if (!actor || !actor.isAlive || actor.role !== 'Suikastçi' || actor.hasAssassinated) return;

        const target = room.players.find(p => p.id === targetId);
        if (!target || !target.isAlive) return;

        actor.hasAssassinated = true;

        if (target.role === guessedRole) {
            target.isAlive = false;
            io.to(code).emit('systemAnnounce', `💀 [SUİKAST] ${target.username} gündüz vakti suikaste uğrayarak öldü! Rolü: GİZLİ`);
            checkGunPass(room, target);
        } else {
            actor.isAlive = false;
            io.to(code).emit('systemAnnounce', `💀 [SUİKAST] ${actor.username} yanlış tahminde bulunarak intihar etti! Rolü: Suikastçi`);
            checkGunPass(room, actor);
        }

        sendGameState(code);
        checkWinCondition(code);
    });

    socket.on('hirsizAction', ({ roomCode, targetId }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room || (room.phase !== 'DAY' && room.phase !== 'VOTE')) return;
        if (room.dayNumber <= 1) return socket.emit('errorMsg', 'Hırsız eylemi 2. günden itibaren yapılabilir!');

        const actor = room.players.find(p => p.id === socket.id);
        if (!actor || !actor.isAlive || actor.role !== 'Hırsız' || actor.hasStolen) return;

        const target = room.players.find(p => p.id === targetId);
        if (!target || !target.isAlive || target.id === socket.id) return;

        actor.hasStolen = true;
        const stolenRole = target.role;

        target.isAlive = false;
        io.to(code).emit('systemAnnounce', `💀 [HIRSIZ] ${target.username} gündüz vakti vuruldu! Rolü: GİZLİ`);
        checkGunPass(room, target);

        actor.role = stolenRole;
        actor.isHain = Boolean(target.isHain);
        actor.ammo = stolenRole === 'Vigilante' && actor.isHain ? 2 : (stolenRole === 'Vigilante' ? 2 : 0);
        actor.hasGun = false;
        if (target.isDoused) {
            actor.isDoused = true;
            target.isDoused = false;
            io.to(actor.id).emit('chatMessage', { sender: '[KUNDAKÇI]', text: '🔥 Çaldığın kişinin evi yağlanmıştı! Artık yağlandığını biliyorsun.', type: 'green' });
        }
        assignGuns(room);
        io.to(actor.id).emit('yourRole', { role: actor.role, isHain: actor.isHain });
        io.to(actor.id).emit('systemAnnounce', `[SİSTEM] 🎭 ${target.username} adlı kişinin rolünü çaldın! Yeni rolün: ${stolenRole}`);

        sendGameState(code);
        checkWinCondition(code);
    });

    socket.on('sendMessage', ({ roomCode, text }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room || !text || !text.trim()) return;

        const sender = room.players.find(p => p.id === socket.id);
        if (!sender) return;

        if (room.mutedPlayerId === socket.id && room.phase !== 'NIGHT') {
            return socket.emit('errorMsg', '🤐 Gece Susturucu tarafından susturuldunuz! Bugün konuşamazsınız.');
        }

        if (!sender.isAlive) {
            const deads = room.players.filter(p => !p.isAlive);
            deads.forEach(p => io.to(p.id).emit('chatMessage', { sender: sender.username, text, type: 'dead' }));
            
            const mediums = room.players.filter(p => p.isAlive && p.role === 'Medyum');
            mediums.forEach(m => io.to(m.id).emit('chatMessage', { sender: `🔮 ${sender.username}`, text, type: 'dead' }));
            const listeners = room.players.filter(p => p.isAlive && p.role === 'Duyucu Hain');
            listeners.forEach(listener => io.to(listener.id).emit('chatMessage', { sender: sender.username, text, type: 'dead' }));
            return;
        }

        if (sender.role === 'Duyucu Hain' && text.startsWith('/ölüler ') && room.phase !== 'NIGHT') {
            return socket.emit('errorMsg', 'Ölülerle sohbet yalnızca gece yapılabilir!');
        }

        if (text.startsWith('/fısıltı ')) {
            if (room.phase === 'NIGHT') return socket.emit('errorMsg', 'Gece vakti fısıldaşamazsınız!');
            const content = text.substring(9).trim();
            const firstSpace = content.indexOf(' ');
            if (firstSpace === -1) return socket.emit('errorMsg', 'Kullanım: /fısıltı [İsim] [Mesaj]');

            const targetName = content.substring(0, firstSpace).trim();
            const whisperMsg = content.substring(firstSpace + 1).trim();

            const targetPlayer = room.players.find(p => p.username.toLowerCase() === targetName.toLowerCase());

            if (!targetPlayer) return socket.emit('errorMsg', `"${targetName}" isimli oyuncu bulunamadı!`);
            if (!targetPlayer.isAlive) return socket.emit('errorMsg', 'Ölü bir oyuncuya fısıldayamazsınız!');
            if (targetPlayer.id === socket.id) return socket.emit('errorMsg', 'Kendinize fısıldayamazsınız!');

            socket.emit('chatMessage', { sender: `Sen ➔ ${targetPlayer.username} (Fısıltı)`, text: whisperMsg, type: 'whisper' });
            io.to(targetPlayer.id).emit('chatMessage', { sender: `${sender.username} (Fısıltı)`, text: whisperMsg, type: 'whisper' });

            const spies = room.players.filter(p => p.isAlive && p.role === 'Casus' && p.id !== socket.id && p.id !== targetPlayer.id);
            spies.forEach(spy => {
                io.to(spy.id).emit('chatMessage', { sender: `🕵️ ${sender.username} ➔ ${targetPlayer.username}`, text: whisperMsg, type: 'spy' });
            });
            const duyucus = room.players.filter(p => p.isAlive && p.role === 'Duyucu Hain' && p.id !== socket.id);
            duyucus.forEach(duyucu => {
                io.to(duyucu.id).emit('chatMessage', { sender: `👂 ${sender.username} ➔ ${targetPlayer.username}`, text: whisperMsg, type: 'spy' });
            });
            return;
        }

        if (room.phase === 'NIGHT') {
            if (sender.role === 'Duyucu Hain' && text.startsWith('/hainler ')) {
                const hainText = text.substring(9).trim();
                if (!hainText) return;
                room.players.filter(p => p.isAlive && isHainPlayer(p)).forEach(p => io.to(p.id).emit('chatMessage', { sender: sender.username, text: hainText, type: 'hain' }));
                return;
            }
            if (sender.role === 'Duyucu Hain' && text.startsWith('/ölüler ')) {
                const deadText = text.substring(8).trim();
                if (!deadText) return;
                room.players.filter(p => !p.isAlive).forEach(p => io.to(p.id).emit('chatMessage', { sender: 'Gizemli Hain', text: deadText, type: 'dead' }));
                socket.emit('chatMessage', { sender: 'Duyucu', text: deadText, type: 'dead' });
                return;
            }
            if (isHainPlayer(sender)) {
                const hains = room.players.filter(p => isHainPlayer(p));
                hains.forEach(p => io.to(p.id).emit('chatMessage', { sender: sender.username, text, type: 'hain' }));
            } else if (sender.role === 'Duyucu Hain') {
                room.players.filter(p => !p.isAlive).forEach(p => io.to(p.id).emit('chatMessage', { sender: 'Duyucu', text, type: 'dead' }));
            } else {
                socket.emit('errorMsg', 'Gece genel sohbet kapalıdır!');
            }
            return;
        }

        io.to(code).emit('chatMessage', { sender: sender.username, text, type: 'general' });
    });

    socket.on('castVote', ({ roomCode, targetId }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room || room.phase !== 'VOTE') return;

        const voter = room.players.find(p => p.id === socket.id);
        if (voter && voter.isAlive) {
            room.votes[socket.id] = targetId;
            const targetPlayer = room.players.find(p => p.id === targetId);
            const targetName = targetId === 'PAS' ? 'PAS' : (targetPlayer ? targetPlayer.username : 'Bilinmeyen');
            socket.emit('actionConfirmed', { targetId, targetName });
        }
    });

    socket.on('castJudgment', ({ roomCode, verdict }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room || room.phase !== 'JUDGMENT') return;

        const voter = room.players.find(p => p.id === socket.id);
        if (voter && voter.isAlive && socket.id !== room.defendantId) {
            room.judgmentVotes[socket.id] = verdict;
            socket.emit('judgmentConfirmed', verdict);
        }
    });

    socket.on('nightAction', ({ roomCode, targetId, actionType }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        if (!room || room.phase !== 'NIGHT') return;

        const actor = room.players.find(p => p.id === socket.id);
        if (actor && actor.isAlive) {
            if (['Düz Köylü', 'Medyum', 'Casus', 'Başkan'].includes(actor.role)) return;
            if (actor.role === 'Hırsız') return socket.emit('errorMsg', 'Hırsız gece eylemi yapamaz!');
            if (actor.role === 'Suikastçi' && !actor.hasGun) {
                return socket.emit('errorMsg', 'Silahın yoksa gece eylemi yapamazsın!');
            }
            if (actor.role === 'Vigilante' && actor.ammo <= 0) {
                return socket.emit('errorMsg', 'Mermin kalmadı!');
            }
            
            if (!room.nightActions) room.nightActions = {};
            room.nightActions[socket.id] = { role: actor.role, targetId, actionType };

            const targetPlayer = room.players.find(p => p.id === targetId);
            const targetName = targetId === 'IGNITE' ? '🔥 HERKESİ YAK' : (targetPlayer ? targetPlayer.username : 'Bilinmeyen');
            socket.emit('actionConfirmed', { targetId, targetName });
        }
    });

    socket.on('wizardAction', ({ roomCode, powerRole, targetId }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        const actor = room && room.players.find(p => p.id === socket.id);
        if (!room || room.phase !== 'NIGHT' || !actor || !actor.isAlive || actor.role !== 'Büyücü Hain') return;
        if (actor.hasGun) return socket.emit('errorMsg', 'Silah sende; bu gece yalnız saldırı yapabilirsin!');
        if (!powerRole || !targetId) return socket.emit('errorMsg', 'Önce kontrol edilecek kişiyi ve hedefi seçin!');
        const controlled = room.players.find(p => p.id === powerRole && p.isAlive);
        const target = room.players.find(p => p.id === targetId && p.isAlive);
        if (!controlled || isHainPlayer(controlled) || controlled.id === actor.id || controlled.role === 'Kundakçı') {
            return socket.emit('errorMsg', controlled && controlled.role === 'Kundakçı' ? '🛢️ Kundakçı bu gece evinden çıkmadı.' : 'Bu kişi kontrol edilemez!');
        }
        if (!target || target.id === actor.id || target.id === controlled.id || isHainPlayer(target)) return socket.emit('errorMsg', 'Hain arkadaşların, kendin veya kontrol ettiğin kişi hedef olamaz!');
        room.nightActions[socket.id] = { role: actor.role, actionType: 'WIZARD', targetId, controlledId: controlled.id, controlledRole: controlled.role };
        socket.emit('actionConfirmed', { targetId, targetName: target.username });
        socket.emit('chatMessage', { sender: '[BÜYÜCÜ HAIN]', text: `${controlled.role} gücünü ${target.username} kişisine karşı kullandın.`, type: 'green' });
    });

    socket.on('disconnect', () => {
        const code = socket.roomCode;
        if (code && rooms[code]) {
            rooms[code].players = rooms[code].players.filter(p => p.id !== socket.id);
            if (socket.id === rooms[code].hostId && rooms[code].players.length > 0) {
                rooms[code].hostId = rooms[code].players[0].id;
                rooms[code].players[0].isHost = true;
            }
            io.to(code).emit('updatePlayerList', rooms[code].players);
        }
    });
});

function startPhase(roomCode, phase, seconds) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.timer) clearInterval(room.timer);

    room.phase = phase;
    room.timeLeft = seconds;

    if (phase === 'DAY') {
        room.players.forEach(player => {
            if (player.role === 'Suikastçi') player.hasAssassinated = false;
        });
        updateHainKoyluCountdown(roomCode);
    }

    sendGameState(roomCode);

    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', room.timeLeft);

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            nextPhase(roomCode);
        }
    }, 1000);
}

function isOnlyHainKoylu(room) {
    const alivePlayers = room.players.filter(player => player.isAlive);
    const aliveHainTeam = alivePlayers.filter(isHainPlayer);
    const aliveHainKoylu = alivePlayers.filter(isHainKoyluPlayer);
    return aliveHainKoylu.length === 1 && aliveHainTeam.length === 1;
}

function updateHainKoyluCountdown(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'DAY' || !isOnlyHainKoylu(room)) return;

    if (room.hainKoyluCountdown == null && room.hainKoyluCountdownPending) {
        room.hainKoyluCountdown = 3;
        room.hainKoyluCountdownPending = false;
        io.to(roomCode).emit('systemAnnounce', '[SİSTEM] ⚠️ 3 gün içinde hain köylüyü bulun!');
    } else if (room.hainKoyluCountdown > 1) {
        room.hainKoyluCountdown--;
        io.to(roomCode).emit('systemAnnounce', `[SİSTEM] ⚠️ Hain köylüyü bulun! Kalan gün: ${room.hainKoyluCountdown}`);
    }
}

function endHainKoyluGame(roomCode) {
    const room = rooms[roomCode];
    const winner = room && room.players.find(player => player.isAlive && isHainKoyluPlayer(player));
    if (!room || !winner) return false;

    clearInterval(room.timer);
    sendGameState(roomCode);
    io.to(roomCode).emit('gameOver', { winner: 'HAİN KÖYLÜ', msg: `🎉 ${winner.username} hain köylü olarak üç günlük sayacı tamamladı ve kazandı!` });
    return true;
}

function checkHainKoyluBeforeNight(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.hainKoyluCountdown !== 1 || !isOnlyHainKoylu(room)) return false;
    return endHainKoyluGame(roomCode);
}

function nextPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.dayNumber === 1 && room.phase === 'DAY') {
        goToNight(roomCode);
        return;
    }

    if (room.phase === 'DAY') {
        room.trialCount = 0;
        startVotePhase(roomCode);

    } else if (room.phase === 'VOTE') {
        evaluateVoteResult(roomCode);

    } else if (room.phase === 'DEFENSE') {
        room.judgmentVotes = {};
        io.to(roomCode).emit('systemAnnounce', '[SİSTEM] ⚖️ Savunma süresi doldu! Karar vakti: Suçlu mu, Suçsuz mu?');
        startPhase(roomCode, 'JUDGMENT', room.settings.judgmentTime);

    } else if (room.phase === 'JUDGMENT') {
        evaluateJudgmentResult(roomCode);

    } else if (room.phase === 'NIGHT') {
        calculateNightResult(roomCode);
        if (checkWinCondition(roomCode)) return;

        room.dayNumber++;
        room.defendantId = null;
        io.to(roomCode).emit('phaseChangeClearTarget');
        io.to(roomCode).emit('systemAnnounce', `[SİSTEM] ☀️ Gün ${room.dayNumber} başladı! Kasaba uyandı.`);
        startPhase(roomCode, 'DAY', room.settings.dayTime);
    }
}

function startVotePhase(roomCode) {
    const room = rooms[roomCode];
    room.votes = {};
    room.defendantId = null;
    io.to(roomCode).emit('phaseChangeClearTarget');
    io.to(roomCode).emit('systemAnnounce', `[SİSTEM] 🗳️ Oylama başladı (${room.settings.voteTime}s).`);
    startPhase(roomCode, 'VOTE', room.settings.voteTime);
}

function evaluateVoteResult(roomCode) {
    const room = rooms[roomCode];
    const voteCounts = {};

    Object.entries(room.votes).forEach(([voterId, targetId]) => {
        const voter = room.players.find(p => p.id === voterId);
        const weight = (voter && voter.role === 'Başkan' && voter.isRevealed) ? 3 : 1;
        voteCounts[targetId] = (voteCounts[targetId] || 0) + weight;
    });

    let maxVotes = 0;
    let selectedTarget = null;
    let tie = false;

    Object.entries(voteCounts).forEach(([targetId, count]) => {
        if (count > maxVotes) {
            maxVotes = count;
            selectedTarget = targetId;
            tie = false;
        } else if (count === maxVotes) {
            tie = true;
        }
    });

    if (!selectedTarget || selectedTarget === 'PAS' || tie || maxVotes === 0) {
        if (checkHainKoyluBeforeNight(roomCode)) return;
        io.to(roomCode).emit('systemAnnounce', '[SİSTEM] Yeterli çoğunluk sağlanamadı / Geçildi. Geceye geçiliyor.');
        goToNight(roomCode);
    } else {
        const defendant = room.players.find(p => p.id === selectedTarget);
        if (defendant && defendant.isAlive) {
            room.defendantId = defendant.id;
            io.to(roomCode).emit('systemAnnounce', `[SİSTEM] ${defendant.username} sanık kürsüsünde. Oylayınız.`);
            startPhase(roomCode, 'DEFENSE', room.settings.defenseTime);
        } else {
            if (checkHainKoyluBeforeNight(roomCode)) return;
            goToNight(roomCode);
        }
    }
}

function evaluateJudgmentResult(roomCode) {
    const room = rooms[roomCode];
    const guiltyList = [];
    const innocentList = [];
    let guiltyVotes = 0;
    let innocentVotes = 0;

    const eligibleVoters = room.players.filter(p => p.isAlive && p.id !== room.defendantId);

    eligibleVoters.forEach(voter => {
        const verdict = room.judgmentVotes[voter.id];
        const weight = (voter.role === 'Başkan' && voter.isRevealed) ? 3 : 1;
        if (verdict === 'GUILTY') {
            guiltyList.push(voter.username);
            guiltyVotes += weight;
        } else if (verdict === 'INNOCENT') {
            innocentList.push(voter.username);
            innocentVotes += weight;
        }
    });

    const defendant = room.players.find(p => p.id === room.defendantId);

    if (guiltyVotes > innocentVotes) {
        if (defendant) {
            defendant.isAlive = false;
            io.to(roomCode).emit('systemAnnounce', `[SİSTEM] ⚖️ Duruşma Sonucu: ${guiltyVotes} Suçlu / ${innocentVotes} Suçsuz. ${defendant.username} İDAM EDİLDİ! Rolü: ${defendant.role}`);
            
            checkGunPass(room, defendant);

            if (defendant.role === 'Jester') {
                clearInterval(room.timer);
                sendGameState(roomCode);
                io.to(roomCode).emit('gameOver', { winner: 'JESTER', msg: `🎉 ${defendant.username} kendini astırmayı başardı ve Jester olarak kazandı!` });
                return;
            }
        }
        if (checkWinCondition(roomCode)) return;
        if (checkHainKoyluBeforeNight(roomCode)) return;
        goToNight(roomCode);
    } else {
        io.to(roomCode).emit('systemAnnounce', `[SİSTEM] ⚖️ Duruşma Sonucu: ${guiltyVotes} Suçlu / ${innocentVotes} Suçsuz. ${defendant ? defendant.username : 'Sanık'} serbest kaldı.`);
        
        room.defendantId = null; 
        room.trialCount++;

        if (room.trialCount < 3) {
            startVotePhase(roomCode);
        } else {
            io.to(roomCode).emit('systemAnnounce', '[SİSTEM] Bugünkü oylama hakkı bitti. Geceye geçiliyor.');
            if (checkHainKoyluBeforeNight(roomCode)) return;
            goToNight(roomCode);
        }
    }
}

function goToNight(roomCode) {
    const room = rooms[roomCode];
    room.nightActions = {};
    room.players.forEach(player => {
        player.shadowRole = null;
    });
    room.defendantId = null;
    io.to(roomCode).emit('phaseChangeClearTarget');
    io.to(roomCode).emit('systemAnnounce', '[SİSTEM] 🌙 Gece çöktü...');
    startPhase(roomCode, 'NIGHT', room.settings.nightTime);
}

function calculateNightResult(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const actions = room.nightActions || {};
    room.mutedPlayerId = null;

    Object.entries(actions).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (!actor || !actor.isAlive || actor.role !== 'Uyutucu') return;

        const target = room.players.find(p => p.id === act.targetId);
        if (!target) return;

        if (target.role === 'Seri Katil') {
            io.to(actor.id).emit('chatMessage', { sender: '[UYUTUCU]', text: '💤 Eylemin işlemedi.', type: 'green' });
        } else if (!actions[target.id] || !actions[target.id].targetId) {
            io.to(actor.id).emit('chatMessage', { sender: '[UYUTUCU]', text: '💤 Eylemin işlemedi.', type: 'green' });
        } else if (target.role === 'Kundakçı' && actions[target.id].targetId === 'IGNITE') {
            io.to(actor.id).emit('chatMessage', { sender: '[UYUTUCU]', text: '🔥 Kundakçının yakma eylemi durdurulamaz.', type: 'green' });
        } else {
            delete actions[target.id];
            io.to(actor.id).emit('chatMessage', { sender: '[UYUTUCU]', text: '💤 Eylemin işledi.', type: 'green' });
        }
    });

    Object.entries(actions).forEach(([actorId, act]) => {
        if (act.actionType !== 'WIZARD') return;
        const controlled = room.players.find(p => p.id === act.controlledId);
        if (!controlled || !controlled.isAlive) return;
        const wizard = room.players.find(p => p.id === actorId);
        const controlledAction = actions[controlled.id];
        if (NON_VISITING_ROLES.includes(controlled.role) || !controlledAction || controlledAction.actionType === 'WIZARD') {
            if (wizard) io.to(wizard.id).emit('chatMessage', { sender: '[BÜYÜCÜ HAIN]', text: `🪄 ${controlled.role} gücünü ${controlled.username} kişisine karşı kullandın; bu rol bu gece evinden çıkamadığı için etkisi olmadı.`, type: 'green' });
            delete actions[controlled.id];
            actions[controlled.id] = { role: controlled.role, targetId: null, controlledBy: actorId, noVisit: true };
            return;
        }
        io.to(controlled.id).emit('chatMessage', { sender: '[SİSTEM]', text: '🪄 Bu gece gücün ele geçirildi. Kontrol edildin ve eylemini yapamadın.', type: 'green' });
        delete actions[controlled.id];
        actions[controlled.id] = {
            role: act.controlledRole,
            targetId: act.targetId,
            controlledBy: actorId
        };
    });

    let docTarget = null, docActor = null;
    let skTarget = null;
    let hainTarget = null, hainActor = null;
    let vigTarget = null, vigActor = null;
    let silencerTarget = null;
    let gozcuTarget = null, gozcuActor = null;
    let ayakciTarget = null, ayakciActor = null;
    let arsoIgnite = false, arsoDouseTarget = null, arsoActor = null;
    let shadowTarget = null, shadowActor = null;
    let kahinTarget = null, kahinActor = null;
    const trapTargets = new Set();

    Object.entries(actions).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (actor && actor.isAlive && actor.role === 'Tuzakçı Köylü' && act.targetId) {
            trapTargets.add(act.targetId);
        }
    });

    Object.entries(actions).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (!actor || !actor.isAlive || !act.targetId || !trapTargets.has(act.targetId)) return;
        if (!['Seri Katil', 'Kundakçı'].includes(actor.role) && actor.role !== 'Tuzakçı Köylü') {
            act.blockedByTrap = true;
            io.to(actor.id).emit('chatMessage', { sender: '[TUZAKÇI]', text: '🪤 Gittiğin evdeki tuzak eylemini engelledi.', type: 'green' });
        }
    });

    Object.entries(actions).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (!actor || !actor.isAlive || act.blockedByTrap) return;

        if (act.controlledBy && act.role === 'Seri Katil') skTarget = act.targetId;
        else if (act.controlledBy && (ALL_HAIN_ROLES.includes(act.role) || act.role === HAIN_KOYLU_ROLE)) {
            hainTarget = act.targetId;
            hainActor = actor;
        }
        else if (act.controlledBy && act.role === 'Vigilante') {
            vigTarget = act.targetId;
            vigActor = actor;
        }
        else if (actor.role === 'Doktor') { docTarget = act.targetId; docActor = actor; }
        else if (actor.role === 'Gölge Ajanı' && !actor.hasGun) { shadowTarget = act.targetId; shadowActor = actor; }
        else if (actor.role === 'Kahin Köylü') { kahinTarget = act.targetId; kahinActor = actor; }
        else if (actor.role === 'Seri Katil') skTarget = act.targetId;
        else if (actor.hasGun && ALL_HAIN_ROLES.includes(actor.role)) {
            hainTarget = act.targetId;
            hainActor = actor;
        }
        else if (actor.role === 'Susturucu' && !actor.hasGun) silencerTarget = act.targetId;
        else if (actor.role === 'Vigilante' && actor.ammo > 0) {
            vigTarget = act.targetId;
            vigActor = actor;
            actor.ammo--;
        }
        else if (actor.role === 'Gözcü') { gozcuTarget = act.targetId; gozcuActor = actor; }
        else if (actor.role === 'Ayakçı') { ayakciTarget = act.targetId; ayakciActor = actor; }
        else if (actor.role === 'Kundakçı') {
            if (act.targetId === 'IGNITE') arsoIgnite = true;
            else arsoDouseTarget = act.targetId;
            arsoActor = actor;
        }
        else if (actor.role === 'Jester' && act.targetId === actor.id) {
            if (actor.jesterShield > 0) actor.jesterShieldProtected = true;
        }
    });

    if (docActor && docTarget) {
        const healedPlayer = room.players.find(p => p.id === docTarget);
        if (healedPlayer) {
            io.to(docActor.id).emit('chatMessage', { sender: '[DOKTOR]', text: `${healedPlayer.username} adlı kişiyi iyileştirdin.`, type: 'green' });
        }
    }

    if (silencerTarget) {
        room.mutedPlayerId = silencerTarget;
        io.to(silencerTarget).emit('chatMessage', { sender: '[SUSTURUCU]', text: '🤐 Gece bir Susturucu tarafından hedef alındınız! Yarın konuşamayacaksınız.', type: 'green' });
    }

    if (arsoActor && arsoDouseTarget && !arsoIgnite) {
        const dTarget = room.players.find(p => p.id === arsoDouseTarget);
        if (dTarget && dTarget.isAlive) {
            dTarget.isDoused = true;
            io.to(arsoActor.id).emit('chatMessage', { sender: '[KUNDAKÇI]', text: `🔥 ${dTarget.username} adlı kişinin evi yağlandı.`, type: 'green' });
        }
    }

    let killedList = [];

    if (arsoIgnite) {
        const dousedPlayers = room.players.filter(p => p.isAlive && p.isDoused && p.id !== arsoActor.id);
        const visitorsToDoused = Object.entries(actions)
            .filter(([actorId, act]) => act.targetId && !act.noVisit && dousedPlayers.some(target => target.id === act.targetId) && actorId !== arsoActor.id)
            .map(([actorId]) => room.players.find(p => p.id === actorId))
            .filter(p => p && p.isAlive && p.id !== arsoActor.id);
        const arsoVictims = [...new Set([...dousedPlayers, ...visitorsToDoused])];
        arsoVictims.forEach(v => {
            v.isAlive = false;
            killedList.push({ player: v, killer: 'Kundakçı', hiddenRole: false });
            checkGunPass(room, v);
        });
    }

    function getAttackPriority(player) {
        if (!player) return 0;
        if (player.role === 'Kundakçı') return 4;
        if (player.role === 'Seri Katil') return 3;
        if (ALL_HAIN_ROLES.includes(player.role)) return 2;
        if (player.role === 'Vigilante') return 1;
        return 0;
    }

    function processAttack(attacker, targetId, killerName) {
        if (!attacker || !attacker.isAlive || !targetId) return;
        const victim = room.players.find(p => p.id === targetId);
        if (!victim || !victim.isAlive) return;

        const canKillKundakci = ['Gizleyici', 'Seri Katil'].includes(attacker.role);
        const isKundakciTarget = victim.role === 'Kundakçı';
        if (isKundakciTarget && !canKillKundakci) {
            io.to(attacker.id).emit('chatMessage', { sender: '[SİSTEM]', text: '🛡️ Hedefin korundu (Doktor/Kalkan).', type: 'green' });
            return;
        }

        const attackerPriority = getAttackPriority(attacker);
        const victimPriority = getAttackPriority(victim);
        if (!(isKundakciTarget && canKillKundakci) && victimPriority > attackerPriority && victimPriority > 0 && attackerPriority > 0) {
            attacker.isAlive = false;
            killedList.push({ player: attacker, killer: victim.role, hiddenRole: false });
            checkGunPass(room, attacker);
            return;
        }

        let protectedByDoc = (docTarget === targetId);
        let protectedByJester = (victim.role === 'Jester' && victim.jesterShieldProtected);

        if (protectedByDoc || protectedByJester) {
            if (attacker) {
                io.to(attacker.id).emit('chatMessage', { sender: '[SİSTEM]', text: '🛡️ Hedefin korundu (Doktor/Kalkan).', type: 'green' });
            }
            if (protectedByJester) {
                victim.jesterShield--;
                victim.jesterShieldProtected = false;
            }
        } else {
            victim.isAlive = false;
            let hideRole = (attacker && attacker.role === 'Gizleyici');
            victim.roleHidden = hideRole;
            killedList.push({ player: victim, killer: killerName, hiddenRole: hideRole });
            checkGunPass(room, victim);

            if (killerName === 'Vigilante' && !attacker.isHain && !isHainPlayer(victim) && ![...ALL_HAIN_ROLES, 'Seri Katil'].includes(victim.role)) {
                attacker.isAlive = false;
                killedList.push({ player: attacker, killer: 'Vicdan Azabı (İntihar)', hiddenRole: false });
                checkGunPass(room, attacker);
            }
        }
    }

    if (skTarget) processAttack(room.players.find(p => p.role === 'Seri Katil'), skTarget, 'Seri Katil');
    if (hainActor && hainTarget) processAttack(hainActor, hainTarget, hainActor.role === 'Gizleyici' ? 'Gizleyici' : 'Hainler');
    if (vigActor && vigTarget) processAttack(vigActor, vigTarget, 'Vigilante');

    if (killedList.length === 0) {
        io.to(roomCode).emit('systemAnnounce', '[SİSTEM] 🛡️ Bu gece kimse ölmedi.');
    } else {
        killedList.forEach(k => {
            const roleStr = k.hiddenRole ? 'GİZLİ' : k.player.role;
            io.to(roomCode).emit('systemAnnounce', `[SİSTEM] 💀 ${k.player.username} katledildi! Rolü: ${roleStr} (${k.killer} tarafından)`);
        });
    }

    if (gozcuActor && gozcuActor.isAlive && gozcuTarget) {
        const visitors = Object.entries(actions)
            .filter(([aId, act]) => act.targetId === gozcuTarget && !act.noVisit && aId !== gozcuActor.id)
            .map(([aId]) => room.players.find(p => p.id === aId))
            .filter(p => p && p.role !== 'Seri Katil')
            .map(p => p.username);

        const targetP = room.players.find(p => p.id === gozcuTarget);
        const reportText = visitors.length > 0 
            ? `🔍 Gözcü Raporu: Bu gece ${targetP ? targetP.username : 'Hedef'} kişisinin evine gidenler: ${visitors.join(', ')}`
            : `🔍 Gözcü Raporu: Bu gece ${targetP ? targetP.username : 'Hedef'} kişisinin evine kimse gitmedi.`;

        io.to(gozcuActor.id).emit('chatMessage', { sender: '[GÖZCÜ RAPORU]', text: reportText, type: 'green' });
    }

    if (ayakciActor && ayakciActor.isAlive && ayakciTarget) {
        const visitedAct = actions[ayakciTarget];
        const targetP = room.players.find(p => p.id === ayakciTarget);
        let reportText = '';

        if (visitedAct && !visitedAct.noVisit && visitedAct.targetId && targetP && targetP.role !== 'Seri Katil') {
            const destP = room.players.find(p => p.id === visitedAct.targetId);
            reportText = `👟 Ayakçı Raporu: ${targetP.username} bu gece ${destP ? destP.username : 'Bilinmeyen'} kişisinin evine gitti.`;
        } else {
            reportText = `👟 Ayakçı Raporu: ${targetP ? targetP.username : 'Hedef'} bu gece evinden dışarı çıkmadı.`;
        }

        io.to(ayakciActor.id).emit('chatMessage', { sender: '[AYAKÇI RAPORU]', text: reportText, type: 'green' });
    }

    if (shadowActor && shadowActor.isAlive && shadowTarget) {
        const target = room.players.find(p => p.id === shadowTarget);
        if (target) {
            shadowActor.shadowRole = { targetId: target.id, role: target.role };
            io.to(shadowActor.id).emit('chatMessage', { sender: '[GÖLGE AJANI]', text: `🌑 ${target.username} adlı kişinin rolünü öğrendin: ${target.role}. Sabah evinin üstünde görünecek.`, type: 'green' });
        }
    }

    if (kahinActor && kahinActor.isAlive && kahinTarget) {
        const target = room.players.find(p => p.id === kahinTarget);
        const visitorRoles = Object.entries(actions)
            .filter(([actorId, act]) => act.targetId === kahinTarget && !act.noVisit && actorId !== kahinActor.id)
            .map(([actorId]) => room.players.find(p => p.id === actorId))
            .filter(p => p)
            .map(p => p.role)
            .filter((role, index, roles) => roles.indexOf(role) === index);
        const reportText = visitorRoles.length > 0
            ? `🔮 ${target ? target.username : 'Hedef'} kişisinin evine gelen roller: ${visitorRoles.join(', ')}`
            : `🔮 ${target ? target.username : 'Hedef'} kişisinin evine bu gece kimse gelmedi.`;
        io.to(kahinActor.id).emit('chatMessage', { sender: '[KAHİN KÖYLÜ RAPORU]', text: reportText, type: 'green' });
    }
}

function checkGunPass(room, deadPlayer) {
    if (deadPlayer.hasGun) {
        deadPlayer.hasGun = false;
        assignGuns(room);
    }
}

function checkWinCondition(roomCode) {
    const room = rooms[roomCode];
    if (!room) return false;

    const alivePlayers = room.players.filter(p => p.isAlive);
    const aliveHain = alivePlayers.filter(p => p.role && ALL_HAIN_ROLES.includes(p.role));
    const aliveHainKoylu = alivePlayers.filter(isHainKoyluPlayer);
    const aliveHainTeam = alivePlayers.filter(isHainPlayer);
    const aliveSK = alivePlayers.filter(p => p.role === 'Seri Katil');
    const aliveKundakci = alivePlayers.filter(p => p.role === 'Kundakçı');
    const aliveBaskan = alivePlayers.filter(p => p.role === 'Başkan');

    const baskanBlocksWin = aliveBaskan.length > 0;
    const aliveEvils = [...aliveHain, ...aliveHainKoylu, ...aliveSK, ...aliveKundakci];

    if (aliveHainKoylu.length === 1 && aliveHainTeam.length === 1) {
        if (room.hainKoyluCountdown == null) room.hainKoyluCountdownPending = true;
        if (room.phase === 'DAY' && room.hainKoyluCountdownPending) {
            updateHainKoyluCountdown(roomCode);
        }
    } else {
        room.hainKoyluCountdown = null;
        room.hainKoyluCountdownPending = false;
    }

    // 1. Berabere (Herkes Öldü)
    if (alivePlayers.length === 0) {
        clearInterval(room.timer);
        sendGameState(roomCode);
        io.to(roomCode).emit('gameOver', { winner: 'BERABERE', msg: '🤝 Herkes öldü! Oyun berabere sonuçlandı.' });
        return true;
    }

    // 2. Kasaba Zaferi (Tüm tehditler yok edildi)
    if (aliveEvils.length === 0) {
        clearInterval(room.timer);
        sendGameState(roomCode);
        io.to(roomCode).emit('gameOver', { winner: 'KASABA', msg: '🎉 Bütün hainler ve tehditler yok edildi! Kasaba kazandı!' });
        return true;
    }

    // 3. Kundakçı Zaferi
    if (aliveKundakci.length > 0 && aliveHain.length === 0 && aliveSK.length === 0 && alivePlayers.length <= 2) {
        clearInterval(room.timer);
        sendGameState(roomCode);
        io.to(roomCode).emit('gameOver', { winner: 'KUNDAKÇI', msg: '🔥 Kundakçı köyü küle çevirdi ve tek başına kazandı!' });
        return true;
    }

    // 4. Seri Katil Zaferi
    if (aliveSK.length > 0 && aliveHain.length === 0 && aliveKundakci.length === 0) {
        const othersCount = alivePlayers.length - aliveSK.length;
        if (aliveSK.length >= othersCount && !baskanBlocksWin) {
            clearInterval(room.timer);
            sendGameState(roomCode);
            io.to(roomCode).emit('gameOver', { winner: 'SERİ KATİL', msg: '🔪 Seri Katil köydeki herkesi avladı ve kazandı!' });
            return true;
        }
    }

    // 5. Hainler Zaferi
    const allHainCount = aliveHain.length + aliveHainKoylu.length;
    if (allHainCount > 0 && aliveSK.length === 0 && aliveKundakci.length === 0) {
        const nonHainCount = alivePlayers.length - allHainCount;
        if (allHainCount >= nonHainCount && !baskanBlocksWin && !(aliveHainKoylu.length === 1 && aliveHainTeam.length === 1)) {
            clearInterval(room.timer);
            sendGameState(roomCode);
            io.to(roomCode).emit('gameOver', { winner: 'HAİNLER', msg: '👹 Hainler kasabada çoğunluğu ele geçirdi ve kazandı!' });
            return true;
        }
    }

    return false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Village of Chaos sunucusu ${PORT} portunda çalışıyor.`);
});