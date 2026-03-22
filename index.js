'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const config = require('./settings.json');
const express = require('express');
const http = require('http');
const https = require('https');

// ============================================================
// EXPRESS SERVER - DASHBOARD (inchangé)
// ============================================================
const app = express();
const PORT = process.env.PORT || 5000;

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false
};

// [TODO: Garde tout le code Express/dashboard original jusqu'à startSelfPing()]
// Je ne le répète pas ici pour économiser l'espace - copie-le de ton script original

// ============================================================
// SYSTÈME HUMAIN - RECONNEXION RAPIDE (<5min)
// ============================================================
class HumanBot {
  constructor(bot) {
    this.bot = bot;
    this.lastAction = 0;
    this.idlePeriods = 0;
    this.actionHistory = [];
  }

  // Délai humain avec jitter (mais max 4min pour garder serveur actif)
  humanDelay(type) {
    const delays = {
      look: [20, 90],      // 20s-1.5min
      move: [40, 180],     // 40s-3min
      swing: [60, 240],    // 1m-4min
      inventory: [120, 300] // 2m-5min
    };
    
    const [min, max] = delays[type] || [30, 120];
    return Math.floor((min + Math.random() * (max - min)) * 1000);
  }

  // Action 100% humaine
  async naturalAction() {
    if (!this.bot || !botState.connected) return;
    
    const rand = Math.random();
    
    if (rand < 0.35) {        // 35% regarder autour
      this.lookNatural();
    } else if (rand < 0.65) { // 30% micro mouvement
      await this.tinyWalk();
    } else if (rand < 0.85) { // 20% swing bras
      this.swingArm();
    } else {                  // 15% inventory
      this.switchSlot();
    }
    
    botState.lastActivity = Date.now();
  }

  lookNatural() {
    try {
      const yaw = (Math.random() * Math.PI * 2) - Math.PI;
      const pitch = -0.6 + (Math.random() * 0.8);
      this.bot.look(yaw, pitch, false);
    } catch(e) {}
  }

  async tinyWalk() {
    try {
      const yaw = Math.random() * Math.PI * 2;
      this.bot.look(yaw, -0.1, false);
      
      this.bot.setControlState('forward', true);
      await new Promise(r => setTimeout(r, 300 + Math.random() * 600));
      this.bot.setControlState('forward', false);
    } catch(e) {}
  }

  swingArm() {
    try { this.bot.swingArm(); } catch(e) {}
  }

  switchSlot() {
    try {
      const slot = Math.floor(Math.random() * 9);
      this.bot.setQuickBarSlot(slot);
    } catch(e) {}
  }
}

// ============================================================
// RECONNEXION RAPIDE MAIS INTELLIGENTE (<5min)
// ============================================================
function getSmartReconnectDelay() {
  if (botState.wasThrottled) {
    // Throttle = 2-4min (toujours <5min)
    return (120 + Math.random() * 120) * 1000;
  }
  
  if (botState.reconnectAttempts > 5) {
    // Après 5 échecs : 3-4.5min
    return (180 + Math.random() * 90) * 1000;
  }
  
  // Normal : 10s → 2min progressif
  const base = Math.min(10000 * Math.pow(1.3, botState.reconnectAttempts), 120000);
  return base + Math.random() * 30000; // max 2.5min
}

// ============================================================
// BOT PRINCIPAL - COMPORTEMENT NATUREL
// ============================================================
let bot = null;
let humanBot = null;
let reconnectTimeout = null;
let isReconnecting = false;
let activeIntervals = [];

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function clearTimeouts() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

function createBot() {
  if (isReconnecting) {
    console.log('[Bot] Reconnexion déjà en cours...');
    return;
  }

  // Cleanup propre
  if (bot) {
    clearAllIntervals();
    try { bot.end(); } catch(e) {}
    bot = null;
  }

  console.log(`[Bot] 🔄 Connexion vers ${config.server.ip}:${config.server.port}`);

  bot = mineflayer.createBot({
    username: config['bot-account'].username,
    password: config['bot-account'].password || undefined,
    auth: config['bot-account'].type,
    host: config.server.ip,
    port: config.server.port,
    version: config.server.version || false,
    hideErrors: false,
    checkTimeoutInterval: 300000
  });

  bot.loadPlugin(pathfinder);

  // Timeout connexion Aternos (2.5min)
  const connTimeout = setTimeout(() => {
    if (!botState.connected) {
      console.log('[Bot] Timeout connexion');
      bot.end();
    }
  }, 150000);

  let spawnHandled = false;

  bot.once('spawn', () => {
    if (spawnHandled) return;
    spawnHandled = true;
    
    clearTimeout(connTimeout);
    botState.connected = true;
    botState.reconnectAttempts = 0;
    botState.wasThrottled = false;
    isReconnecting = false;
    
    console.log('[Bot] ✅ Connecté - Comportement naturel activé');
    
    // Initialisation comportement humain
    humanBot = new HumanBot(bot);
    
    // Spawn naturel (pause 3-12s puis première action)
    setTimeout(() => {
      humanBot.naturalAction();
    }, 3000 + Math.random() * 9000);

    // ✅ UNE SEULE BOUCLE HUMAINE (remplace tous les anciens modules)
    let lastCheck = Date.now();
    const humanLoop = setInterval(async () => {
      if (!botState.connected || !bot || !humanBot) {
        clearInterval(humanLoop);
        return;
      }
      
      const now = Date.now();
      const timeSinceLast = now - lastCheck;
      
      // 35% du temps : TOTALEMENT IMMOBILE (AFK naturel)
      if (Math.random() < 0.35 || timeSinceLast < 15000) {
        return;
      }
      
      // Action humaine
      await humanBot.naturalAction();
      lastCheck = now;
      
    }, 20000 + Math.random() * 40000); // 20s-60s entre actions possibles
    
    activeIntervals.push(humanLoop);
  });

  // Gestion kicks intelligents
  bot.on('kicked', (reason) => {
    console.log(`[Bot] Kicked: ${reason}`);
    botState.connected = false;
    
    const reasonLower = reason.toLowerCase();
    if (reasonLower.includes('throttle') || reasonLower.includes('wait') || 
        reasonLower.includes('too many')) {
      botState.wasThrottled = true;
      console.log('[Bot] Throttle détecté → délai étendu');
    }
  });

  // Reconexion <5min garantie
  bot.on('end', () => {
    console.log('[Bot] Déconnexion');
    botState.connected = false;
    clearAllIntervals();
    
    if (config.utils?.['auto-reconnect'] !== false) {
      const delay = getSmartReconnectDelay();
      const delayMin = Math.floor(delay / 60000);
      console.log(`[Bot] 🔄 Reconnexion dans ${delayMin}min${delayMin === 1 ? '' : 's'} (${Math.floor(delay/1000)}s)`);
      
      reconnectTimeout = setTimeout(() => {
        botState.reconnectAttempts++;
        createBot();
      }, delay);
    }
  });

  bot.on('error', (err) => {
    console.log(`[Bot] Erreur: ${err.message}`);
  });
}

// ============================================================
// SUPPRESSION TOTALE DES MODULES DÉTECTABLES
// - Pas de circle-walk
// - Pas de combat auto  
// - Pas de /gamemode spam
// - Pas de random-jump
// - UNE SEULE boucle humaine
// ============================================================

// ============================================================
// CONSOLE COMMANDS (gardés)
// ============================================================
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!bot || !botState.connected) {
    console.log('[Console] Bot déconnecté');
    return;
  }
  const cmd = line.trim();
  if (cmd.startsWith('say ')) {
    bot.chat(cmd.slice(4));
  } else if (cmd === 'status') {
    console.log(`Connecté: ${botState.connected}, Tentatives: ${botState.reconnectAttempts}`);
  } else if (cmd === 'reconnect') {
    bot.end();
  } else {
    bot.chat(cmd);
  }
});

// ============================================================
// START
// ============================================================
console.log('='.repeat(60));
console.log('  🤖 AFK Bot NATUREL v3.1 - Serveur Aternos Actif 24/7');
console.log('  🔄 Reconnexion <5min | Comportement 100% Humain');
console.log('='.repeat(60));

createBot();
