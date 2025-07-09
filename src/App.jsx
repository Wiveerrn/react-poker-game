/* eslint-disable no-undef */
/* global __firebase_config, __app_id, __initial_auth_token */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';
import { 
    getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, 
    collection, query, where, getDocs, addDoc, serverTimestamp, runTransaction, deleteDoc, orderBy
} from 'firebase/firestore';
import { motion, AnimatePresence } from 'framer-motion';
import * as Tone from 'tone';

// --- Firebase Configuration ---
let firebaseConfig;

// This logic handles different environments gracefully.
// 1. Check for the specific environment variable provided in this interactive environment.
if (typeof __firebase_config !== 'undefined' && __firebase_config) {
    firebaseConfig = JSON.parse(__firebase_config);
} 
// 2. Check for Vercel's environment variables.
else if (typeof process !== 'undefined' && process.env) {
    firebaseConfig = {
      apiKey: process.env.REACT_APP_API_KEY,
      authDomain: process.env.REACT_APP_AUTH_DOMAIN,
      projectId: process.env.REACT_APP_PROJECT_ID,
      storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
      messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
      appId: process.env.REACT_APP_APP_ID,
      measurementId: process.env.REACT_APP_MEASUREMENT_ID,
    };
}
// 3. Fallback if no configuration is found.
else {
    console.error("FATAL: Firebase configuration is missing or invalid. Please check your environment variables.");
    firebaseConfig = { 
        apiKey: "invalid", 
        authDomain: "invalid.firebaseapp.com", 
        projectId: "invalid", 
        storageBucket: "invalid.appspot.com", 
        messagingSenderId: "invalid", 
        appId: "invalid" 
    };
}


const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- Firestore Path Configuration ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-poker-app';
const roomsCollectionPath = `artifacts/${appId}/public/data/pokerRooms`;
const profilesCollectionPath = `artifacts/${appId}/public/data/profiles`;
const matchmakingQueuePath = (mode) => `artifacts/${appId}/public/data/matchmakingQueue_${mode}`;

// --- Game Constants ---
const SUITS = ['♥', '♦', '♣', '♠'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

// --- Sound Engine ---
const sounds = {
    deal: new Tone.Synth({ oscillator: { type: "sine" }, envelope: { attack: 0.005, decay: 0.1, sustain: 0.05, release: 0.1 } }).toDestination(),
    chip: new Tone.MetalSynth({ frequency: 200, envelope: { attack: 0.001, decay: 0.1, release: 0.05 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5 }).toDestination(),
    win: new Tone.Synth({ oscillator: { type: "triangle8" }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.2, release: 0.5 } }).toDestination(),
    celebrate: new Tone.PolySynth(Tone.Synth, { oscillator: { type: "fmtriangle" }, envelope: { attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.4 } }).toDestination(),
    fold: new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.005, decay: 0.1, sustain: 0 } }).toDestination(),
    check: new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 2, envelope: { attack: 0.001, decay: 0.2, sustain: 0.01 } }).toDestination(),
};
sounds.chip.volume.value = -10;
sounds.deal.volume.value = -10;
let soundsEnabled = false;
const enableSounds = async () => {
    if (!soundsEnabled) {
        await Tone.start();
        soundsEnabled = true;
    }
};
const playSound = (soundName) => {
    if (!soundsEnabled) return;
    try {
        switch(soundName) {
            case 'deal': sounds.deal.triggerAttackRelease("C5", "8n"); break;
            case 'chip': sounds.chip.triggerAttackRelease("C3", "8n", Tone.now(), Math.random() * 0.5 + 0.5); break;
            case 'win': sounds.win.triggerAttackRelease("C5", "0.5"); break;
            case 'celebrate': sounds.celebrate.triggerAttackRelease(["C4", "E4", "G4", "C5"], "0.5"); break;
            case 'fold': sounds.fold.triggerAttackRelease("2n"); break;
            case 'check': sounds.check.triggerAttackRelease("C2", "8n"); break;
            default: break;
        }
    } catch (e) { console.error("Sound error:", e); }
};

// --- Hand Evaluation Logic ---
const getCombinations = (arr, k) => {
    const result = [];
    function combine(startIndex, current) {
        if (current.length === k) { result.push([...current]); return; }
        for (let i = startIndex; i < arr.length; i++) {
            current.push(arr[i]);
            combine(i + 1, current);
            current.pop();
        }
    }
    combine(0, []);
    return result;
};
const getBestFiveCardHand = (cards) => {
    const sorted = [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
    const ranks = sorted.map(c => RANK_VALUES[c.rank]);
    const suits = sorted.map(c => c.suit);
    const isFlush = new Set(suits).size === 1;
    const rankCounts = ranks.reduce((acc, r) => ({ ...acc, [r]: (acc[r] || 0) + 1 }), {});
    const counts = Object.values(rankCounts).sort((a, b) => b - a);
    const isAceLowStraight = JSON.stringify(ranks.sort((a,b) => a-b)) === JSON.stringify([2,3,4,5,14]);
    const uniqueRanks = [...new Set(ranks)].sort((a,b) => b-a);
    let isStraight = false;
    if (uniqueRanks.length >= 5) {
        for (let i = 0; i <= uniqueRanks.length - 5; i++) {
            if (uniqueRanks[i] - uniqueRanks[i+4] === 4) {
                isStraight = true;
                break;
            }
        }
    }
    if(!isStraight) isStraight = isAceLowStraight;
    const value = ranks.reduce((acc, r, i) => acc + r * Math.pow(15, 4 - i), 0);

    if (isStraight && isFlush) return { rank: isAceLowStraight ? 8 : (ranks.includes(14) ? 9 : 8), name: isAceLowStraight ? 'ストレートフラッシュ' : (ranks.includes(14) ? 'ロイヤルストレートフラッシュ' : 'ストレートフラッシュ'), value, cards: sorted };
    if (counts[0] === 4) return { rank: 7, name: 'フォーカード', value, cards: sorted };
    if (counts[0] === 3 && counts[1] === 2) return { rank: 6, name: 'フルハウス', value, cards: sorted };
    if (isFlush) return { rank: 5, name: 'フラッシュ', value, cards: sorted };
    if (isStraight) return { rank: 4, name: 'ストレート', value, cards: sorted };
    if (counts[0] === 3) return { rank: 3, name: 'スリーカード', value, cards: sorted };
    if (counts[0] === 2 && counts[1] === 2) return { rank: 2, name: 'ツーペア', value, cards: sorted };
    if (counts[0] === 2) return { rank: 1, name: 'ワンペア', value, cards: sorted };
    return { rank: 0, name: 'ハイカード', value, cards: sorted };
};
const evaluateHand = (sevenCards) => {
    if (!sevenCards || sevenCards.length < 5) return { rank: -1, name: '', value: 0, cards: [] };
    const combinations = getCombinations(sevenCards, 5);
    return combinations.map(getBestFiveCardHand).reduce((best, current) => {
        if (!best) return current;
        if (current.rank > best.rank) return current;
        if (current.rank === best.rank && current.value > best.value) return current;
        return best;
    }, null);
};

// --- Client-Side Game Logic (HOST ONLY) ---
const gameLogic = {
    getPlayerOrder(players, dealerId) {
        const playerIds = Object.keys(players);
        const dealerIndex = playerIds.indexOf(dealerId);
        if (dealerIndex === -1) return playerIds;
        return [...playerIds.slice(dealerIndex + 1), ...playerIds.slice(0, dealerIndex + 1)];
    },

    async startGame(roomId, room) {
        const roomRef = doc(db, roomsCollectionPath, roomId);
        const playerIds = Object.keys(room.players).filter(id => room.players[id].chips > 0);
        if (playerIds.length < 2) {
            await updateDoc(roomRef, { log: [...(room.log || []), "プレイヤーが2人未満のため、ゲームを開始できません。"] });
            return;
        }

        const deck = SUITS.flatMap(suit => RANKS.map(rank => ({ suit, rank }))).sort(() => Math.random() - 0.5);
        
        const dealerIndex = (room.lastDealerIndex + 1) % playerIds.length;
        const dealerId = playerIds[dealerIndex];
        
        const orderedPlayerIds = this.getPlayerOrder(room.players, dealerId);
        const activePlayerIds = orderedPlayerIds.filter(id => room.players[id].chips > 0);

        const smallBlindId = activePlayerIds[0];
        const bigBlindId = activePlayerIds[1];
        
        const updatedPlayers = { ...room.players };
        let pot = 0;

        playerIds.forEach(id => {
            updatedPlayers[id] = { ...updatedPlayers[id], hand: [], bet: 0, folded: false, lastAction: '', hasActed: false };
        });

        playerIds.forEach(id => {
            if(updatedPlayers[id].chips > 0) updatedPlayers[id].hand = [deck.pop(), deck.pop()];
        });

        const sbAmount = Math.min(SMALL_BLIND, updatedPlayers[smallBlindId].chips);
        updatedPlayers[smallBlindId].chips -= sbAmount;
        updatedPlayers[smallBlindId].bet = sbAmount;
        pot += sbAmount;

        const bbAmount = Math.min(BIG_BLIND, updatedPlayers[bigBlindId].chips);
        updatedPlayers[bigBlindId].chips -= bbAmount;
        updatedPlayers[bigBlindId].bet = bbAmount;
        pot += bbAmount;
        
        updatedPlayers[smallBlindId].hasActed = true;
        updatedPlayers[bigBlindId].hasActed = true;

        await updateDoc(roomRef, {
            status: 'playing',
            deck,
            players: updatedPlayers,
            communityCards: [],
            pot,
            dealerId,
            lastDealerIndex: dealerIndex,
            currentPlayerId: activePlayerIds[2 % activePlayerIds.length],
            currentBet: BIG_BLIND,
            minRaise: BIG_BLIND,
            stage: 'pre-flop',
            lastRaiser: bigBlindId,
            log: [`ラウンド開始！ ${updatedPlayers[smallBlindId].name}がSB、${updatedPlayers[bigBlindId].name}がBBをベット。`]
        });
    },

    async processAction(roomId, room) {
        const roomRef = doc(db, roomsCollectionPath, roomId);
        let { players, currentPlayerId, log, stage, deck, communityCards, pot, currentBet, minRaise, dealerId, lastRaiser } = room;
        const actingPlayer = players[currentPlayerId];
        if (!actingPlayer || !actingPlayer.actionRequest) return;

        const { action, amount } = actingPlayer.actionRequest;
        delete players[currentPlayerId].actionRequest;
        players[currentPlayerId].hasActed = true;

        switch (action) {
            case 'fold':
                players[currentPlayerId].folded = true;
                players[currentPlayerId].lastAction = 'フォールド';
                log.push(`${actingPlayer.name}がフォールドしました。`);
                break;
            case 'check':
                players[currentPlayerId].lastAction = 'チェック';
                log.push(`${actingPlayer.name}がチェックしました。`);
                break;
            case 'call':
                const callAmount = Math.min(currentBet - actingPlayer.bet, actingPlayer.chips);
                players[currentPlayerId].chips -= callAmount;
                pot += callAmount;
                players[currentPlayerId].bet += callAmount;
                players[currentPlayerId].lastAction = 'コール';
                log.push(`${actingPlayer.name}がコールしました。`);
                break;
            case 'bet':
                 const betValue = amount;
                const raiseAmount = betValue - currentBet;
                players[currentPlayerId].chips -= (betValue - players[currentPlayerId].bet);
                pot += (betValue - players[currentPlayerId].bet);
                players[currentPlayerId].bet = betValue;
                minRaise = raiseAmount;
                currentBet = betValue;
                lastRaiser = currentPlayerId;
                players[currentPlayerId].lastAction = room.currentBet > 0 ? `レイズ ($${currentBet})` : `ベット ($${currentBet})`;
                log.push(`${actingPlayer.name}が${players[currentPlayerId].lastAction}`);
                break;
        }

        const playerIdsInOrder = this.getPlayerOrder(players, dealerId);
        let activePlayersIds = playerIdsInOrder.filter(id => !players[id].folded && players[id].chips > 0);
        
        if (activePlayersIds.length <= 1) {
            const winnerId = activePlayersIds[0];
            players[winnerId].chips += pot;
            log.push(`${players[winnerId].name}が勝利し、$${pot}を獲得しました。`);
            await updateDoc(roomRef, { status: 'waiting', players, pot: 0, log, communityCards: [] });
            return;
        }

        const currentIndex = playerIdsInOrder.indexOf(currentPlayerId);
        let nextPlayerId = null;
        for (let i = 1; i <= playerIdsInOrder.length; i++) {
            const nextId = playerIdsInOrder[(currentIndex + i) % playerIdsInOrder.length];
            if (!players[nextId].folded && players[nextId].chips > 0) {
                nextPlayerId = nextId;
                break;
            }
        }
        
        const activePlayersStillToAct = activePlayersIds.filter(id => players[id].bet < currentBet || !players[id].hasActed);
        const roundOver = activePlayersStillToAct.length === 0 && nextPlayerId === lastRaiser;

        if (roundOver) {
            log.push("ベッティングラウンド終了。");
            activePlayersIds.forEach(id => { players[id].bet = 0; players[id].hasActed = false; });
            const orderedActivePlayers = this.getPlayerOrder(players, dealerId).filter(id => !players[id].folded && players[id].chips > 0);
            const nextPlayerAfterDealer = orderedActivePlayers[0];
            
            let nextStage = stage;
            if (stage === 'pre-flop') { communityCards.push(deck.pop(), deck.pop(), deck.pop()); nextStage = 'flop'; }
            else if (stage === 'flop') { communityCards.push(deck.pop()); nextStage = 'turn'; }
            else if (stage === 'turn') { communityCards.push(deck.pop()); nextStage = 'river'; }
            else if (stage === 'river') {
                log.push("ショーダウン！");
                const hands = activePlayersIds.map(id => ({ id, eval: evaluateHand([...players[id].hand, ...communityCards]) }));
                hands.sort((a, b) => b.eval.rank - a.eval.rank || b.eval.value - a.eval.value);
                const winner = hands[0];
                log.push(`${players[winner.id].name}が「${winner.eval.name}」で勝利！`);
                players[winner.id].chips += pot;
                await updateDoc(roomRef, { status: 'waiting', players, pot: 0, log, communityCards: [] });
                return;
            }
            await updateDoc(roomRef, { players, pot, log, stage: nextStage, deck, communityCards, currentBet: 0, minRaise: BIG_BLIND, currentPlayerId: nextPlayerAfterDealer, lastRaiser: null });
        } else {
            await updateDoc(roomRef, { players, pot, currentBet, minRaise, currentPlayerId: nextPlayerId, log });
        }
    }
};


// --- React Components ---
const Card = React.memo(({ card, isFlipped }) => {
    const suitColor = (card.suit === '♥' || card.suit === '♦') ? 'text-red-500' : 'text-black';
    return (
        <motion.div className="w-16 h-24 md:w-20 md:h-28" style={{ perspective: '1000px' }}>
            <motion.div className="relative w-full h-full" style={{ transformStyle: 'preserve-3d' }} animate={{ rotateY: isFlipped ? 180 : 0 }} transition={{ duration: 0.5 }}>
                <div className="absolute w-full h-full bg-white rounded-lg shadow-lg flex flex-col justify-between p-1 border border-gray-200" style={{ backfaceVisibility: 'hidden' }}>
                    <div className={`text-left text-lg font-bold ${suitColor}`}><div>{card.rank}</div><div>{card.suit}</div></div>
                </div>
                <div className="absolute w-full h-full bg-blue-800 rounded-lg shadow-lg border-2 border-blue-400 flex items-center justify-center" style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
                    <div className="w-10 h-10 rounded-full bg-blue-900 opacity-50"></div>
                </div>
            </motion.div>
        </motion.div>
    );
});
const Player = ({ player, isCurrentPlayer, isDealer, hand, bestHandName }) => {
    const isTurn = isCurrentPlayer;
    return (
        <div className="flex flex-col items-center justify-center transition-all duration-300">
            <div className={`relative bg-black/50 px-4 py-1 rounded-full mb-2 border-2 ${isTurn ? 'border-yellow-400 animate-pulse' : 'border-transparent'}`}>
                <span className="text-lg font-semibold">{player.name.substring(0, 8)}</span>
                <span className="text-yellow-400 ml-2 font-mono">${player.chips}</span>
                {isDealer && <div className="absolute -top-2 -right-2 w-6 h-6 bg-white text-black rounded-full flex items-center justify-center font-bold text-sm">D</div>}
            </div>
            <div className="flex space-x-2 h-28 md:h-32 items-center">
                {hand.map((card, i) => <Card key={i} card={card} isFlipped={card.suit === '?'} />)}
            </div>
            <div className="h-5 mt-1 text-sm text-yellow-200 font-semibold">{bestHandName}</div>
            {player.lastAction && <div className="text-xs text-gray-300 mt-1">{player.lastAction}</div>}
        </div>
    );
};
const GameRoom = ({ roomId, user, backToLobby }) => {
    const [room, setRoom] = useState(null);
    const [betAmount, setBetAmount] = useState(BIG_BLIND);

    useEffect(() => {
        const roomDocRef = doc(db, roomsCollectionPath, roomId);
        const unsub = onSnapshot(roomDocRef, (doc) => setRoom(doc.data()));
        return () => unsub();
    }, [roomId]);

    const handleStartGame = useCallback(() => {
        if (room && room.status === 'waiting' && user.uid === room.hostId) {
            gameLogic.startGame(roomId, room);
        }
    }, [room, user.uid, roomId]);

    useEffect(() => {
        if (!room || user.uid !== room.hostId) return;
        const actingPlayer = room.players?.[room.currentPlayerId];
        if (room.status === 'playing' && actingPlayer?.actionRequest) {
             const timeoutId = setTimeout(() => {
                gameLogic.processAction(roomId, room);
            }, 500);
            return () => clearTimeout(timeoutId);
        }
    }, [room, user.uid, roomId]);


    const myPlayer = useMemo(() => room?.players?.[user.uid], [room, user]);
    const myTurn = useMemo(() => room && room.currentPlayerId === user.uid && room.status === 'playing', [room, user]);

    const handlePlayerAction = useCallback(async (action, amount = 0) => {
        if (!myTurn) return;
        const roomDocRef = doc(db, roomsCollectionPath, roomId);
        await updateDoc(roomDocRef, {
            [`players.${user.uid}.actionRequest`]: { action, amount, timestamp: serverTimestamp() }
        });
        playSound(action === 'fold' ? 'fold' : (action === 'check' ? 'check' : 'chip'));
    }, [myTurn, roomId, user.uid]);

    useEffect(() => {
        if (room) {
            const minBet = room.currentBet > 0 ? room.currentBet + room.minRaise : room.minRaise;
            setBetAmount(Math.max(minBet || BIG_BLIND, BIG_BLIND));
        }
    }, [room]);
    
    if (!room || !myPlayer) return <div className="text-white text-2xl animate-pulse">ルーム情報を読み込み中...</div>;

    const { 
        players = {}, 
        communityCards = [], 
        pot = 0, 
        currentPlayerId = null, 
        dealerId = null, 
        status = 'waiting', 
        log = [], 
        stage = 'lobby',
        hostId = null,
        currentBet = 0,
        minRaise = BIG_BLIND
    } = room;

    const callAmount = currentBet - myPlayer.bet;

    const getBestHandName = (playerId) => {
        const player = players[playerId];
        if (stage === 'river' && !player.folded && player.hand?.length > 0) {
            return evaluateHand([...player.hand, ...communityCards])?.name;
        }
        return '';
    };
    
    return (
        <div className="w-full h-full flex flex-col p-4 bg-green-800 bg-opacity-50" style={{backgroundImage: 'radial-gradient(circle, #059669, #14532d)'}}>
            <div className="absolute top-2 left-2 z-30"><button onClick={backToLobby} className="bg-red-600/80 px-4 py-2 rounded-lg hover:bg-red-500">ロビーに戻る</button></div>
            
            {status === 'waiting' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50 z-20">
                    {user.uid === hostId ? (
                        <>
                            <h2 className="text-2xl text-white mb-4">プレイヤーを待っています... ({Object.keys(players).length} / 6)</h2>
                            {Object.keys(players).length >= 2 ? (
                                <button onClick={handleStartGame} className="bg-green-500 hover:bg-green-400 text-white font-bold py-4 px-8 rounded-lg text-2xl shadow-lg animate-pulse">
                                    ゲーム開始
                                </button>
                            ) : (
                                <p className="text-gray-300">ゲームを開始するには、少なくとも2人のプレイヤーが必要です。</p>
                            )}
                        </>
                    ) : (
                        <h2 className="text-2xl text-white animate-pulse">ホストがゲームを開始するのを待っています...</h2>
                    )}
                    <button onClick={backToLobby} className="mt-8 bg-gray-500/80 px-4 py-2 rounded-lg hover:bg-gray-400">
                        ロビーに戻る
                    </button>
                </div>
            )}

            <div className="absolute top-2 right-2 z-20 bg-black/50 px-3 py-1 rounded-lg">
                <span className="text-yellow-300 font-bold uppercase">{stage}</span>
            </div>

            <div className="grid grid-cols-3 grid-rows-3 flex-grow relative">
                {Object.keys(players).filter(id => id !== user.uid).map((id, index) => (
                     <div key={id} className={`absolute ${index === 0 ? 'top-0 left-1/2 -translate-x-1/2' : index === 1 ? 'top-1/2 -translate-y-1/2 left-0' : 'top-1/2 -translate-y-1/2 right-0'}`}>
                        <Player player={players[id]} isCurrentPlayer={currentPlayerId === id} isDealer={dealerId === id} hand={(players[id].hand || []).map(c => (status === 'showdown' || stage === 'river') && !players[id].folded ? c : {suit: '?', rank: '?' })} bestHandName={getBestHandName(id)} />
                    </div>
                ))}
                <div className="col-start-2 row-start-2 flex flex-col items-center justify-center">
                    <div className="text-center mb-4"><div className="text-xl font-semibold text-yellow-200">POT</div><div className="text-4xl font-bold font-mono text-yellow-400">${pot}</div></div>
                    <div className="flex space-x-2 h-28 md:h-32 items-center">
                        <AnimatePresence>{communityCards.map((card, i) => (<motion.div key={i} initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.2 }}><Card card={card} isFlipped={false} /></motion.div>))}</AnimatePresence>
                    </div>
                </div>
                <div className="col-start-2 row-start-3 flex items-center justify-center">
                     <Player player={myPlayer} isCurrentPlayer={currentPlayerId === user.uid} isDealer={dealerId === user.uid} hand={myPlayer.hand || []} bestHandName={getBestHandName(user.uid)} />
                </div>
            </div>
            {status === 'playing' && (
                <div className="w-full max-w-2xl mx-auto p-4 bg-gray-800/50 rounded-xl shadow-lg">
                    <div className="flex justify-around items-center space-x-2 mb-4">
                        <button onClick={() => handlePlayerAction('fold')} disabled={!myTurn} className="action-button flex-1 bg-red-700 hover:bg-red-600 text-white font-bold py-3 px-4 rounded-lg disabled:opacity-50">フォールド</button>
                        <button onClick={() => handlePlayerAction(callAmount > 0 ? 'call' : 'check')} disabled={!myTurn} className="action-button flex-1 bg-gray-600 hover:bg-gray-500 text-white font-bold py-3 px-4 rounded-lg disabled:opacity-50">{callAmount > 0 ? `コール ($${callAmount})` : 'チェック'}</button>
                        <button onClick={() => handlePlayerAction('bet', betAmount)} disabled={!myTurn || myPlayer.chips < betAmount} className="action-button flex-1 bg-blue-700 hover:bg-blue-600 text-white font-bold py-3 px-4 rounded-lg disabled:opacity-50">{currentBet > 0 ? 'レイズ' : 'ベット'}</button>
                    </div>
                    {myTurn && (
                        <div>
                            <input type="range" min={currentBet + minRaise} max={myPlayer.chips} value={betAmount} onChange={(e) => setBetAmount(Number(e.target.value))} step={BIG_BLIND / 2} className="w-full h-3 bg-gray-600 rounded-lg appearance-none cursor-pointer" />
                            <div className="text-center mt-1 text-lg font-mono">ベット額: ${betAmount}</div>
                        </div>
                    )}
                </div>
            )}
            <AnimatePresence>{log && log.length > 0 && (<motion.div key={log[log.length-1]} initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -50 }} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/70 p-6 rounded-xl text-3xl font-bold text-center text-white z-10 pointer-events-none">{log[log.length-1]}</motion.div>)}</AnimatePresence>
        </div>
    );
};
const Lobby = ({ user, joinRoom }) => {
    const [gameMode, setGameMode] = useState('custom'); // 'custom', 'ranked', 'normal'
    const [rooms, setRooms] = useState([]);
    const [roomName, setRoomName] = useState('');
    const [profile, setProfile] = useState(null);
    const [newUsername, setNewUsername] = useState('');
    const [isMatchmaking, setIsMatchmaking] = useState(false);
    const [rankedPlayers, setRankedPlayers] = useState([]);

    // Profile and Username logic
    useEffect(() => {
        if (!user) return;
        const profileRef = doc(db, profilesCollectionPath, user.uid);
        const unsub = onSnapshot(profileRef, (doc) => {
            if (doc.exists()) {
                const data = doc.data();
                setProfile(data);
                setNewUsername(data.name);
            }
        });
        return () => unsub();
    }, [user]);
    
    const handleUpdateName = async () => {
        if (!newUsername.trim() || !user) return;
        const profileRef = doc(db, profilesCollectionPath, user.uid);
        try {
            await updateDoc(profileRef, { name: newUsername.trim() });
        } catch (error) {
            console.error("Error updating name: ", error);
        }
    };

    // Fetch custom rooms
    useEffect(() => {
        if (gameMode !== 'custom') return;
        const q = query(collection(db, roomsCollectionPath), where("type", "==", "custom"));
        const unsub = onSnapshot(q, (snapshot) => {
            setRooms(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (error) => console.error("Lobby snapshot error:", error));
        return () => unsub();
    }, [gameMode]);
    
    // Fetch rankings
    useEffect(() => {
        if (gameMode !== 'ranked') return;
        const q = query(collection(db, profilesCollectionPath));
        const unsub = onSnapshot(q, (snapshot) => {
            const players = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            players.sort((a, b) => (b.rating || 1500) - (a.rating || 1500));
            setRankedPlayers(players);
        }, (error) => console.error("Ranking snapshot error:", error));
        return () => unsub();
    }, [gameMode]);

    const createRoom = async () => {
        if (!roomName.trim() || !user) return;
        const newRoomRef = await addDoc(collection(db, roomsCollectionPath), {
            name: roomName,
            type: 'custom',
            status: 'waiting',
            hostId: user.uid,
            players: {},
            lastDealerIndex: -1,
            createdAt: serverTimestamp(),
        });
        joinRoom(newRoomRef.id);
    };

    // Matchmaking Logic
    const startMatchmaking = async (mode) => {
        setIsMatchmaking(true);
        const queueRef = collection(db, matchmakingQueuePath(mode));
        const q = query(queueRef, where("status", "==", "waiting"));
        const opponents = await getDocs(q);

        let matched = false;
        if (!opponents.empty) {
            const opponentDoc = opponents.docs[0];
            await runTransaction(db, async (transaction) => {
                const freshOpponentDoc = await transaction.get(opponentDoc.ref);
                if (!freshOpponentDoc.exists() || freshOpponentDoc.data().status !== 'waiting') {
                    return; 
                }
                
                const newRoomRef = await addDoc(collection(db, roomsCollectionPath), {
                    name: `${mode} Match`,
                    type: mode,
                    status: 'waiting',
                    hostId: user.uid,
                    players: {},
                    lastDealerIndex: -1,
                    createdAt: serverTimestamp(),
                });

                transaction.update(opponentDoc.ref, { status: "matched", roomId: newRoomRef.id });
                joinRoom(newRoomRef.id);
                matched = true;
            });
        }

        if (!matched) {
            const myQueueDoc = doc(db, matchmakingQueuePath(mode), user.uid);
            await setDoc(myQueueDoc, {
                userId: user.uid,
                rating: profile.rating || 1500,
                status: 'waiting',
                enteredAt: serverTimestamp(),
            });
        }
    };

    const cancelMatchmaking = async (mode) => {
        setIsMatchmaking(false);
        const myQueueDoc = doc(db, matchmakingQueuePath(mode), user.uid);
        await deleteDoc(myQueueDoc);
    };
    
    // Listen for a match
    useEffect(() => {
        if (!isMatchmaking || !user) return;
        const mode = gameMode;
        const myQueueDoc = doc(db, matchmakingQueuePath(mode), user.uid);
        const unsub = onSnapshot(myQueueDoc, (doc) => {
            if (doc.exists() && doc.data().status === 'matched') {
                setIsMatchmaking(false);
                joinRoom(doc.data().roomId);
                deleteDoc(myQueueDoc);
            }
        });
        return () => unsub();
    }, [isMatchmaking, user, gameMode, joinRoom]);


    const renderContent = () => {
        if (isMatchmaking) {
            return (
                <div className="text-center p-8">
                    <h3 className="text-2xl text-yellow-300 mb-4 animate-pulse">マッチング中...</h3>
                    <p className="text-gray-400 mb-6">対戦相手を探しています。しばらくお待ちください。</p>
                    <button onClick={() => cancelMatchmaking(gameMode)} className="bg-red-600 px-8 py-3 rounded-lg font-semibold hover:bg-red-500 transition-colors">
                        キャンセル
                    </button>
                </div>
            )
        }

        switch(gameMode) {
            case 'ranked':
                return (
                    <div className="grid md:grid-cols-2 gap-8 p-4">
                        <div className="text-center">
                            <h3 className="text-2xl text-yellow-300 mb-4">ランクマッチ</h3>
                            <p className="text-gray-400 mb-6">あなたのレーティングを賭けて、世界中のプレイヤーと対戦します。</p>
                            <button onClick={() => startMatchmaking('ranked')} className="bg-green-600 px-8 py-3 rounded-lg font-semibold hover:bg-green-500 transition-colors text-xl">マッチング開始</button>
                        </div>
                        <div>
                            <h3 className="text-2xl text-yellow-300 mb-4 text-center">ランキング</h3>
                            <div className="bg-gray-900/50 rounded-lg p-4 max-h-80 overflow-y-auto">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className="border-b border-gray-600">
                                            <th className="p-2">順位</th>
                                            <th className="p-2">プレイヤー</th>
                                            <th className="p-2 text-right">レーティング</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rankedPlayers.map((player, index) => (
                                            <tr key={player.id} className={`border-b border-gray-700 ${player.id === user.uid ? 'bg-yellow-500/20' : ''}`}>
                                                <td className="p-2 font-bold">{index + 1}</td>
                                                <td className="p-2">{player.name}</td>
                                                <td className="p-2 text-right font-mono">{player.rating}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                );
            case 'normal':
                return (
                    <div className="text-center p-8">
                        <h3 className="text-2xl text-yellow-300 mb-4">ノーマルマッチ</h3>
                        <p className="text-gray-400 mb-6">レーティングの変動なしで気軽に対戦します。</p>
                        <button onClick={() => startMatchmaking('normal')} className="bg-blue-600 px-8 py-3 rounded-lg font-semibold hover:bg-blue-500 transition-colors text-xl">マッチング開始</button>
                    </div>
                );
            case 'custom':
            default:
                return (
                    <div className="p-4">
                        <div className="mb-8">
                            <h2 className="text-xl font-semibold mb-3 border-b border-yellow-400/50 pb-2">ルームを作成</h2>
                            <div className="flex space-x-2">
                                <input type="text" value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="ルーム名を入力" className="flex-grow bg-gray-700 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500" />
                                <button onClick={createRoom} className="bg-green-600 px-6 py-3 rounded-lg font-semibold hover:bg-green-500 transition-colors">作成</button>
                            </div>
                        </div>
                        <div>
                            <h2 className="text-xl font-semibold mb-3 border-b border-yellow-400/50 pb-2">参加可能なルーム</h2>
                            <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                                {rooms.length === 0 && <p className="text-gray-400">参加可能なルームはありません。</p>}
                                {rooms.map(room => (<div key={room.id} className="flex justify-between items-center bg-gray-700/50 p-4 rounded-lg"><div><h3 className="text-xl font-bold">{room.name}</h3><p className="text-sm text-gray-400">{Object.keys(room.players).length} / 6 人 | ステータス: {room.status}</p></div><button onClick={() => joinRoom(room.id)} disabled={Object.keys(room.players).length >= 6} className="bg-blue-600 px-6 py-2 rounded-lg font-semibold hover:bg-blue-500 disabled:bg-gray-500 disabled:cursor-not-allowed transition-colors">参加</button></div>))}
                            </div>
                        </div>
                    </div>
                );
        }
    };

    return (
        <div className="w-full max-w-4xl mx-auto p-8 bg-gray-800/80 rounded-xl shadow-2xl text-white">
            <h1 className="text-4xl font-bold text-center text-yellow-300 mb-2">React Poker</h1>
            <p className="text-center mb-2 text-gray-300">ようこそ、<span className="font-bold text-yellow-300">{profile ? profile.name : '...'}</span> さん (Rating: {profile ? profile.rating : 1500})</p>
            <div className="mb-6">
                <h2 className="text-xl font-semibold mb-3">ユーザー設定</h2>
                <div className="flex space-x-2 bg-gray-900/50 p-4 rounded-lg">
                    <input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="新しい名前" className="flex-grow bg-gray-700 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500"/>
                    <button onClick={handleUpdateName} className="bg-purple-600 px-6 py-3 rounded-lg font-semibold hover:bg-purple-500 transition-colors">名前を変更</button>
                </div>
            </div>
            
            <div className="flex mb-6 border-b-2 border-gray-700">
                <button onClick={() => setGameMode('ranked')} className={`flex-1 py-3 font-semibold text-lg ${gameMode === 'ranked' ? 'text-yellow-300 border-b-4 border-yellow-300' : 'text-gray-400'}`}>ランクマッチ</button>
                <button onClick={() => setGameMode('normal')} className={`flex-1 py-3 font-semibold text-lg ${gameMode === 'normal' ? 'text-yellow-300 border-b-4 border-yellow-300' : 'text-gray-400'}`}>ノーマルマッチ</button>
                <button onClick={() => setGameMode('custom')} className={`flex-1 py-3 font-semibold text-lg ${gameMode === 'custom' ? 'text-yellow-300 border-b-4 border-yellow-300' : 'text-gray-400'}`}>カスタムマッチ</button>
            </div>
            
            {renderContent()}
        </div>
    );
};
export default function App() {
    const [user, setUser] = useState(null);
    const [currentRoomId, setCurrentRoomId] = useState(null);

    useEffect(() => {
        const checkAndCreateUserProfile = async (firebaseUser) => {
            const profileRef = doc(db, profilesCollectionPath, firebaseUser.uid);
            try {
                const docSnap = await getDoc(profileRef);
                if (!docSnap.exists()) {
                    await setDoc(profileRef, {
                        name: `Player ${firebaseUser.uid.substring(0, 4)}`,
                        rating: 1500,
                        createdAt: serverTimestamp()
                    });
                }
            } catch (error) {
                console.error("Error creating user profile:", error);
            }
        };

        const signIn = async () => {
            try {
                const token = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
                if (token) {
                    await signInWithCustomToken(auth, token);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (error) {
                console.error("Authentication failed:", error);
            }
        };

        const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
            if (firebaseUser) {
                setUser(firebaseUser);
                checkAndCreateUserProfile(firebaseUser);
            } else {
                signIn();
            }
        });

        return () => unsubscribe();
    }, []);
    
    const joinRoom = useCallback(async (roomId) => {
        if (!user) return;
        await enableSounds();
        const profileRef = doc(db, profilesCollectionPath, user.uid);
        const roomRef = doc(db, roomsCollectionPath, roomId);
        
        try {
            const profileSnap = await getDoc(profileRef);
            const playerName = profileSnap.exists() ? profileSnap.data().name : `Player ${user.uid.substring(0, 4)}`;

            const roomSnap = await getDoc(roomRef);
            if (roomSnap.exists()) {
                const roomData = roomSnap.data();
                if (Object.keys(roomData.players).length < 6 && !roomData.players[user.uid]) {
                     await updateDoc(roomRef, {
                        [`players.${user.uid}`]: { name: playerName, chips: STARTING_CHIPS, hand: [], bet: 0, folded: false, isAllIn: false, lastAction: '' }
                    });
                }
            }
            setCurrentRoomId(roomId);
        } catch (error) {
            console.error("Error joining room:", error);
        }
    }, [user]);

    const backToLobby = useCallback(async () => {
        if (user && currentRoomId) {
            const roomRef = doc(db, roomsCollectionPath, currentRoomId);
            try {
                const roomSnap = await getDoc(roomRef);
                if (roomSnap.exists()) {
                    const roomData = roomSnap.data();
                    const players = { ...roomData.players };
                    delete players[user.uid];

                    if (Object.keys(players).length === 0 && (roomData.type === 'custom' || roomData.type === 'normal' || roomData.type === 'ranked')) {
                        await deleteDoc(roomRef);
                    } else {
                        await updateDoc(roomRef, { players });
                    }
                }
            } catch (error) {
                console.error("Error leaving room:", error);
            }
        }
        setCurrentRoomId(null);
    }, [user, currentRoomId]);

    if (!user) {
        return <div className="w-screen h-screen flex items-center justify-center bg-gray-900 text-white text-2xl animate-pulse">認証中...</div>;
    }

    return (
        <main className="w-screen h-screen bg-gray-900 flex items-center justify-center font-sans" onClick={enableSounds}>
            <AnimatePresence mode="wait">
                {currentRoomId ? (
                    <motion.div key="room" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full h-full">
                        <GameRoom roomId={currentRoomId} user={user} backToLobby={backToLobby} />
                    </motion.div>
                ) : (
                    <motion.div key="lobby" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                        <Lobby user={user} joinRoom={joinRoom} />
                    </motion.div>
                )}
            </AnimatePresence>
        </main>
    );
}
