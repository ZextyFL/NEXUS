/**
 * NEXUS — FiveM Server Dashboard
 * Frontend Application
 * Netlify/GitHub-ready version using direct HTTP polling
 */

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const CONFIG = {
  apiUrl: 'http://YOUR_SERVER_IP:30120/nexus',
  apiKey: 'YOUR_SECRET_API_KEY',
  pollInterval: 1000,
  playerRefreshInterval: 5000,
  reconnectDelay: 3000,
  mapWidth: 2048,
  mapHeight: 2048,
  // GTA V map bounds (game coords to canvas)
  gtaMinX: -4000, gtaMaxX: 4500,
  gtaMinY: -4000, gtaMaxY: 8000,
  ...(window.NEXUS_CONFIG || {}),
};

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
const STATE = {
  players: {},
  events: [],
  transactions: [],
  chat: [],
  alerts: [],
  mapMarkers: [],
  selectedPlayer: null,
  spectatingPlayer: null,
  ws: null,
  connected: false,
  demoMode: false,
  pollTimer: null,
  playerRefreshTimer: null,
  mapScale: 1,
  mapOffsetX: 0,
  mapOffsetY: 0,
  mapDragging: false,
  mapDragStart: { x: 0, y: 0 },
  serverStats: { kills: 0, explosions: 0, drops: 0, harvests: 0, totalCash: 0, totalBank: 0, transactions: 0, weedHarvested: 0, tps: 60 },
  uptime: 0,
  uptimeInterval: null,
  selectedInvItem: null,
  selectedInvPlayer: null,
  camMode: 'follow',
  spectateAngle: 0,
};

// ═══════════════════════════════════════
// API CONNECTION
// ═══════════════════════════════════════
function setConnectionState(isConnected, message) {
  STATE.connected = isConnected;
  const dot = document.querySelector('.status-dot');
  if (dot) dot.style.background = isConnected ? 'var(--green)' : 'var(--red)';
  if (message) addAlert(isConnected ? 'success' : 'warn', message);
}

function hasValidApiConfig() {
  return CONFIG.apiUrl && !CONFIG.apiUrl.includes('YOUR_SERVER_IP') &&
         CONFIG.apiKey && !CONFIG.apiKey.includes('YOUR_SECRET_API_KEY');
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${CONFIG.apiUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': CONFIG.apiKey,
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function fetchPlayerSnapshot() {
  const data = await apiFetch('/players', { method: 'GET' });
  updatePlayerList(Array.isArray(data.players) ? data.players : []);
}

async function pollServer() {
  const data = await apiFetch('/poll', { method: 'GET' });

  if (Array.isArray(data.messages)) {
    data.messages.forEach((msgStr) => {
      try {
        const msg = JSON.parse(msgStr);
        handleServerMessage(msg);
      } catch (err) {
        console.error('[NEXUS] Failed to parse polled message:', err, msgStr);
      }
    });
  }
}

async function connectWS() {
  console.log('[NEXUS] Starting direct HTTP mode...');
  if (!hasValidApiConfig()) {
    console.warn('[NEXUS] Missing API config, switching to demo mode');
    startDemoMode();
    return;
  }

  if (STATE.pollTimer) clearInterval(STATE.pollTimer);
  if (STATE.playerRefreshTimer) clearInterval(STATE.playerRefreshTimer);

  try {
    await fetchPlayerSnapshot();
    await pollServer();
    STATE.demoMode = false;
    setConnectionState(true, 'Connected to FiveM HTTP API');
  } catch (err) {
    console.warn('[NEXUS] Initial connection failed:', err);
    setConnectionState(false, `Connection failed: ${err.message}`);
    startDemoMode();
    return;
  }

  STATE.pollTimer = setInterval(async () => {
    try {
      await pollServer();
      if (!STATE.connected) setConnectionState(true, 'Connection restored');
    } catch (err) {
      if (STATE.connected) {
        console.warn('[NEXUS] Poll failed:', err);
        setConnectionState(false, `Polling failed: ${err.message}`);
      }
    }
  }, CONFIG.pollInterval);

  STATE.playerRefreshTimer = setInterval(async () => {
    try {
      await fetchPlayerSnapshot();
      if (!STATE.connected) setConnectionState(true, 'Player sync restored');
    } catch (err) {
      if (STATE.connected) {
        console.warn('[NEXUS] Player refresh failed:', err);
        setConnectionState(false, `Player refresh failed: ${err.message}`);
      }
    }
  }, CONFIG.playerRefreshInterval);
}

async function sendWS(type, data) {
  if (!hasValidApiConfig()) {
    console.log('[DEMO] Would send:', type, data);
    return;
  }

  try {
    await apiFetch('/command', {
      method: 'POST',
      body: JSON.stringify({ command: type, data }),
    });
  } catch (err) {
    console.error('[NEXUS] Command failed:', err);
    addAlert('danger', `Command failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'playerList':     updatePlayerList(msg.data); break;
    case 'playerUpdate':   updatePlayer(msg.data); break;
    case 'playerJoin':     onPlayerJoin(msg.data); break;
    case 'playerLeave':    onPlayerLeave(msg.data); break;
    case 'event':          onGameEvent(msg.data); break;
    case 'chat':           onChatMessage(msg.data); break;
    case 'inventory':      onInventoryData(msg.data); break;
    case 'spectateData':   onSpectateData(msg.data); break;
    case 'serverStats':    updateServerStats(msg.data); break;
    case 'transaction':    onTransaction(msg.data); break;
    case 'serverInfo':     updateServerInfo(msg.data); break;
  }
}

// ═══════════════════════════════════════
// PLAYER MANAGEMENT
// ═══════════════════════════════════════
function updatePlayerList(players) {
  STATE.players = {};
  players.forEach(p => { STATE.players[p.id] = p; });
  renderPlayerList();
  updatePlayerSelects();
  document.getElementById('playerCount').textContent = `${players.length}/64`;
}

function updatePlayer(player) {
  if (STATE.players[player.id]) {
    STATE.players[player.id] = { ...STATE.players[player.id], ...player };
  } else {
    STATE.players[player.id] = player;
  }
  renderPlayerList();
  if (STATE.selectedPlayer && STATE.selectedPlayer.id === player.id) {
    renderSelectedPlayer(STATE.players[player.id]);
  }
  if (STATE.spectatingPlayer && STATE.spectatingPlayer.id === player.id) {
    updateSpectateHUD(STATE.players[player.id]);
  }
}

function onPlayerJoin(player) {
  STATE.players[player.id] = player;
  renderPlayerList();
  updatePlayerSelects();
  addEvent('connect', '🔌', `<span style="color:var(--accent)">${player.name}</span> joined the server`);
  addAlert('info', `${player.name} joined the server`);
  document.getElementById('playerCount').textContent = `${Object.keys(STATE.players).length}/64`;
}

function onPlayerLeave(data) {
  const p = STATE.players[data.id];
  if (p) {
    addEvent('connect', '🔌', `<span style="color:var(--red)">${p.name}</span> left the server`);
    delete STATE.players[data.id];
    renderPlayerList();
    updatePlayerSelects();
    document.getElementById('playerCount').textContent = `${Object.keys(STATE.players).length}/64`;
  }
}

function renderPlayerList() {
  const list = document.getElementById('playerList');
  const players = Object.values(STATE.players);
  if (players.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);font-family:var(--mono);font-size:10px;text-align:center;padding:12px">No players online</div>';
    return;
  }
  list.innerHTML = players.map(p => `
    <div class="player-item ${STATE.selectedPlayer?.id === p.id ? 'selected' : ''}" onclick="selectPlayer(${p.id})">
      <div class="player-avatar">${p.name.charAt(0).toUpperCase()}</div>
      <div class="player-name">${escHtml(p.name)}</div>
      <div class="player-id">#${p.id}</div>
      <div class="player-ping ${pingClass(p.ping)}">${p.ping}ms</div>
    </div>
  `).join('');
}

function pingClass(ping) {
  if (ping < 80) return 'ping-good';
  if (ping < 150) return 'ping-mid';
  return 'ping-bad';
}

function selectPlayer(id) {
  STATE.selectedPlayer = STATE.players[id] || null;
  renderPlayerList();
  if (STATE.selectedPlayer) {
    renderSelectedPlayer(STATE.selectedPlayer);
    document.getElementById('playerActionButtons').classList.remove('hidden');
  }
}

function renderSelectedPlayer(p) {
  const card = document.getElementById('selectedPlayerInfo');
  card.innerHTML = `
    <div class="sp-name">${escHtml(p.name)}</div>
    <div class="sp-row"><span>ID</span><span>#${p.id}</span></div>
    <div class="sp-row"><span>PING</span><span class="${pingClass(p.ping)}">${p.ping}ms</span></div>
    <div class="sp-row"><span>HEALTH</span><span style="color:var(--green)">❤ ${p.health || 100}</span></div>
    <div class="sp-row"><span>COORDS</span><span style="font-size:9px">${fmtCoords(p.coords)}</span></div>
    <div class="sp-row"><span>JOB</span><span>${p.job || '—'}</span></div>
    <div class="sp-row"><span>CASH</span><span style="color:var(--green)">$${fmt(p.cash)}</span></div>
    <div class="sp-row"><span>BANK</span><span style="color:var(--green)">$${fmt(p.bank)}</span></div>
    <div class="sp-row"><span>VEHICLE</span><span>${p.vehicle || 'ON FOOT'}</span></div>
    <div class="sp-row"><span>WEAPON</span><span>${p.weapon || 'UNARMED'}</span></div>
    <div class="sp-row"><span>DISCORD</span><span>${p.discord || '—'}</span></div>
    <div class="sp-row"><span>PLAYTIME</span><span>${p.playtime || '—'}</span></div>
  `;
}

// ═══════════════════════════════════════
// GAME EVENTS
// ═══════════════════════════════════════
function onGameEvent(ev) {
  switch (ev.type) {
    case 'kill':
      STATE.serverStats.kills++;
      document.getElementById('statKills').textContent = STATE.serverStats.kills;
      addEvent('kill', '💀', `<span style="color:var(--accent)">${ev.killer}</span> killed <span style="color:var(--red)">${ev.victim}</span> with ${ev.weapon}`);
      addMapMarker({ type: 'kill', x: ev.x, y: ev.y, label: `${ev.killer} → ${ev.victim}` });
      if (ev.killer === STATE.spectatingPlayer?.name) addAlert('warn', `Your spectated player got a kill!`);
      break;
    case 'explosion':
      STATE.serverStats.explosions++;
      document.getElementById('statExplosions').textContent = STATE.serverStats.explosions;
      addEvent('explosion', '💥', `Explosion by <span style="color:var(--orange)">${ev.player}</span> [${ev.explosionType}]`);
      addMapMarker({ type: 'explosion', x: ev.x, y: ev.y, label: `${ev.player}: ${ev.explosionType}` });
      addAlert('warn', `Explosion by ${ev.player}: ${ev.explosionType}`);
      break;
    case 'itemDrop':
      STATE.serverStats.drops++;
      document.getElementById('statDrops').textContent = STATE.serverStats.drops;
      addEvent('drop', '📦', `<span style="color:var(--purple)">${ev.player}</span> dropped ${ev.count}x ${ev.item}`);
      break;
    case 'itemUse':
      addEvent('drop', '🔧', `<span style="color:var(--accent)">${ev.player}</span> used ${ev.item}`);
      break;
    case 'harvest':
      STATE.serverStats.harvests++;
      document.getElementById('statHarvest').textContent = STATE.serverStats.harvests;
      if (ev.item === 'weed_lbs' || ev.item === 'weed') STATE.serverStats.weedHarvested += ev.amount || 1;
      document.getElementById('ecoWeedHarvested').textContent = STATE.serverStats.weedHarvested + 'g';
      addEvent('harvest', '🌿', `<span style="color:var(--green)">${ev.player}</span> harvested ${ev.amount}x ${ev.item}`);
      addMapMarker({ type: 'harvest', x: ev.x, y: ev.y, label: `${ev.player}: ${ev.item}` });
      break;
    case 'moneyEarn':
      onTransaction({ player: ev.player, type: 'earn', amount: ev.amount, source: ev.source });
      addEvent('money', '💵', `<span style="color:var(--yellow)">${ev.player}</span> earned $${fmt(ev.amount)} [${ev.source}]`);
      break;
    case 'moneySpend':
      onTransaction({ player: ev.player, type: 'spend', amount: -ev.amount, source: ev.source });
      addEvent('money', '💸', `<span style="color:var(--red)">${ev.player}</span> spent $${fmt(ev.amount)} [${ev.source}]`);
      break;
    case 'moneyTransfer':
      onTransaction({ player: ev.from, type: 'transfer', amount: -ev.amount, target: ev.to });
      addEvent('money', '🔄', `<span style="color:var(--accent)">${ev.from}</span> → <span style="color:var(--accent)">${ev.to}</span> $${fmt(ev.amount)}`);
      break;
    case 'searchbar':
      addEvent('drop', '🔍', `<span style="color:var(--accent)">${ev.player}</span> searched <span style="color:var(--orange)">${ev.target}</span>`);
      break;
    case 'death':
      addEvent('kill', '☠', `<span style="color:var(--red)">${ev.player}</span> died`);
      break;
    case 'arrest':
      addEvent('kill', '🚔', `<span style="color:var(--yellow)">${ev.cop}</span> arrested <span style="color:var(--red)">${ev.criminal}</span>`);
      addAlert('warn', `Arrest: ${ev.cop} → ${ev.criminal}`);
      break;
    case 'robbery':
      addEvent('money', '🔫', `<span style="color:var(--red)">${ev.player}</span> is robbing ${ev.location}!`);
      addAlert('danger', `ROBBERY IN PROGRESS: ${ev.player} at ${ev.location}`);
      break;
    case 'vehicleSpawn':
      addEvent('connect', '🚗', `<span style="color:var(--accent)">${ev.player}</span> spawned ${ev.model}`);
      break;
  }
}

// ═══════════════════════════════════════
// TRANSACTION LOG
// ═══════════════════════════════════════
function onTransaction(tx) {
  STATE.transactions.unshift({ ...tx, time: new Date() });
  if (STATE.transactions.length > 100) STATE.transactions.pop();
  STATE.serverStats.transactions++;
  document.getElementById('ecoTransactions').textContent = STATE.serverStats.transactions;
  renderTransactions();
  updateEcoStats();
}

function renderTransactions() {
  const log = document.getElementById('transactionLog');
  log.innerHTML = STATE.transactions.slice(0, 50).map(tx => `
    <div class="tx-item">
      <span class="tx-type ${tx.type}">${tx.type.toUpperCase()}</span>
      <span class="tx-player">${escHtml(tx.player)}</span>
      ${tx.target ? `<span style="color:var(--text-dim)">→ ${escHtml(tx.target)}</span>` : ''}
      <span class="tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}">$${fmt(Math.abs(tx.amount))}</span>
      <span class="tx-time">${fmtTime(tx.time)}</span>
    </div>
  `).join('');
}

function updateEcoStats() {
  const players = Object.values(STATE.players);
  const totalCash = players.reduce((s, p) => s + (p.cash || 0), 0);
  const totalBank = players.reduce((s, p) => s + (p.bank || 0), 0);
  document.getElementById('ecoTotalCash').textContent = '$' + fmt(totalCash);
  document.getElementById('ecoTotalBank').textContent = '$' + fmt(totalBank);
  document.getElementById('statMoney').textContent = '$' + fmt(totalCash + totalBank);
}

// ═══════════════════════════════════════
// CHAT
// ═══════════════════════════════════════
function onChatMessage(msg) {
  STATE.chat.unshift(msg);
  if (STATE.chat.length > 100) STATE.chat.pop();
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (msg.admin ? ' admin-msg' : '');
  div.innerHTML = `<span class="chat-player">${escHtml(msg.player)}: </span>${escHtml(msg.message)}`;
  log.prepend(div);
  if (log.children.length > 50) log.lastChild.remove();
}

function sendAdminChat() {
  const input = document.getElementById('adminChatMsg');
  const msg = input.value.trim();
  if (!msg) return;
  sendWS('adminChat', { message: msg });
  onChatMessage({ player: '[ADMIN]', message: msg, admin: true });
  input.value = '';
}

// ═══════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════
function onInventoryData(data) {
  renderInventoryGrid(data.items, data.playerId);
}

function loadPlayerInventory() {
  const sel = document.getElementById('invPlayerSelect');
  const id = sel.value;
  if (!id) return;
  STATE.selectedInvPlayer = id;
  sendWS('getInventory', { playerId: parseInt(id) });
}

function renderInventoryGrid(items, playerId) {
  const grid = document.getElementById('inventoryGrid');
  if (!items || items.length === 0) {
    grid.innerHTML = '<div style="color:var(--text-dim);font-family:var(--mono);font-size:11px;padding:24px;text-align:center">Inventory empty</div>';
    return;
  }
  grid.innerHTML = items.map((item, i) => `
    <div class="inv-item ${STATE.selectedInvItem === i ? 'selected' : ''}" onclick="selectInvItem(${i})" data-item='${JSON.stringify(item)}'>
      <div class="inv-item-icon">${itemIcon(item.name)}</div>
      <div class="inv-item-name">${item.label || item.name}</div>
      <div class="inv-item-count">×${item.count}</div>
      <div class="inv-item-weight">${item.weight || '?'}kg</div>
    </div>
  `).join('');
}

function selectInvItem(i) {
  STATE.selectedInvItem = STATE.selectedInvItem === i ? null : i;
  const items = document.querySelectorAll('.inv-item');
  items.forEach((el, idx) => el.classList.toggle('selected', idx === STATE.selectedInvItem));
}

function filterInventory() {
  const q = document.getElementById('invSearch').value.toLowerCase();
  document.querySelectorAll('.inv-item').forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function getSelectedInvItem() {
  if (STATE.selectedInvItem === null) { alert('Select an item first'); return null; }
  return document.querySelectorAll('.inv-item')[STATE.selectedInvItem]?.dataset?.item;
}

function adminDropItem() {
  const itemData = getSelectedInvItem();
  if (!itemData || !STATE.selectedInvPlayer) return;
  const item = JSON.parse(itemData);
  if (confirm(`Drop ${item.name} from player #${STATE.selectedInvPlayer}?`)) {
    sendWS('adminDropItem', { playerId: parseInt(STATE.selectedInvPlayer), item: item.name, count: 1 });
  }
}

function adminUseItem() {
  const itemData = getSelectedInvItem();
  if (!itemData || !STATE.selectedInvPlayer) return;
  const item = JSON.parse(itemData);
  if (confirm(`Force use ${item.name} on player #${STATE.selectedInvPlayer}?`)) {
    sendWS('adminUseItem', { playerId: parseInt(STATE.selectedInvPlayer), item: item.name });
  }
}

function adminGiveItem() {
  showModal('GIVE ITEM', `
    <div>Give item to player #${STATE.selectedInvPlayer}</div>
    <input type="text" id="mItemName" placeholder="Item name (e.g. water)">
    <input type="number" id="mItemCount" placeholder="Count" value="1">
  `, () => {
    sendWS('adminGiveItem', {
      playerId: parseInt(STATE.selectedInvPlayer),
      item: document.getElementById('mItemName').value,
      count: parseInt(document.getElementById('mItemCount').value) || 1
    });
  });
}

function adminRemoveItem() {
  const itemData = getSelectedInvItem();
  if (!itemData || !STATE.selectedInvPlayer) return;
  const item = JSON.parse(itemData);
  showModal('REMOVE ITEM', `Remove all ${item.name} from player #${STATE.selectedInvPlayer}?`, () => {
    sendWS('adminRemoveItem', { playerId: parseInt(STATE.selectedInvPlayer), item: item.name });
  });
}

// ═══════════════════════════════════════
// ECONOMY ACTIONS
// ═══════════════════════════════════════
function adminGiveMoney() {
  const pid = document.getElementById('giveMoneyPlayer').value;
  const amount = parseInt(document.getElementById('giveMoneyAmount').value);
  const type = document.getElementById('giveMoneyType').value;
  if (!pid || !amount) return alert('Fill all fields');
  sendWS('adminGiveMoney', { playerId: parseInt(pid), amount, type });
  addEvent('money', '💵', `Admin gave $${fmt(amount)} ${type} to #${pid}`);
}

function adminTakeMoney() {
  const pid = document.getElementById('takeMoneyPlayer').value;
  const amount = parseInt(document.getElementById('takeMoneyAmount').value);
  const type = document.getElementById('takeMoneyType').value;
  if (!pid || !amount) return alert('Fill all fields');
  sendWS('adminTakeMoney', { playerId: parseInt(pid), amount, type });
  addEvent('money', '💸', `Admin took $${fmt(amount)} ${type} from #${pid}`);
}

function updatePlayerSelects() {
  const players = Object.values(STATE.players);
  const opts = '<option value="">Select Player</option>' + players.map(p =>
    `<option value="${p.id}">${escHtml(p.name)} (#${p.id})</option>`
  ).join('');
  ['invPlayerSelect', 'giveMoneyPlayer', 'takeMoneyPlayer'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
}

// ═══════════════════════════════════════
// PLAYER ACTIONS
// ═══════════════════════════════════════
function playerAction(action) {
  if (!STATE.selectedPlayer) return alert('Select a player first');
  const p = STATE.selectedPlayer;
  switch (action) {
    case 'kick':
      showModal('KICK PLAYER', `
        <div>Kicking: <strong>${p.name}</strong></div>
        <input type="text" id="mReason" placeholder="Reason...">
      `, () => sendWS('kickPlayer', { playerId: p.id, reason: document.getElementById('mReason').value }));
      break;
    case 'ban':
      showModal('BAN PLAYER', `
        <div>Banning: <strong>${p.name}</strong></div>
        <input type="text" id="mReason" placeholder="Reason...">
        <input type="text" id="mDuration" placeholder="Duration (e.g. 7d, permanent)">
      `, () => sendWS('banPlayer', { playerId: p.id, reason: document.getElementById('mReason').value, duration: document.getElementById('mDuration').value }));
      break;
    case 'spectate':
      startSpectate(p.id);
      break;
    case 'tp':
      sendWS('teleportTo', { playerId: p.id });
      addEvent('connect', '🔀', `Admin teleported to ${p.name}`);
      break;
    case 'freeze':
      sendWS('freezePlayer', { playerId: p.id });
      addEvent('kill', '🧊', `Admin froze ${p.name}`);
      break;
    case 'revive':
      sendWS('revivePlayer', { playerId: p.id });
      addEvent('connect', '💉', `Admin revived ${p.name}`);
      break;
    case 'heal':
      sendWS('healPlayer', { playerId: p.id });
      addEvent('connect', '❤', `Admin healed ${p.name}`);
      break;
    case 'strip':
      showModal('STRIP WEAPONS', `Remove all weapons from <strong>${p.name}</strong>?`, () => {
        sendWS('stripWeapons', { playerId: p.id });
      });
      break;
  }
}

function sendServerCommand(cmd) {
  switch (cmd) {
    case 'announce':
      showModal('ANNOUNCE', `<input type="text" id="mMsg" placeholder="Message to all players...">`, () => {
        sendWS('announce', { message: document.getElementById('mMsg').value });
      });
      break;
    case 'restart':
      showModal('RESTART SERVER', 'Are you sure you want to restart the server?', () => sendWS('restart', {}));
      break;
    case 'weather':
      showModal('SET WEATHER', `
        <select id="mWeather">
          <option value="CLEAR">Clear</option><option value="RAIN">Rain</option>
          <option value="THUNDER">Thunder</option><option value="FOGGY">Foggy</option>
          <option value="SNOWLIGHT">Snow</option>
        </select>
      `, () => sendWS('setWeather', { weather: document.getElementById('mWeather').value }));
      break;
    case 'time':
      showModal('SET TIME', `<input type="number" id="mHour" placeholder="Hour (0-23)" min="0" max="23">`, () => {
        sendWS('setTime', { hour: parseInt(document.getElementById('mHour').value) });
      });
      break;
  }
}

// ═══════════════════════════════════════
// SPECTATE
// ═══════════════════════════════════════
function startSpectate(playerId) {
  const p = STATE.players[playerId];
  if (!p) return;
  STATE.spectatingPlayer = p;
  sendWS('startSpectate', { playerId });
  document.getElementById('specInactive').style.display = 'none';
  updateSpectateHUD(p);
  switchTab('spectate');
  // Update info panel
  document.getElementById('sInfoId').textContent = '#' + p.id;
  document.getElementById('sInfoDiscord').textContent = p.discord || '—';
  document.getElementById('sInfoCash').textContent = '$' + fmt(p.cash);
  document.getElementById('sInfoBank').textContent = '$' + fmt(p.bank);
  document.getElementById('sInfoJob').textContent = p.job || '—';
  document.getElementById('sInfoVeh').textContent = p.vehicle || 'On foot';
  document.getElementById('sInfoPing').textContent = p.ping + 'ms';
  document.getElementById('sInfoTime').textContent = p.playtime || '—';
  startSpectateCanvas();
}

function onSpectateData(data) {
  if (!STATE.spectatingPlayer) return;
  if (data.playerId !== STATE.spectatingPlayer.id) return;
  updateSpectateHUD(data);
}

function updateSpectateHUD(p) {
  document.getElementById('specPlayerName').textContent = p.name || '—';
  document.getElementById('specHealth').textContent = `❤ ${p.health || 100}`;
  document.getElementById('specArmour').textContent = `🛡 ${p.armour || 0}`;
  document.getElementById('specCoords').textContent = fmtCoords(p.coords);
  document.getElementById('specSpeed').textContent = `${Math.round(p.speed || 0)} km/h`;
  document.getElementById('specWeapon').textContent = p.weapon || 'UNARMED';
}

function stopSpectate() {
  if (STATE.spectatingPlayer) sendWS('stopSpectate', { playerId: STATE.spectatingPlayer.id });
  STATE.spectatingPlayer = null;
  document.getElementById('specInactive').style.display = '';
  document.getElementById('specPlayerName').textContent = '— NOT SPECTATING —';
}

function spectateNext(dir) {
  const players = Object.values(STATE.players);
  if (!players.length) return;
  if (!STATE.spectatingPlayer) { startSpectate(players[0].id); return; }
  const idx = players.findIndex(p => p.id === STATE.spectatingPlayer.id);
  const next = players[(idx + dir + players.length) % players.length];
  startSpectate(next.id);
}

function setCamMode(mode) {
  STATE.camMode = mode;
  document.querySelectorAll('.spec-mode').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
}

// Spectate canvas simulation (real data from server irl)
function startSpectateCanvas() {
  const canvas = document.getElementById('spectateCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  let frame = 0;
  function draw() {
    if (!STATE.spectatingPlayer) return;
    frame++;
    ctx.fillStyle = '#000c1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Grid ground effect
    ctx.strokeStyle = 'rgba(0,200,255,0.05)';
    ctx.lineWidth = 1;
    const grid = 40;
    for (let x = 0; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = 0; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
    // Player dot
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const r = 12 + Math.sin(frame * 0.05) * 2;
    ctx.shadowColor = 'rgba(0,200,255,0.8)'; ctx.shadowBlur = 20;
    ctx.fillStyle = '#00c8ff'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(STATE.spectatingPlayer?.name?.charAt(0) || '?', cx, cy + 4);
    // Note
    ctx.fillStyle = 'rgba(0,200,255,0.4)'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
    ctx.fillText('— LIVE CAMERA FEED VIA SERVER —', canvas.width/2, canvas.height - 20);
    requestAnimationFrame(draw);
  }
  draw();
}

// ═══════════════════════════════════════
// LIVE MAP
// ═══════════════════════════════════════
let mapImg = null;
let mapCanvas, mapCtx;
let markerFade = [];

function initMap() {
  mapCanvas = document.getElementById('mapCanvas');
  mapCtx = mapCanvas.getContext('2d');
  resizeMap();
  window.addEventListener('resize', resizeMap);

  // Load the GTA V map image
  mapImg = new Image();
  mapImg.src = 'map.png'; // Place your GTA V map image here
  mapImg.onerror = () => { mapImg = null; }; // graceful fallback

  // Map drag
  mapCanvas.addEventListener('mousedown', e => {
    STATE.mapDragging = true;
    STATE.mapDragStart = { x: e.clientX - STATE.mapOffsetX, y: e.clientY - STATE.mapOffsetY };
  });
  mapCanvas.addEventListener('mousemove', e => {
    if (STATE.mapDragging) {
      STATE.mapOffsetX = e.clientX - STATE.mapDragStart.x;
      STATE.mapOffsetY = e.clientY - STATE.mapDragStart.y;
    }
    // Tooltip
    checkMapHover(e);
  });
  mapCanvas.addEventListener('mouseup', () => STATE.mapDragging = false);
  mapCanvas.addEventListener('mouseleave', () => {
    STATE.mapDragging = false;
    document.getElementById('mapTooltip').classList.add('hidden');
  });
  mapCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    STATE.mapScale = Math.max(0.3, Math.min(5, STATE.mapScale * factor));
  }, { passive: false });
  mapCanvas.addEventListener('click', e => { checkMapClick(e); });

  drawMap();
}

function resizeMap() {
  const container = mapCanvas.parentElement;
  mapCanvas.width = container.clientWidth;
  mapCanvas.height = container.clientHeight;
}

function gtaToCanvas(gx, gy) {
  const nx = (gx - CONFIG.gtaMinX) / (CONFIG.gtaMaxX - CONFIG.gtaMinX);
  const ny = (gy - CONFIG.gtaMinY) / (CONFIG.gtaMaxY - CONFIG.gtaMinY);
  const cx = nx * mapCanvas.width * STATE.mapScale + STATE.mapOffsetX;
  const cy = ny * mapCanvas.height * STATE.mapScale + STATE.mapOffsetY;
  return { x: cx, y: cy };
}

function canvasToGta(cx, cy) {
  const nx = (cx - STATE.mapOffsetX) / (mapCanvas.width * STATE.mapScale);
  const ny = (cy - STATE.mapOffsetY) / (mapCanvas.height * STATE.mapScale);
  return {
    x: nx * (CONFIG.gtaMaxX - CONFIG.gtaMinX) + CONFIG.gtaMinX,
    y: ny * (CONFIG.gtaMaxY - CONFIG.gtaMinY) + CONFIG.gtaMinY
  };
}

function drawMap() {
  requestAnimationFrame(drawMap);
  const ctx = mapCtx;
  const W = mapCanvas.width, H = mapCanvas.height;
  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#020810';
  ctx.fillRect(0, 0, W, H);

  // Map image or grid
  if (mapImg && mapImg.complete && mapImg.naturalWidth) {
    ctx.save();
    ctx.translate(STATE.mapOffsetX, STATE.mapOffsetY);
    ctx.scale(STATE.mapScale, STATE.mapScale);
    ctx.drawImage(mapImg, 0, 0, W, H);
    ctx.restore();
  } else {
    // Grid fallback
    ctx.save();
    ctx.translate(STATE.mapOffsetX, STATE.mapOffsetY);
    ctx.scale(STATE.mapScale, STATE.mapScale);
    const gSize = 80;
    ctx.strokeStyle = 'rgba(0,200,255,0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += gSize) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += gSize) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // Decorative zones
    const zones = [
      { gx: -1000, gy: -500, r: 300, label: 'DOWNTOWN', color: 'rgba(0,200,255,0.03)' },
      { gx: -150, gy: -1000, r: 200, label: 'AIRPORT', color: 'rgba(255,200,0,0.04)' },
      { gx: 1200, gy: 2000, r: 350, label: 'VINEWOOD', color: 'rgba(170,85,255,0.03)' },
      { gx: -2500, gy: 200, r: 250, label: 'CHUMASH', color: 'rgba(0,255,100,0.03)' },
    ];
    zones.forEach(z => {
      const pos = gtaToCanvas(z.gx, z.gy);
      const rScaled = z.r / (CONFIG.gtaMaxX - CONFIG.gtaMinX) * W * STATE.mapScale;
      const pp = { x: (z.gx - CONFIG.gtaMinX) / (CONFIG.gtaMaxX - CONFIG.gtaMinX) * W, y: (z.gy - CONFIG.gtaMinY) / (CONFIG.gtaMaxY - CONFIG.gtaMinY) * H };
      ctx.beginPath(); ctx.arc(pp.x, pp.y, rScaled / STATE.mapScale, 0, Math.PI * 2);
      ctx.fillStyle = z.color; ctx.fill();
      ctx.strokeStyle = 'rgba(0,200,255,0.1)'; ctx.lineWidth = 1 / STATE.mapScale; ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,255,0.25)';
      ctx.font = `${10 / STATE.mapScale}px 'Orbitron', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(z.label, pp.x, pp.y);
    });
    ctx.restore();
  }

  // Fade markers
  markerFade = markerFade.filter(m => Date.now() - m.time < 30000);

  // Draw event markers (fading)
  markerFade.forEach(m => {
    const age = (Date.now() - m.time) / 30000;
    const alpha = 1 - age;
    const pos = gtaToCanvas(m.x, m.y);
    const colors = { kill: '#ff2244', explosion: '#ff8800', harvest: '#00ff88', money: '#ffe000' };
    const icons = { kill: '💀', explosion: '💥', harvest: '🌿', money: '💵' };
    ctx.save();
    ctx.globalAlpha = alpha * 0.7;
    ctx.shadowColor = colors[m.type] || '#fff';
    ctx.shadowBlur = 10;
    ctx.fillStyle = colors[m.type] || '#fff';
    ctx.beginPath(); ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  });

  // Draw players
  const now = Date.now();
  Object.values(STATE.players).forEach(p => {
    if (!p.coords) return;
    const pos = gtaToCanvas(p.coords.x, p.coords.y);
    const isSpectating = STATE.spectatingPlayer?.id === p.id;
    const isSelected = STATE.selectedPlayer?.id === p.id;

    // Player dot
    ctx.save();
    ctx.shadowColor = isSpectating ? '#ff8800' : isSelected ? '#ffe000' : '#00c8ff';
    ctx.shadowBlur = isSpectating ? 20 : 12;
    ctx.fillStyle = isSpectating ? '#ff8800' : isSelected ? '#ffe000' : '#00c8ff';
    ctx.beginPath(); ctx.arc(pos.x, pos.y, isSpectating ? 8 : 6, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    // Direction indicator
    if (p.heading !== undefined) {
      const rad = (p.heading - 90) * Math.PI / 180;
      const len = 12;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(pos.x + Math.cos(rad) * len, pos.y + Math.sin(rad) * len);
      ctx.stroke();
    }

    // Name tag
    const tag = `#${p.id} ${p.name}`;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    const tw = ctx.measureText(tag).width;
    ctx.fillRect(pos.x - tw/2 - 4, pos.y - 22, tw + 8, 14);
    ctx.fillStyle = '#fff'; ctx.font = '10px "Share Tech Mono"'; ctx.textAlign = 'center';
    ctx.fillText(tag, pos.x, pos.y - 11);
    ctx.restore();
  });

  // HUD overlay
  ctx.fillStyle = 'rgba(0,200,255,0.5)';
  ctx.font = '10px "Share Tech Mono"';
  ctx.textAlign = 'left';
  ctx.fillText(`PLAYERS: ${Object.keys(STATE.players).length}  |  SCALE: ${STATE.mapScale.toFixed(2)}x`, 10, 14);
}

function addMapMarker(marker) {
  marker.time = Date.now();
  markerFade.push(marker);
}

function mapZoom(f) { STATE.mapScale = Math.max(0.3, Math.min(5, STATE.mapScale * f)); }
function mapReset() { STATE.mapScale = 1; STATE.mapOffsetX = 0; STATE.mapOffsetY = 0; }

function checkMapHover(e) {
  const rect = mapCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const tooltip = document.getElementById('mapTooltip');
  for (const p of Object.values(STATE.players)) {
    if (!p.coords) continue;
    const pos = gtaToCanvas(p.coords.x, p.coords.y);
    if (Math.abs(pos.x - mx) < 10 && Math.abs(pos.y - my) < 10) {
      tooltip.classList.remove('hidden');
      tooltip.style.left = (mx + 12) + 'px';
      tooltip.style.top = (my - 8) + 'px';
      tooltip.innerHTML = `<strong>#${p.id} ${escHtml(p.name)}</strong><br>Health: ${p.health || 100} | Job: ${p.job || '—'}<br>Cash: $${fmt(p.cash)} | Ping: ${p.ping}ms`;
      return;
    }
  }
  tooltip.classList.add('hidden');
}

function checkMapClick(e) {
  const rect = mapCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  for (const p of Object.values(STATE.players)) {
    if (!p.coords) continue;
    const pos = gtaToCanvas(p.coords.x, p.coords.y);
    if (Math.abs(pos.x - mx) < 10 && Math.abs(pos.y - my) < 10) {
      selectPlayer(p.id);
      return;
    }
  }
}

// ═══════════════════════════════════════
// SERVER STATS + INFO
// ═══════════════════════════════════════
function updateServerStats(stats) {
  Object.assign(STATE.serverStats, stats);
  document.getElementById('statKills').textContent = stats.kills || 0;
  document.getElementById('statExplosions').textContent = stats.explosions || 0;
  document.getElementById('statDrops').textContent = stats.drops || 0;
  document.getElementById('statHarvest').textContent = stats.harvests || 0;
  document.getElementById('statTps').textContent = stats.tps || 60;
  document.getElementById('ecoTransactions').textContent = stats.transactions || 0;
  updateEcoStats();
}

function updateServerInfo(info) {
  document.getElementById('serverName').textContent = info.name || 'FiveM Server';
  document.getElementById('playerCount').textContent = `${info.players}/${info.maxPlayers}`;
  STATE.uptime = info.uptime || 0;
}

function startUptimeCounter() {
  STATE.uptimeInterval = setInterval(() => {
    STATE.uptime++;
    const h = String(Math.floor(STATE.uptime / 3600)).padStart(2, '0');
    const m = String(Math.floor((STATE.uptime % 3600) / 60)).padStart(2, '0');
    const s = String(STATE.uptime % 60).padStart(2, '0');
    document.getElementById('serverUptime').textContent = `UP: ${h}:${m}:${s}`;
  }, 1000);
}

// ═══════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════
function addAlert(type, msg) {
  STATE.alerts.unshift({ type, msg, time: new Date() });
  const badge = document.getElementById('alertBadge');
  badge.textContent = STATE.alerts.length;
  const list = document.getElementById('alertsList');
  const colors = { danger: 'var(--red)', warn: 'var(--orange)', info: 'var(--accent)', success: 'var(--green)' };
  const div = document.createElement('div');
  div.style.cssText = `padding:10px 14px;border-left:3px solid ${colors[type]||'#fff'};font-family:var(--mono);font-size:11px;border-bottom:1px solid var(--border);`;
  div.innerHTML = `<span style="color:${colors[type]}">${type.toUpperCase()}</span>  ${escHtml(msg)}<span style="float:right;color:var(--text-dim)">${fmtTime(new Date())}</span>`;
  list.prepend(div);
}

function togglePanel(name) {
  const panel = document.getElementById(name + 'Panel');
  panel.classList.toggle('hidden');
  if (name === 'alerts' && !panel.classList.contains('hidden')) {
    document.getElementById('alertBadge').textContent = '0';
  }
}

// ═══════════════════════════════════════
// EVENT FEED
// ═══════════════════════════════════════
function addEvent(type, icon, text) {
  const feed = document.getElementById('eventFeed');
  const div = document.createElement('div');
  div.className = `event-item ${type}`;
  div.innerHTML = `<span class="event-icon">${icon}</span><span class="event-text">${text}</span><span class="event-time">${fmtTime(new Date())}</span>`;
  feed.prepend(div);
  while (feed.children.length > 80) feed.lastChild.remove();
}

// ═══════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════
document.getElementById('globalSearch').addEventListener('input', function() {
  const q = this.value.toLowerCase().trim();
  const results = document.getElementById('searchResults');
  if (!q) { results.classList.add('hidden'); return; }
  results.classList.remove('hidden');
  const matches = Object.values(STATE.players).filter(p =>
    p.name.toLowerCase().includes(q) ||
    String(p.id).includes(q) ||
    (p.discord && p.discord.toLowerCase().includes(q))
  );
  if (!matches.length) {
    results.innerHTML = '<div class="search-item" style="color:var(--text-dim)">No results</div>';
    return;
  }
  results.innerHTML = matches.slice(0, 8).map(p => `
    <div class="search-item" onclick="selectPlayer(${p.id}); document.getElementById('globalSearch').value=''; document.getElementById('searchResults').classList.add('hidden')">
      <strong>#${p.id}</strong> ${escHtml(p.name)} — ${p.job || '?'} — $${fmt(p.cash)}
    </div>
  `).join('');
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrapper')) {
    document.getElementById('searchResults').classList.add('hidden');
  }
});

// ═══════════════════════════════════════
// TABS
// ═══════════════════════════════════════
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event?.target?.classList.add('active');
  // Fix: handle programmatic switch
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.getAttribute('onclick')?.includes(name)) b.classList.add('active');
  });
}

// ═══════════════════════════════════════
// MODAL
// ═══════════════════════════════════════
let modalCb = null;
function showModal(title, body, onConfirm) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = body;
  document.getElementById('modal').classList.remove('hidden');
  modalCb = onConfirm;
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); modalCb = null; }
document.getElementById('modalConfirm').addEventListener('click', () => { if (modalCb) modalCb(); closeModal(); });
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal(); });

// ═══════════════════════════════════════
// DEMO MODE (no server connected)
// ═══════════════════════════════════════
function startDemoMode() {
  if (STATE.demoMode) return;
  STATE.demoMode = true;
  console.log('[NEXUS] Running in DEMO mode');
  setConnectionState(false, 'Running in DEMO mode');
  addAlert('warn', 'Running in DEMO mode — connect FiveM server resource to go live');

  // Inject fake players
  const names = ['Ricky_Bobello', 'DarkHorse99', 'XxSniperxX', 'TruckerBob', 'Jimothy_Law', 'WeedKing420', 'CopKiller', 'SilentRob'];
  const jobs = ['police', 'medic', 'mechanic', 'drug dealer', 'trucker', 'unemployed'];
  names.forEach((name, i) => {
    const p = {
      id: i + 1,
      name,
      ping: Math.floor(Math.random() * 150 + 20),
      health: Math.floor(Math.random() * 100),
      armour: Math.floor(Math.random() * 100),
      coords: { x: Math.random() * 4000 - 2000, y: Math.random() * 4000 - 2000, z: 30 },
      heading: Math.random() * 360,
      job: jobs[i % jobs.length],
      cash: Math.floor(Math.random() * 50000),
      bank: Math.floor(Math.random() * 500000),
      vehicle: Math.random() > 0.5 ? ['Sultan', 'Elegy', 'Zentorno', 'Contender'][i % 4] : null,
      weapon: Math.random() > 0.6 ? ['WEAPON_PISTOL', 'WEAPON_AK47', 'WEAPON_SNIPER'][i % 3] : null,
      discord: '123456789' + i,
      playtime: Math.floor(Math.random() * 200) + 'h',
      speed: Math.random() * 120,
    };
    STATE.players[p.id] = p;
  });

  updatePlayerList(Object.values(STATE.players));
  updatePlayerSelects();

  // Demo events
  const demoEvents = [
    () => {
      const ps = Object.values(STATE.players);
      const killer = ps[Math.floor(Math.random() * ps.length)];
      const victim = ps[Math.floor(Math.random() * ps.length)];
      if (killer && victim && killer.id !== victim.id) {
        onGameEvent({ type: 'kill', killer: killer.name, victim: victim.name, weapon: 'WEAPON_PISTOL', x: killer.coords.x, y: killer.coords.y });
      }
    },
    () => {
      const ps = Object.values(STATE.players);
      const p = ps[Math.floor(Math.random() * ps.length)];
      if (p) onGameEvent({ type: 'explosion', player: p.name, explosionType: 'GRENADE', x: p.coords.x, y: p.coords.y });
    },
    () => {
      const ps = Object.values(STATE.players);
      const p = ps[Math.floor(Math.random() * ps.length)];
      if (p) {
        onGameEvent({ type: 'harvest', player: p.name, item: 'weed_lbs', amount: Math.floor(Math.random() * 10 + 1), x: p.coords.x, y: p.coords.y });
      }
    },
    () => {
      const ps = Object.values(STATE.players);
      const p = ps[Math.floor(Math.random() * ps.length)];
      if (p) onGameEvent({ type: 'moneyEarn', player: p.name, amount: Math.floor(Math.random() * 5000 + 100), source: ['job', 'weed sale', 'robbery', 'drug deal'][Math.floor(Math.random()*4)] });
    },
    () => {
      const ps = Object.values(STATE.players);
      const p = ps[Math.floor(Math.random() * ps.length)];
      if (p) onGameEvent({ type: 'itemDrop', player: p.name, item: 'lockpick', count: 1 });
    },
    () => {
      const ps = Object.values(STATE.players);
      const p = ps[Math.floor(Math.random() * ps.length)];
      if (p) {
        p.coords.x += (Math.random() - 0.5) * 100;
        p.coords.y += (Math.random() - 0.5) * 100;
        p.heading = Math.random() * 360;
        p.speed = Math.random() * 120;
        p.ping = Math.floor(Math.random() * 200 + 10);
      }
    },
    () => {
      const ps = Object.values(STATE.players);
      const p = ps[Math.floor(Math.random() * ps.length)];
      if (p) onGameEvent({ type: 'searchbar', player: p.name, target: ps[(Math.floor(Math.random()*ps.length))].name });
    },
  ];

  setInterval(() => {
    const ev = demoEvents[Math.floor(Math.random() * demoEvents.length)];
    ev();
  }, 2000);

  // Demo inventory
  const demoInv = [
    { name: 'water', label: 'Water Bottle', count: 3, weight: 0.5 },
    { name: 'bread', label: 'Bread', count: 1, weight: 0.5 },
    { name: 'lockpick', label: 'Lockpick', count: 5, weight: 0.1 },
    { name: 'weed_lbs', label: 'Weed Lbs', count: 12, weight: 0.3 },
    { name: 'pistol', label: 'Pistol', count: 1, weight: 2 },
    { name: 'phone', label: 'Phone', count: 1, weight: 0.2 },
    { name: 'id_card', label: 'ID Card', count: 1, weight: 0.1 },
    { name: 'cash', label: 'Cash', count: 2500, weight: 0.01 },
    { name: 'bandage', label: 'Bandage', count: 4, weight: 0.3 },
    { name: 'armor', label: 'Body Armor', count: 1, weight: 5 },
    { name: 'ammo_pistol', label: 'Pistol Ammo', count: 120, weight: 0.5 },
    { name: 'coke', label: 'Cocaine', count: 8, weight: 0.2 },
  ];
  setTimeout(() => renderInventoryGrid(demoInv, 1), 500);
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function fmt(n) { return (n || 0).toLocaleString(); }
function fmtTime(d) { return d.toTimeString().slice(0,8); }
function fmtCoords(c) { return c ? `${Math.round(c.x)}, ${Math.round(c.y)}, ${Math.round(c.z)}` : '— — —'; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function itemIcon(name) {
  const icons = {
    water:'💧', bread:'🍞', lockpick:'🔑', weed:'🌿', weed_lbs:'🌿', pistol:'🔫',
    phone:'📱', id_card:'🪪', cash:'💵', bandage:'🩹', armor:'🛡', ammo_pistol:'🔸',
    coke:'❄️', heroin:'💊', meth:'🔬', knife:'🔪', rifle:'🔫', shotgun:'🔫',
    medkit:'🧰', food:'🍔', beer:'🍺', cigarette:'🚬', radio:'📻',
  };
  for (const [k, v] of Object.entries(icons)) if (name?.includes(k)) return v;
  return '📦';
}

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  startUptimeCounter();
  connectWS();

  // Initial demo data for transaction log
  setTimeout(() => {
    if (Object.keys(STATE.players).length === 0) return;
    const ps = Object.values(STATE.players);
  }, 1000);

  console.log('[NEXUS] Dashboard initialized');
});
