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
        'Silahlı Köylüler': ['Vigilante', 'Başkan', 'Düzenbaz Köylü', 'Avcı Köylü'],
        'Araştırmacı Köylüler': ['Ayakçı', 'Gözcü', 'Medyum', 'Casus', 'Kahin Köylü']
    },
    hain: {
        'Silahlı Hainler': ['Gizleyici', 'Düz Hain', 'Ninja Hain', 'Kayıp Hain'],
        'Destekçi Hainler': ['Suikastçi', 'Gölge Ajanı', 'Susturucu', 'Büyücü Hain', 'Duyucu Hain'],
        'Hain Köylü': ['Hain Köylü']
    },
    neutral: {
        'Silahlı Tarafsızlar': ['Kundakçı', 'Seri Katil'],
        'Normal Tarafsızlar': ['Jester', 'Hırsız']
    }
};

const ALL_HAIN_ROLES = ['Gizleyici', 'Düz Hain', 'Suikastçi', 'Gölge Ajanı', 'Susturucu', 'Büyücü Hain', 'Duyucu Hain', 'Ninja Hain', 'Kayıp Hain'];
const LOST_HAIN_ROLE = 'Kayıp Hain';
const HAIN_KOYLU_ROLE = 'Hain Köylü';
const isHainPlayer = player => Boolean(player && (player.isHain || ALL_HAIN_ROLES.includes(player.role)));
const NON_VISITING_ROLES = ['Düz Köylü', 'Medyum', 'Casus', 'Başkan', 'Hırsız', 'Jester'];
const NEUTRAL_ROLES = ['Kundakçı', 'Seri Katil', 'Jester', 'Hırsız'];

const roleNames = group => Object.values(group).flat();
const TOWN_ROLES = ['Düz Köylü', ...roleNames(ROLE_CATEGORIES.town)];
const CONFIGURABLE_ROLE_NAMES = [
    ...roleNames(ROLE_CATEGORIES.town),
    ...roleNames(ROLE_CATEGORIES.hain).filter(role => role !== HAIN_KOYLU_ROLE),
    ...roleNames(ROLE_CATEGORIES.neutral),
    'Düz Köylü'
];
const isHainKoyluPlayer = player => Boolean(player && player.isHain && !ALL_HAIN_ROLES.includes(player.role));
const getDeadRoleLabel = player => isHainKoyluPlayer(player) ? `Hain ${player.role}` : player.role;

function buildWizardMorningMessage(controlledRole, targetUsername) {
    return `🪄 ${controlledRole} gücünü ${targetUsername} kişisine karşı kullandın.`;
}

function emitRoleActionMessage(actor, text) {
    if (!actor || !actor.id || !text) return;
    io.to(actor.id).emit('chatMessage', { sender: `[${(actor.role || 'ROL').toUpperCase()}]`, text, type: 'green' });
}

function canUseAdditionalNightAction(actor, requestedActionType, existingNightAction) {
    if (!actor || !actor.isLover) return true;
    if (!existingNightAction || !existingNightAction.actionType || existingNightAction.actionType === 'PASS') return true;
    if (requestedActionType === existingNightAction.actionType) return true;
    if (requestedActionType === 'LOVER_PROTECT' || existingNightAction.actionType === 'LOVER_PROTECT') return false;
    if (requestedActionType === 'WIZARD' || existingNightAction.actionType === 'WIZARD') return false;
    return true;
}

function createBotPlayer(index) {
    return {
        id: `bot-${index}`,
        username: `bot ${index}`,
        isBot: true,
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
        roleHidden: false,
        hunterStand: false,
        hunterStandUsed: false,
        ninjaUsed: false,
        isLover: false,
        loverPartnerId: null,
        loverProtectUsed: false
    };
}

function syncRoomBots(room, requestedCount) {
    const count = Math.min(Math.max(0, parseInt(requestedCount) || 0), 20);
    room.players = room.players.filter(player => !player.isBot || Number(player.id.slice(4)) <= count);
    const existingBotIds = new Set(room.players.filter(player => player.isBot).map(player => player.id));
    for (let index = 1; index <= count; index++) {
        if (!existingBotIds.has(`bot-${index}`)) room.players.push(createBotPlayer(index));
    }
}

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
        player.isHain = ALL_HAIN_ROLES.includes(roleName);
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
        player.hunterStand = false;
        player.hunterStandUsed = false;
        player.ninjaUsed = false;
        usedRoles.add(roleName);
    });

    return startIndex + Math.min(count, availableRoles.length);
}

function assignConfiguredRoles(room, shuffledPlayers, roleCounts, usedRoles) {
    const configuredRoles = CONFIGURABLE_ROLE_NAMES.flatMap(roleName =>
        Array.from({ length: Math.min(1, Math.max(0, parseInt(roleCounts[roleName]) || 0)) }, () => roleName)
    );
    const selectedRoles = shuffle(configuredRoles).slice(0, shuffledPlayers.length);

    selectedRoles.forEach((roleName, index) => {
        const player = room.players.find(candidate => candidate.id === shuffledPlayers[index].id);
        player.role = roleName;
        player.isHain = ALL_HAIN_ROLES.includes(roleName);
        player.isAlive = true;
        player.ammo = roleName === 'Vigilante' ? 2 : 0;
        usedRoles.add(roleName);
    });

    return selectedRoles.length;
}

function assignLovers(room, requestedPairs) {
    room.loverPair = [];
    room.loverShieldUsed = false;
    room.players.forEach(player => {
        player.isLover = false;
        player.loverPartnerId = null;
        player.loverProtectUsed = false;
    });

    const pairCount = Math.max(0, parseInt(requestedPairs) || 0);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
        const available = room.players.filter(player =>
            player.isAlive && !player.isLover && !NEUTRAL_ROLES.includes(player.role)
        );
        const possiblePairs = [];
        for (let firstIndex = 0; firstIndex < available.length; firstIndex++) {
            for (let secondIndex = firstIndex + 1; secondIndex < available.length; secondIndex++) {
                const first = available[firstIndex];
                const second = available[secondIndex];
                if (isHainPlayer(first) && isHainPlayer(second)) continue;
                possiblePairs.push([first, second]);
            }
        }
        if (possiblePairs.length === 0) break;
        const [first, second] = possiblePairs[Math.floor(Math.random() * possiblePairs.length)];
        first.isLover = true;
        second.isLover = true;
        first.loverPartnerId = second.id;
        second.loverPartnerId = first.id;
        room.loverPair.push(first.id, second.id);
        io.to(first.id).emit('systemAnnounce', `[SİSTEM] 💗 Aşığın: ${second.username}`);
        io.to(second.id).emit('systemAnnounce', `[SİSTEM] 💗 Aşığın: ${first.username}`);
    }
}

function assignGuns(room) {
    const hains = room.players.filter(p => p.isAlive && ALL_HAIN_ROLES.includes(p.role) && p.role !== LOST_HAIN_ROLE && !isHainKoyluPlayer(p));
    hains.forEach(h => h.hasGun = false);

    const priority = ['Gizleyici', 'Düz Hain', 'Suikastçi', 'Duyucu Hain', 'Ninja Hain', 'Gölge Ajanı', 'Susturucu', 'Büyücü Hain'];
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
            const isAllyTraitor = player.role !== LOST_HAIN_ROLE && isHain && p.role !== LOST_HAIN_ROLE && isHainPlayer(p);
            return {
                id: p.id,
                username: p.username,
                isAlive: p.isAlive,
                role: (!p.isAlive && p.role && !p.roleHidden) ? getDeadRoleLabel(p) : null,
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
            isHain: player.isHain,
            hunterStand: player.hunterStand,
            ninjaUsed: player.ninjaUsed,
            isLover: player.isLover,
            loverPartnerId: player.loverPartnerId,
            loverProtectUsed: player.loverProtectUsed || room.loverShieldUsed
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
            hunterStand: null,
            loverShieldUsed: false,
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
                nightTime: 15,
                asikCount: 0,
                botCount: 0
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
                roleHidden: false,
                hunterStand: false,
                hunterStandUsed: false,
                ninjaUsed: false,
                isLover: false,
                loverPartnerId: null,
                loverProtectUsed: false
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
            roleHidden: false,
            hunterStand: false,
            hunterStandUsed: false,
            ninjaUsed: false,
            isLover: false,
            loverPartnerId: null,
            loverProtectUsed: false
        };

        room.players.push(player);
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
        room.loverPair = [];

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
            p.roleHidden = false;
            p.hunterStand = false;
            p.hunterStandUsed = false;
            p.isLover = false;
            p.loverPartnerId = null;
            p.loverProtectUsed = false;
            p.ninjaUsed = false;
        });
        room.hunterStand = null;

        io.to(code).emit('returnedToLobby', { settings: room.settings, hostId: room.hostId });
        io.to(code).emit('updatePlayerList', room.players);
    });

    socket.on('startGame', ({ roomCode } = {}) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];

        if (!room) return socket.emit('errorMsg', 'Oda bulunamadı!');
        if (room.hostId !== socket.id) return socket.emit('errorMsg', 'Sadece oda kurucusu oyunu başlatabilir!');

        const cfg = room.settings;
        syncRoomBots(room, cfg.botCount);
        const totalPlayers = room.players.length;

        const shuffled = shuffle([...room.players]);
        let idx = 0;
        const usedRoles = new Set();

        const hasConfiguredRoles = Object.values(cfg.normalRoleCounts || {}).some(count => parseInt(count) > 0);
        if (hasConfiguredRoles) idx = assignConfiguredRoles(room, shuffled, cfg.normalRoleCounts, usedRoles);
        idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.hain['Silahlı Hainler'], cfg.silahliHainCount, usedRoles);
        idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.hain['Destekçi Hainler'], cfg.destekciHainCount, usedRoles);
        idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.neutral['Silahlı Tarafsızlar'], cfg.silahliTarafsizCount, usedRoles);
        idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.neutral['Normal Tarafsızlar'], cfg.normalTarafsizCount, usedRoles);
        idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.town['Koruma Köylüleri'], cfg.korumaKoylusuCount, usedRoles);
        idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.town['Silahlı Köylüler'], cfg.silahliKoyluCount, usedRoles);
        idx = assignCategoryRoles(room, shuffled, idx, ROLE_CATEGORIES.town['Araştırmacı Köylüler'], cfg.arastirmaciKoyluCount, usedRoles);
        idx = assignHainKoyluRoles(room, shuffled, idx, cfg.hainKoyluCount, usedRoles);

        while (idx < totalPlayers) {
            const player = room.players.find(x => x.id === shuffled[idx].id);
            player.role = 'Düz Köylü';
            player.isAlive = true;
            idx++;
        }

        assignLovers(room, cfg.asikCount);
        assignGuns(room);

        room.players.forEach(p => {
            if (!p.isBot) io.to(p.id).emit('yourRole', { role: p.role, isHain: p.isHain });
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
        if (target.hunterStand) return socket.emit('errorMsg', 'Avcı Köylü son direnişinde hedef alınamaz!');

        actor.hasAssassinated = true;

        if (target.role === guessedRole) {
            target.isAlive = false;
            target.roleHidden = true;
            io.to(code).emit('systemAnnounce', `💀 [SUİKAST] ${target.username} gündüz vakti suikaste uğrayarak öldü! Rolü: GİZLİ`);
            checkGunPass(room, target);
        } else {
            actor.isAlive = false;
            io.to(code).emit('systemAnnounce', `💀 [SUİKAST] ${actor.username} yanlış tahminde bulunarak intihar etti! Rolü: Suikastçi`);
            checkGunPass(room, actor);
        }

        propagateLoverDeaths(room);
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
        if (target.hunterStand) return socket.emit('errorMsg', 'Avcı Köylü son direnişinde hedef alınamaz!');

        actor.hasStolen = true;
        const stolenRole = target.role;

        target.isAlive = false;
        target.roleHidden = true;
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

        propagateLoverDeaths(room);
        sendGameState(code);
        checkWinCondition(code);
    });

    socket.on('hunterAction', ({ roomCode, targetId }) => {
        const code = (roomCode || socket.roomCode || '').trim().toUpperCase();
        const room = rooms[code];
        const hunter = room && room.players.find(p => p.id === socket.id);
        if (!room || room.phase !== 'DAY' || !hunter || !hunter.hunterStand || room.hunterStand?.playerId !== hunter.id) return;
        if (Date.now() > room.hunterStand.expiresAt || hunter.hunterStandUsed) return;

        const target = room.players.find(p => p.id === targetId && p.isAlive);
        if (!target || target.id === hunter.id) return;
        hunter.hunterStandUsed = true;
        if (target.role === 'Kundakçı') {
            io.to(code).emit('systemAnnounce', `🎯 [AVCI] ${hunter.username}, Kundakçıya ateş etti ancak Kundakçı ölmedi!`);
        } else {
            target.isAlive = false;
            checkGunPass(room, target);
            io.to(code).emit('systemAnnounce', `🎯 [AVCI] ${hunter.username}, ${target.username} kişisine ateş etti! Hedefin rolü: ${target.role}`);
        }
        hunter.hunterStand = false;
        room.hunterStand = null;
        propagateLoverDeaths(room);
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

            const spies = room.players.filter(p => p.role === 'Casus' && p.id !== socket.id && p.id !== targetPlayer.id);
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
            if (sender.isLover && text.startsWith('/aşıklar ')) {
                const loverText = text.substring(9).trim();
                if (!loverText) return;
                const partner = room.players.find(player => player.id === sender.loverPartnerId && player.isAlive);
                if (partner) io.to(partner.id).emit('chatMessage', { sender: sender.username, text: loverText, type: 'lover' });
                socket.emit('chatMessage', { sender: sender.username, text: loverText, type: 'lover' });
                return;
            }
            if (sender.isLover && isHainPlayer(sender) && sender.role !== LOST_HAIN_ROLE && text.startsWith('/hainler ')) {
                const hainText = text.substring(9).trim();
                if (!hainText) return;
                room.players.filter(player => player.isAlive && isHainPlayer(player) && player.role !== LOST_HAIN_ROLE).forEach(player => {
                    io.to(player.id).emit('chatMessage', { sender: sender.username, text: hainText, type: 'hain' });
                });
                return;
            }
            if (sender.role === 'Duyucu Hain' && text.startsWith('/hainler ')) {
                const hainText = text.substring(9).trim();
                if (!hainText) return;
                room.players.filter(p => p.isAlive && isHainPlayer(p) && p.role !== LOST_HAIN_ROLE).forEach(p => io.to(p.id).emit('chatMessage', { sender: sender.username, text: hainText, type: 'hain' }));
                return;
            }
            if (sender.role === 'Duyucu Hain' && text.startsWith('/ölüler ')) {
                const deadText = text.substring(8).trim();
                if (!deadText) return;
                room.players.filter(p => !p.isAlive).forEach(p => io.to(p.id).emit('chatMessage', { sender: 'Gizemli Hain', text: deadText, type: 'dead' }));
                socket.emit('chatMessage', { sender: 'Duyucu', text: deadText, type: 'dead' });
                return;
            }
            if (sender.role === LOST_HAIN_ROLE) {
                return socket.emit('errorMsg', 'Kayıp Hain olarak hain sohbetine erişemezsin.');
            }
            if (isHainPlayer(sender)) {
                const hains = room.players.filter(p => isHainPlayer(p) && p.role !== LOST_HAIN_ROLE);
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
            if (actionType === 'PASS') {
                delete room.nightActions[socket.id];
                return socket.emit('actionConfirmed', { targetId: null, targetName: 'Saldırı iptal edildi' });
            }
            if (['Düz Köylü', 'Medyum', 'Casus', 'Başkan', 'Avcı Köylü'].includes(actor.role)) return;
            if (actor.role === 'Hırsız') return socket.emit('errorMsg', 'Hırsız gece eylemi yapamaz!');
            if (actor.role === 'Büyücü Hain' && !actor.hasGun) {
                return socket.emit('errorMsg', 'Silahın yoksa Büyücü Hain olarak saldırı yapamazsın; büyü gücünü kullanmalısın!');
            }
            if (actor.role === 'Suikastçi' && !actor.hasGun) {
                return socket.emit('errorMsg', 'Silahın yoksa gece eylemi yapamazsın!');
            }
            if (actor.role === 'Ninja Hain' && actionType !== 'NINJA' && !actor.hasGun) {
                return socket.emit('errorMsg', 'Silahın yoksa normal saldırı yapamazsın; Ninja yeteneğini kullanabilirsin!');
            }
            if (actor.role === 'Vigilante' && actor.ammo <= 0) {
                return socket.emit('errorMsg', 'Mermin kalmadı!');
            }
            if (actor.role === 'Ninja Hain' && actionType === 'NINJA' && actor.ninjaUsed) {
                return socket.emit('errorMsg', 'Ninja yeteneğini zaten kullandın!');
            }
            if (actor.role === 'Ninja Hain' && actionType === 'NINJA' && targetId === actor.id) {
                return socket.emit('errorMsg', 'Kendi evini seçemezsin!');
            }
            if (actionType === 'LOVER_PROTECT') {
                const partner = room.players.find(player => player.id === actor.loverPartnerId && player.isAlive);
                if (!actor.isLover || !partner || partner.id !== targetId) return socket.emit('errorMsg', 'Yalnızca yaşayan aşığını koruyabilirsin!');
                if (room.loverShieldUsed) return socket.emit('errorMsg', 'Aşık koruması zaten kullanıldı!');
            }

            const existingNightAction = room.nightActions && room.nightActions[socket.id];
            if (!canUseAdditionalNightAction(actor, actionType, existingNightAction)) {
                return socket.emit('errorMsg', 'Aşık olarak aynı gece iki farklı gece eylemi kullanamazsın!');
            }
            
            if (!room.nightActions) room.nightActions = {};
            if (actor.role === 'Ninja Hain' && actionType === 'NINJA') actor.ninjaUsed = true;
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

        const existingNightAction = room.nightActions && room.nightActions[socket.id];
        if (!canUseAdditionalNightAction(actor, 'WIZARD', existingNightAction)) {
            return socket.emit('errorMsg', 'Aşık olarak aynı gece iki farklı gece eylemi kullanamazsın!');
        }

        room.nightActions[socket.id] = { role: actor.role, actionType: 'WIZARD', targetId, controlledId: controlled.id, controlledRole: controlled.role };
        socket.emit('actionConfirmed', { targetId, targetName: target.username });
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

    if (phase !== 'DAY' && room.hunterStand) {
        const hunter = room.players.find(player => player.id === room.hunterStand.playerId);
        if (hunter) hunter.hunterStand = false;
        room.hunterStand = null;
    }
    room.phase = phase;
    room.timeLeft = phase === 'DAY' && room.hunterStand ? seconds + 20 : seconds;

    if (phase === 'DAY') {
        room.players.forEach(player => {
            if (player.role === 'Suikastçi') player.hasAssassinated = false;
        });
        updateHainKoyluCountdown(roomCode);
        if (room.hunterStand) {
            room.hunterStand.expiresAt = Date.now() + 20000;
            io.to(roomCode).emit('systemAnnounce', '[SİSTEM] 🎯 Avcı Köylü 20 saniyelik son direnişine başladı!');
        }
    }

    sendGameState(roomCode);

    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', room.timeLeft);

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            nextPhase(roomCode);
        } else if (room.phase === 'DAY' && room.hunterStand && Date.now() >= room.hunterStand.expiresAt) {
            const hunter = room.players.find(player => player.id === room.hunterStand.playerId);
            if (hunter) hunter.hunterStand = false;
            room.hunterStand = null;
            io.to(roomCode).emit('systemAnnounce', '[SİSTEM] Avcı Köylünün 20 saniyelik ateş hakkı sona erdi.');
            sendGameState(roomCode);
            checkWinCondition(roomCode);
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
        if (!room.hunterStand && checkWinCondition(roomCode)) return;

        room.dayNumber++;
        room.defendantId = null;
        io.to(roomCode).emit('phaseChangeClearTarget');
        io.to(roomCode).emit('systemAnnounce', `[SİSTEM] ☀️ Gün ${room.dayNumber} başladı! Kasaba uyandı.`);
        startPhase(roomCode, 'DAY', room.settings.dayTime);
    }
}

function addBotNightActions(room) {
    const alivePlayers = room.players.filter(player => player.isAlive);
    const chooseTarget = bot => {
        const targets = alivePlayers.filter(player => player.id !== bot.id);
        return targets.length > 0 ? targets[Math.floor(Math.random() * targets.length)] : null;
    };

    room.players.filter(player => player.isBot && player.isAlive).forEach(bot => {
        let target = null;
        let actionType;

        if (bot.role === 'Büyücü Hain' && !bot.hasGun) {
            const controlled = alivePlayers.find(player =>
                player.id !== bot.id && !isHainPlayer(player) && player.role !== 'Kundakçı'
            );
            target = chooseTarget(bot);
            if (controlled && target && target.id !== controlled.id) {
                room.nightActions[bot.id] = {
                    role: bot.role,
                    actionType: 'WIZARD',
                    targetId: target.id,
                    controlledId: controlled.id,
                    controlledRole: controlled.role
                };
                return;
            }
        } else if (bot.role === 'Jester') {
            target = bot;
        } else if (bot.role === 'Kayıp Hain') {
            target = chooseTarget(bot);
        } else if (bot.role === 'Kundakçı') {
            const doused = alivePlayers.find(player => player.isDoused && player.id !== bot.id);
            target = doused ? { id: 'IGNITE' } : chooseTarget(bot);
        } else if (bot.role === 'Ninja Hain' && !bot.ninjaUsed) {
            target = chooseTarget(bot);
            actionType = 'NINJA';
            bot.ninjaUsed = true;
        } else if (bot.role === 'Doktor' || bot.role === 'Uyutucu' || bot.role === 'Tuzakçı Köylü' ||
            bot.role === 'Gözcü' || bot.role === 'Ayakçı' || bot.role === 'Kahin Köylü' ||
            bot.role === 'Gölge Ajanı' || bot.role === 'Düzenbaz Köylü') {
            target = chooseTarget(bot);
        } else if (bot.role === 'Vigilante' && bot.ammo > 0) {
            target = chooseTarget(bot);
        } else if (bot.role === 'Seri Katil' ||
            (bot.hasGun && ALL_HAIN_ROLES.includes(bot.role))) {
            target = chooseTarget(bot);
        } else if (bot.role === 'Susturucu' || bot.role === 'Jester') {
            target = chooseTarget(bot);
        }

        if (!target) return;
        if (bot.role === 'Kundakçı' && target.id === 'IGNITE') {
            room.nightActions[bot.id] = { role: bot.role, targetId: 'IGNITE' };
        } else {
            room.nightActions[bot.id] = { role: bot.role, targetId: target.id, actionType };
        }
        if (bot.role === 'Vigilante') bot.ammo--;
    });
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

    if (selectedTarget && selectedTarget !== 'PAS' && !tie) {
        const defendant = room.players.find(p => p.id === selectedTarget);
        if (defendant) {
            io.to(roomCode).emit('systemAnnounce', `[SİSTEM] 🗳️ ${defendant.username} ${maxVotes} oy ile kürsüye alındı.`);
        }
    } else if (selectedTarget === 'PAS' && !tie) {
        io.to(roomCode).emit('systemAnnounce', `[SİSTEM] 🗳️ ${voteCounts.PAS || 0} oy ile pas geçildi.`);
    } else if (tie) {
        const tiedTargets = Object.entries(voteCounts)
            .filter(([, count]) => count === maxVotes)
            .map(([targetId]) => targetId === 'PAS' ? 'PAS' : room.players.find(p => p.id === targetId)?.username || 'Bilinmeyen');
        io.to(roomCode).emit('systemAnnounce', `[SİSTEM] 🗳️ Oylama berabere kaldı (${tiedTargets.join(', ')}: ${maxVotes} oy). Pas geçildi.`);
    } else {
        io.to(roomCode).emit('systemAnnounce', '[SİSTEM] 🗳️ 0 oy ile pas geçildi.');
    }

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
    const abstainList = [];
    let guiltyVotes = 0;
    let innocentVotes = 0;
    let abstainVotes = 0;

    const eligibleVoters = room.players.filter(p => p.isAlive && !p.isBot && p.id !== room.defendantId);

    eligibleVoters.forEach(voter => {
        const verdict = room.judgmentVotes[voter.id];
        const weight = (voter.role === 'Başkan' && voter.isRevealed) ? 3 : 1;
        if (verdict === 'GUILTY') {
            guiltyList.push(voter.username);
            guiltyVotes += weight;
        } else if (verdict === 'INNOCENT') {
            innocentList.push(voter.username);
            innocentVotes += weight;
        } else if (verdict === 'ABSTAIN') {
            abstainList.push(voter.username);
            abstainVotes += weight;
        }
    });

    const formatVoterList = voters => voters.length > 0 ? `${voters.join(', ')} kişisi` : 'Kimse';
    io.to(roomCode).emit('systemAnnounce', `[${guiltyVotes}] Suçlu: ${formatVoterList(guiltyList)}`);
    io.to(roomCode).emit('systemAnnounce', `[${innocentVotes}] Suçsuz: ${formatVoterList(innocentList)}`);
    io.to(roomCode).emit('systemAnnounce', `[${abstainVotes}] Pas: ${formatVoterList(abstainList)}`);

    const defendant = room.players.find(p => p.id === room.defendantId);

    if (guiltyVotes > innocentVotes) {
        if (defendant) {
            defendant.isAlive = false;
            io.to(roomCode).emit('systemAnnounce', `[SİSTEM] ⚖️ Duruşma Sonucu: ${guiltyVotes} Suçlu / ${innocentVotes} Suçsuz. ${defendant.username} İDAM EDİLDİ! Rolü: ${defendant.role}`);
            
            checkGunPass(room, defendant);
            propagateLoverDeaths(room);

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
    addBotNightActions(room);
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

        if (target.role === 'Seri Katil' || target.role === LOST_HAIN_ROLE) {
            io.to(actor.id).emit('chatMessage', { sender: '[UYUTUCU]', text: '💤 Eylemin işlemedi.', type: 'green' });
            return;
        }

        io.to(target.id).emit('systemAnnounce', '[SİSTEM] 💤 Bu gece uyutuldun!');

        if (!actions[target.id] || !actions[target.id].targetId) {
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
    let loverProtectTarget = null;
    let skTarget = null;
    let hainTarget = null, hainActor = null;
    let lostHainTarget = null, lostHainActor = null;
    let vigTarget = null, vigActor = null;
    let silencerTarget = null, silencerActor = null;
    let gozcuTarget = null, gozcuActor = null;
    let ayakciTarget = null, ayakciActor = null;
    let arsoIgnite = false, arsoDouseTarget = null, arsoActor = null;
    let shadowTarget = null, shadowActor = null;
    let kahinTarget = null, kahinActor = null;
    let ninjaTarget = null, ninjaActor = null;
    const trapTargets = new Set();
    const trapActors = new Map();
    let tricksterTarget = null, tricksterActor = null;
    // Tracks which actorIds performed a genuine Kill/Attack action this night
    // (armed Hain, Vigilante, Seri Katil, or Ninja Hain). Only these matter for
    // deciding whether a reflected Deceiver (Düzenbaz Köylü) redirect is lethal.
    const killPerformerIds = new Set();

    Object.entries(actions).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (actor && actor.isAlive && actor.role === 'Tuzakçı Köylü' && act.targetId) {
            trapTargets.add(act.targetId);
            trapActors.set(act.targetId, actor);
        }
    });

    Object.entries(actions).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (actor && actor.isAlive && actor.role === 'Düzenbaz Köylü' && act.targetId) {
            tricksterTarget = act.targetId;
            tricksterActor = actor;
        }
    });

    Object.entries(actions).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (!actor || !actor.isAlive || !act.targetId || !trapTargets.has(act.targetId)) return;
        if (!['Seri Katil', 'Kundakçı', LOST_HAIN_ROLE].includes(actor.role) && actor.role !== 'Tuzakçı Köylü' && !(actor.role === 'Ninja Hain' && act.actionType === 'NINJA')) {
            act.blockedByTrap = true;
            const trapper = trapActors.get(act.targetId);
            if (trapper) {
                io.to(trapper.id).emit('systemAnnounce', '[SİSTEM] 🪤 Tuzağın tetiklendi!');
            }
            io.to(actor.id).emit('systemAnnounce', '[SİSTEM] 🪤 Bir tuzağa bastın!');
        }
    });

    // --- DÜZENBAZ KÖYLÜ (DECEIVER) — GENERAL REFLECTION LOGIC ---
    // Every action aimed at the Deceiver's visited target this night is redirected back
    // onto its own performer, so it ends up affecting the performer instead of the
    // original target. The sole exception is the Arsonist (Kundakçı): his dousing/ignite
    // action is never reflected, so if he ends up burning the visited house, anyone still
    // "present" there that night (including the Deceiver himself, whose own action target
    // is never redirected away) burns along with it.
    if (tricksterActor) {
        const tricksterOwnAction = actions[tricksterActor.id];
        if (tricksterOwnAction && tricksterOwnAction.blockedByTrap) {
            // Deceiver himself stepped on a trap - his visit never happened, no reflection.
            tricksterActor = null;
        } else {
            Object.entries(actions).forEach(([actorId, act]) => {
                const visitor = room.players.find(p => p.id === actorId);
                if (!visitor || visitor.id === tricksterActor.id || !visitor.isAlive) return;
                if (act.targetId !== tricksterTarget || act.noVisit || act.blockedByTrap) return;
                if (visitor.role === 'Kundakçı') return; // Arsonist ignores the reflection entirely

                act.reflectedTargetId = visitor.id;
                act.originalTargetId = act.targetId;
                act.targetId = visitor.id;
                act.reflectedByTrickster = true;
                io.to(visitor.id).emit('chatMessage', { sender: '[DÜZENBAZ KÖYLÜ]', text: '🪞 Düzenbaz Köylü eylemini sana yansıttı; eylemin kendi üzerinde gerçekleşti.', type: 'green' });
            });
        }
    }

    Object.entries(actions).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (!actor || !actor.isAlive || act.blockedByTrap) return;

        if (actor.isLover && act.actionType === 'LOVER_PROTECT') {
            if (room.loverShieldUsed) return;
            loverProtectTarget = act.targetId;
            room.loverShieldUsed = true;
            actor.loverProtectUsed = true;
            const loverPartner = room.players.find(player => player.id === actor.loverPartnerId);
            if (loverPartner) loverPartner.loverProtectUsed = true;
            return;
        }

        if (act.controlledBy && act.role === 'Düzenbaz Köylü') {
            tricksterTarget = act.targetId;
            tricksterActor = actor;
        }
        else if (act.controlledBy && act.role === 'Seri Katil') { skTarget = act.targetId; killPerformerIds.add(actorId); }
        else if (act.controlledBy && (ALL_HAIN_ROLES.includes(act.role) || act.role === HAIN_KOYLU_ROLE)) {
            hainTarget = act.targetId;
            hainActor = actor;
            killPerformerIds.add(actorId);
        }
        else if (act.controlledBy && act.role === 'Vigilante') {
            vigTarget = act.targetId;
            vigActor = actor;
            killPerformerIds.add(actorId);
        }
        else if (actor.role === 'Doktor') { docTarget = act.targetId; docActor = actor; }
        else if (actor.role === 'Gölge Ajanı' && !actor.hasGun) { shadowTarget = act.targetId; shadowActor = actor; }
        else if (actor.role === 'Kahin Köylü') { kahinTarget = act.targetId; kahinActor = actor; }
        else if (actor.role === 'Seri Katil') { skTarget = act.targetId; killPerformerIds.add(actorId); }
        else if (actor.role === LOST_HAIN_ROLE) {
            lostHainTarget = act.targetId;
            lostHainActor = actor;
            killPerformerIds.add(actorId);
        }
        else if (actor.hasGun && ALL_HAIN_ROLES.includes(actor.role) && act.actionType !== 'NINJA') {
            hainTarget = act.targetId;
            hainActor = actor;
            killPerformerIds.add(actorId);
        }
        else if (actor.role === 'Susturucu' && !actor.hasGun) {
            silencerActor = actor;
            silencerTarget = act.targetId;
        }
        else if (actor.role === 'Vigilante' && actor.ammo > 0) {
            vigTarget = act.targetId;
            vigActor = actor;
            actor.ammo--;
            killPerformerIds.add(actorId);
        }
        else if (actor.role === 'Gözcü') { gozcuTarget = act.targetId; gozcuActor = actor; }
        else if (actor.role === 'Ayakçı') { ayakciTarget = act.targetId; ayakciActor = actor; }
        else if (actor.role === 'Kundakçı') {
            if (act.targetId === 'IGNITE') arsoIgnite = true;
            else arsoDouseTarget = act.targetId;
            arsoActor = actor;
        }
        else if (actor.role === 'Ninja Hain' && act.actionType === 'NINJA') {
            ninjaTarget = act.targetId;
            ninjaActor = actor;
            killPerformerIds.add(actorId);
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

    if (silencerTarget && silencerActor) {
        const silencedPlayer = room.players.find(p => p.id === silencerTarget);
        room.mutedPlayerId = silencerTarget;
        emitRoleActionMessage(silencerActor, silencedPlayer ? `${silencedPlayer.username} kişisini susturdun.` : 'Birini susturdun.');
        io.to(silencerTarget).emit('chatMessage', { sender: '[SUSTURUCU]', text: '🤐 Gece bir Susturucu tarafından hedef alındınız! Yarın konuşamayacaksınız.', type: 'green' });
    }

    if (arsoActor && arsoDouseTarget && !arsoIgnite) {
        const dTarget = room.players.find(p => p.id === arsoDouseTarget);
        if (dTarget && dTarget.isAlive) {
            dTarget.isDoused = true;
            emitRoleActionMessage(arsoActor, `🔥 ${dTarget.username} adlı kişinin evini yağladın.`);
            io.to(arsoActor.id).emit('chatMessage', { sender: '[KUNDAKÇI]', text: `🔥 ${dTarget.username} adlı kişinin evi yağlandı.`, type: 'green' });
        }
    }

    let killedList = [];

    if (ninjaActor && ninjaTarget) {
        const ninjaVictims = Object.entries(actions)
            .filter(([actorId, act]) => actorId !== ninjaActor.id && act.targetId === ninjaTarget && !act.noVisit && act.role !== 'Kundakçı')
            .map(([actorId]) => room.players.find(p => p.id === actorId))
            .filter(p => p && p.isAlive);
        [...new Set(ninjaVictims)].forEach(victim => {
            victim.isAlive = false;
            const hiddenRole = false;
            victim.roleHidden = hiddenRole;
            killedList.push({ player: victim, killer: 'Ninja Hain', hiddenRole });
            checkGunPass(room, victim);
        });
        emitRoleActionMessage(ninjaActor, `🌑 Seçtiğin evde ${ninjaVictims.length} ziyaretçiyi öldürdün. Kundakçı etkilenmedi.`);
        io.to(ninjaActor.id).emit('chatMessage', { sender: '[NINJA HAIN]', text: `🌑 Seçtiğin evde ${ninjaVictims.length} ziyaretçiyi öldürdün. Kundakçı etkilenmedi.`, type: 'green' });
    }

    if (arsoIgnite) {
        const dousedPlayers = room.players.filter(p => p.isAlive && p.isDoused && p.id !== arsoActor.id);
        const visitorsToDoused = Object.entries(actions)
            .filter(([actorId, act]) => act.targetId && !act.noVisit && dousedPlayers.some(target => target.id === act.targetId) && actorId !== arsoActor.id)
            .map(([actorId]) => room.players.find(p => p.id === actorId))
            .filter(p => p && p.isAlive && p.id !== arsoActor.id);
        const arsoVictims = [...new Set([...dousedPlayers, ...visitorsToDoused])];
        arsoVictims.forEach(v => {
            v.isAlive = false;
            if (v.role === 'Avcı Köylü') {
                v.hunterStand = true;
                v.hunterStandUsed = false;
                room.hunterStand = { playerId: v.id, expiresAt: 0 };
            }
            killedList.push({ player: v, killer: 'Kundakçı', hiddenRole: false });
            checkGunPass(room, v);
        });
    }

    const serialKiller = room.players.find(p => p.role === 'Seri Katil');
    const isArmedHain = player => Boolean(player && player.hasGun && ALL_HAIN_ROLES.includes(player.role));
    const isMutualSerialKillerHainAttack = Boolean(
        serialKiller &&
        hainActor &&
        isArmedHain(hainActor) &&
        skTarget === hainActor.id &&
        hainTarget === serialKiller.id
    );
    const isMutualIgniteAttackOnArsonist = Boolean(
        arsoIgnite &&
        arsoActor &&
        ((serialKiller && skTarget === arsoActor.id) ||
            (hainActor && isArmedHain(hainActor) && hainTarget === arsoActor.id) ||
            (vigActor && vigTarget === arsoActor.id))
    );

    function processAttack(attacker, targetId, killerName) {
        if (!attacker || !attacker.isAlive || !targetId) return;
        const victim = room.players.find(p => p.id === targetId);
        if (!victim || !victim.isAlive) return;

        const canKillKundakci = ['Gizleyici', 'Seri Katil', LOST_HAIN_ROLE].includes(attacker.role);
        const isKundakciTarget = victim.role === 'Kundakçı';
        if (isKundakciTarget && !canKillKundakci) {
            io.to(victim.id).emit('systemAnnounce', '[SİSTEM] 🛡️ Sana saldırdılar ama korundun!');
            io.to(attacker.id).emit('chatMessage', { sender: '[SİSTEM]', text: 'Hedefinizi öldüremediniz.', type: 'green' });
            return;
        }

        if (isMutualIgniteAttackOnArsonist && victim.id === arsoActor.id) {
            io.to(victim.id).emit('systemAnnounce', '[SİSTEM] 🛡️ Sana saldırdılar ama korundun!');
            io.to(attacker.id).emit('chatMessage', { sender: '[SİSTEM]', text: 'Hedefinizi öldüremediniz.', type: 'green' });
            if (attacker.role === 'Gizleyici' || attacker.role === 'Seri Katil') {
                attacker.isAlive = false;
                killedList.push({ player: attacker, killer: victim.role, hiddenRole: false });
                checkGunPass(room, attacker);
            }
            return;
        }

        if (isMutualSerialKillerHainAttack && attacker.id === hainActor.id && victim.id === serialKiller.id) {
            io.to(victim.id).emit('systemAnnounce', '[SİSTEM] 🛡️ Sana saldırdılar ama korundun!');
            io.to(attacker.id).emit('chatMessage', { sender: '[SİSTEM]', text: 'Hedefinizi öldüremediniz.', type: 'green' });
            attacker.isAlive = false;
            killedList.push({ player: attacker, killer: victim.role, hiddenRole: false });
            checkGunPass(room, attacker);
            return;
        }

        let protectedByDoc = (docTarget === targetId);
        let protectedByLover = (loverProtectTarget === targetId);
        let protectedByJester = (victim.role === 'Jester' && victim.jesterShieldProtected);

        if (protectedByDoc || protectedByLover || protectedByJester) {
            io.to(victim.id).emit('systemAnnounce', '[SİSTEM] 🛡️ Sana saldırdılar ama korundun!');
            io.to(attacker.id).emit('chatMessage', { sender: '[SİSTEM]', text: 'Hedefinizi öldüremediniz.', type: 'green' });
            if (protectedByJester) {
                victim.jesterShield--;
                victim.jesterShieldProtected = false;
            }
        } else {
            victim.isAlive = false;
            if (victim.role === 'Avcı Köylü') {
                victim.hunterStand = true;
                victim.hunterStandUsed = false;
                room.hunterStand = { playerId: victim.id, expiresAt: 0 };
            }
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
    if (lostHainActor && lostHainTarget) processAttack(lostHainActor, lostHainTarget, LOST_HAIN_ROLE);
    if (vigActor && vigTarget) processAttack(vigActor, vigTarget, 'Vigilante');

    // --- DÜZENBAZ KÖYLÜ (DECEIVER) — SURVIVAL OUTCOME ---
    // The Deceiver only pays with his life when the specific action that got reflected
    // back onto its performer was a genuine Kill/Attack (armed Hain, Vigilante, Seri
    // Katil, or Ninja Hain) - this is decided by killPerformerIds, populated purely from
    // action *type*, so it stays correct even if the self-inflicted attack was ultimately
    // survived thanks to Doctor/Lover/Jester protection. Any reflected non-killing action
    // (Susturma, Uyutma, Rol Öğrenme, Tuzak kurma, vb.) always leaves the Deceiver unharmed.
    if (tricksterActor && tricksterActor.isAlive) {
        const wasKillReflected = Object.keys(actions).some(actorId => {
            const act = actions[actorId];
            return act && act.reflectedByTrickster && killPerformerIds.has(actorId);
        });

        if (wasKillReflected) {
            tricksterActor.isAlive = false;
            killedList.push({ player: tricksterActor, killer: 'Düzenbaz Köylü yansıması', hiddenRole: false });
            checkGunPass(room, tricksterActor);
            io.to(tricksterActor.id).emit('chatMessage', { sender: '[DÜZENBAZ KÖYLÜ]', text: '🪞 Yansıttığın eylem ölümcül bir saldırıydı; bu yüzden sen de öldün!', type: 'green' });
        } else {
            io.to(tricksterActor.id).emit('chatMessage', { sender: '[DÜZENBAZ KÖYLÜ]', text: '🪞 Yansıttığın eylem öldürücü değildi; sapasağlam hayattasın.', type: 'green' });
        }

        const reflectedTarget = room.players.find(p => p.id === tricksterTarget);
        if (reflectedTarget) emitRoleActionMessage(tricksterActor, `🪞 ${reflectedTarget.username} kişisinin eylemini yansıtıp geri çevirdin.`);
    }

    propagateLoverDeaths(room, killedList);

    if (killedList.length === 0) {
        io.to(roomCode).emit('systemAnnounce', '[SİSTEM] 🛡️ Bu gece kimse ölmedi.');
    } else {
        killedList.forEach(k => {
            const roleStr = k.hiddenRole ? 'GİZLİ' : getDeadRoleLabel(k.player);
            io.to(roomCode).emit('systemAnnounce', `[SİSTEM] 💀 ${k.player.username} katledildi! Rolü: ${roleStr} (${k.killer} tarafından)`);
        });
    }

    if (gozcuActor && gozcuTarget) {
        const visitors = Object.entries(actions)
            .filter(([aId, act]) => act.targetId === gozcuTarget && !act.noVisit && aId !== gozcuActor.id)
            .map(([aId]) => room.players.find(p => p.id === aId))
            .filter(p => p && p.role !== 'Seri Katil' && !(p.role === LOST_HAIN_ROLE && gozcuTarget === actions[p.id]?.targetId))
            .map(p => p.username);

        const targetP = room.players.find(p => p.id === gozcuTarget);
        const reportText = visitors.length > 0 
            ? `🔍 Gözcü Raporu: Bu gece ${targetP ? targetP.username : 'Hedef'} kişisinin evine gidenler: ${visitors.join(', ')}`
            : `🔍 Gözcü Raporu: Bu gece ${targetP ? targetP.username : 'Hedef'} kişisinin evine kimse gitmedi.`;

        emitRoleActionMessage(gozcuActor, reportText);
        io.to(gozcuActor.id).emit('chatMessage', { sender: '[GÖZCÜ RAPORU]', text: reportText, type: 'green' });
    }

    if (ayakciActor && ayakciTarget) {
        const visitedAct = actions[ayakciTarget];
        const targetP = room.players.find(p => p.id === ayakciTarget);
        let reportText = '';

        if (visitedAct && !visitedAct.noVisit && visitedAct.targetId && targetP && targetP.role !== 'Seri Katil' && targetP.role !== LOST_HAIN_ROLE) {
            const destP = room.players.find(p => p.id === visitedAct.targetId);
            reportText = `👟 Ayakçı Raporu: ${targetP.username} bu gece ${destP ? destP.username : 'Bilinmeyen'} kişisinin evine gitti.`;
        } else {
            reportText = `👟 Ayakçı Raporu: ${targetP ? targetP.username : 'Hedef'} bu gece evinden dışarı çıkmadı.`;
        }

        emitRoleActionMessage(ayakciActor, reportText);
        io.to(ayakciActor.id).emit('chatMessage', { sender: '[AYAKÇI RAPORU]', text: reportText, type: 'green' });
    }

    if (shadowActor && shadowTarget) {
        const target = room.players.find(p => p.id === shadowTarget);
        if (target) {
            shadowActor.shadowRole = { targetId: target.id, role: target.role };
            emitRoleActionMessage(shadowActor, `🌑 ${target.username} adlı kişinin rolünü öğrendin: ${target.role}.`);
            io.to(shadowActor.id).emit('chatMessage', { sender: '[GÖLGE AJANI]', text: `🌑 ${target.username} adlı kişinin rolünü öğrendin: ${target.role}. Sabah evinin üstünde görünecek.`, type: 'green' });
        }
    }

    Object.entries(room.nightActions || {}).forEach(([actorId, act]) => {
        const actor = room.players.find(p => p.id === actorId);
        if (!actor || !actor.isAlive || act.actionType !== 'WIZARD') return;
        const controlled = room.players.find(p => p.id === act.controlledId);
        const target = room.players.find(p => p.id === act.targetId);
        if (controlled && target) {
            io.to(actor.id).emit('chatMessage', { sender: '[BÜYÜCÜ HAIN]', text: buildWizardMorningMessage(controlled.role, target.username), type: 'green' });
        }
    });

    if (kahinActor && kahinTarget) {
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
        emitRoleActionMessage(kahinActor, reportText);
        io.to(kahinActor.id).emit('chatMessage', { sender: '[KAHİN KÖYLÜ RAPORU]', text: reportText, type: 'green' });
    }
}

function checkGunPass(room, deadPlayer) {
    if (deadPlayer.hasGun) {
        deadPlayer.hasGun = false;
        assignGuns(room);
    }
}

function propagateLoverDeaths(room, killedList = null) {
    const newlyDead = room.players.filter(player => !player.isAlive && player.isLover);
    const processed = new Set();
    while (newlyDead.length > 0) {
        const deadPlayer = newlyDead.shift();
        if (processed.has(deadPlayer.id)) continue;
        processed.add(deadPlayer.id);
        const partner = room.players.find(player => player.id === deadPlayer.loverPartnerId);
        if (partner && partner.isAlive) {
            partner.isAlive = false;
            if (partner.role === 'Avcı Köylü') {
                partner.hunterStand = true;
                partner.hunterStandUsed = false;
                room.hunterStand = { playerId: partner.id, expiresAt: 0 };
            }
            checkGunPass(room, partner);
            if (killedList) killedList.push({ player: partner, killer: 'Aşık bağı', hiddenRole: false });
            newlyDead.push(partner);
        }
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
    const loverPair = room.loverPair || [];
    const aliveLovers = loverPair.filter(playerId => alivePlayers.some(player => player.id === playerId));
    const nonNeutralPlayers = alivePlayers.filter(player => !NEUTRAL_ROLES.includes(player.role));
    const nonLoverPlayers = alivePlayers.filter(player => !loverPair.includes(player.id));

    const loverPairIncludesHain = loverPair.some(playerId => {
        const player = room.players.find(candidate => candidate.id === playerId);
        return isHainPlayer(player);
    });

    if (aliveLovers.length === 2 && alivePlayers.length === 2) {
        clearInterval(room.timer);
        sendGameState(roomCode);
        const winner = loverPairIncludesHain ? 'HAİNLER VE AŞIKLAR' : 'AŞIKLAR';
        io.to(roomCode).emit('gameOver', { winner, msg: '💗 Aşıklar birlikte hayatta kaldı ve kazandı!' });
        return true;
    }

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
        io.to(roomCode).emit('gameOver', { winner: aliveLovers.length === 2 ? 'KASABA VE AŞIKLAR' : 'KASABA', msg: '🎉 Bütün hainler ve tehditler yok edildi! Kasaba kazandı!' });
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
            const winner = aliveLovers.length === 2 ? 'HAİNLER VE AŞIKLAR' : 'HAİNLER';
            const message = aliveLovers.length === 2
                ? '💗 Aşıklar hayatta kaldı ve hainlerle birlikte kazandı!'
                : '👹 Hainler kasabada çoğunluğu ele geçirdi ve kazandı!';
            io.to(roomCode).emit('gameOver', { winner, msg: message });
            return true;
        }
    }

    return false;
}

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`Village of Chaos sunucusu ${PORT} portunda çalışıyor.`);
    });
}

module.exports = {
    buildWizardMorningMessage,
    canUseAdditionalNightAction
};