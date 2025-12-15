// ============================================================
// 像素小镇 - 主逻辑
// ============================================================

// -------------------- 配置与常量 --------------------
const CONFIG = {
  portraitsBase: "/static/portraits/",
  portraitCount: 15,
  travelDuration: 260,
};

// -------------------- 数据模型 - 统一的 localStorage 管理 --------------------
const STORAGE_KEYS = {
  AGENT_CONFIGS: "AgentConfigs.v1",
  GAME_OPTIONS: "GameOptions.v1",  // 存储 /api/options 返回的游戏配置
  WEB_CONFIG_LOADED: "WebConfigLoaded.v1",  // 标记是否已加载过 web_config.yaml
  LAST_GAME_OPTIONS: "LastGameOptions.v1",  // 存储上次选择的游戏配置
  CONFIG_UPDATE_TIME: "ConfigUpdateTime.v1",  // 配置更新时间戳
};

// 加载角色配置（从 localStorage）
function loadAgentConfigs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.AGENT_CONFIGS);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// 保存角色配置（到 localStorage）
function saveAgentConfigs(configs) {
  try {
    localStorage.setItem(STORAGE_KEYS.AGENT_CONFIGS, JSON.stringify(configs));
  } catch (e) {
    console.error("Failed to save agent configs:", e);
  }
}

// 加载游戏配置（从 localStorage）
function loadGameOptions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.GAME_OPTIONS);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// 保存游戏配置（到 localStorage）
function saveGameOptions(options) {
  try {
    localStorage.setItem(STORAGE_KEYS.GAME_OPTIONS, JSON.stringify(options));
  } catch (e) {
    console.error("Failed to save game options:", e);
  }
}

// 检查是否首次加载（或需要重新加载 web_config.yaml）
function shouldLoadWebConfig() {
  const loaded = localStorage.getItem(STORAGE_KEYS.WEB_CONFIG_LOADED);
  return !loaded || loaded !== "true";
}

// 标记 web_config.yaml 已加载
function markWebConfigLoaded() {
  localStorage.setItem(STORAGE_KEYS.WEB_CONFIG_LOADED, "true");
}

// 从后端获取 web_config.yaml 配置并更新到 localStorage（仅在首次加载时调用）
async function loadWebConfig() {
  if (window.location.protocol === "file:") {
    return; // 本地文件协议不支持 fetch
  }
  
  // 检查是否已加载过
  if (!shouldLoadWebConfig()) {
    return;
  }
  
  try {
    const resp = await fetch("/api/options"); // 不带 game 参数，返回 web_config.yaml
    if (!resp.ok) {
      console.warn("Failed to fetch web config:", resp.status);
      return;
    }
    
    const webOpts = await resp.json();
    const portraits = webOpts.portraits || {};
    
    // 合并到现有的 localStorage 配置中
    const existingConfigs = loadAgentConfigs();
    let updated = false;
    
    for (const [idStr, portraitCfg] of Object.entries(portraits)) {
      const id = parseInt(idStr, 10);
      if (isNaN(id) || id < 1 || id > CONFIG.portraitCount) continue;
      
      // 如果 web_config.yaml 中有 name，且 localStorage 中没有，则更新
      if (portraitCfg && typeof portraitCfg === "object" && portraitCfg.name) {
        if (!existingConfigs[id] || !existingConfigs[id].name) {
          if (!existingConfigs[id]) {
            existingConfigs[id] = {};
          }
          existingConfigs[id].name = portraitCfg.name;
          updated = true;
        }
      }
    }
    
    if (updated) {
      saveAgentConfigs(existingConfigs);
    }
    
    // 标记已加载
    markWebConfigLoaded();
  } catch (e) {
    console.warn("Failed to load web config:", e);
  }
}


// Avalon role mapping (role_name -> role_id)
const AVALON_ROLE_MAP = {
  "Merlin": 0,
  "Percival": 1,
  "Servant": 2,
  "Minion": 3,
  "Assassin": 4,
};
const AVALON_GOOD_ROLES = ["Merlin", "Percival", "Servant"];

const state = {
  selectedIds: new Set(),
  selectedIdsOrder: [],  // 保持选中顺序的数组
  selectedGame: "",
  selectedMode: "observe",
  diplomacyOptions: null,
  // 预览结果（用于下发给后端）
  diplomacyPowerOrder: null,
  avalonRoleOrder: null,
  avalonPreviewRoles: null,  // [{role_id, role_name, is_good}, ...]
  diplomacyPreviewPowers: null,  // [power_name, ...]
  // 拖拽相关
  dragState: {
    isDragging: false,
    draggedSeat: null,
    draggedIndex: -1,
  },
};

// DOM 引用 - 将在init中初始化
let DOM = {};

// -------------------- 工具函数 --------------------
function polarPositions(count, radiusX, radiusY) {
  return Array.from({ length: count }).map((_, i) => {
    const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
    return { x: radiusX * Math.cos(angle), y: radiusY * Math.sin(angle) };
  });
}

function computeRedirectUrl(game, mode) {
  if (window.location.protocol !== "file:") return `/${game}/${mode}`;
  return `./static/${game}/${mode}.html`;
}

// -------------------- 状态消息 --------------------
function addStatusMessage(text) {
  if (!DOM.statusLog) return;

  const bubble = document.createElement("div");
  bubble.className = "status-bubble";
  bubble.textContent = text;
  DOM.statusLog.appendChild(bubble);

  // 限制消息数量，最多保留20条
  while (DOM.statusLog.children.length > 20) {
    DOM.statusLog.removeChild(DOM.statusLog.firstChild);
  }

  // 自动滚动到底部
  setTimeout(() => {
    if (DOM.statusLog) {
      DOM.statusLog.scrollTop = DOM.statusLog.scrollHeight;
    }
  }, 50);
}

// -------------------- 桌面预览布局 --------------------
function ensureSeat(id) {
  if (!DOM.tablePlayers) return null;
  
  let seat = DOM.tablePlayers.querySelector(`.seat[data-id="${id}"]`);
  if (seat) return seat;
  
  seat = document.createElement("div");
  seat.className = "seat enter";
  seat.dataset.id = String(id);
  const isHuman = String(id) === "human";
  const src = isHuman ? `${CONFIG.portraitsBase}portrait_human.png` : `${CONFIG.portraitsBase}portrait_${id}.png`;
  const alt = isHuman ? "Human" : `Agent ${id}`;
  seat.innerHTML = `
    <div class="seat-label"></div>
    <img src="${src}" alt="${alt}">
  `;
  seat.style.left = "50%";
  seat.style.top = "50%";
  seat.style.transform = "translate(-50%, -50%) scale(0.8)";
  seat.style.pointerEvents = "auto"; // 确保可以接收事件
  seat.style.cursor = isHuman ? "default" : "pointer";
  DOM.tablePlayers.appendChild(seat);
  
  requestAnimationFrame(() => seat.classList.remove("enter"));
  return seat;
}

function setSeatLabelBySeatId(seatId, text) {
  const el = DOM.tablePlayers && DOM.tablePlayers.querySelector(`.seat[data-id="${seatId}"]`);
  if (!el) return;
  const label = el.querySelector(".seat-label");
  if (!label) return;
  if (!text) {
    el.classList.remove("has-label");
    label.textContent = "";
    return;
  }
  label.textContent = String(text);
  el.classList.add("has-label");
}

// 参与模式：不显示预览 & random 强制置灰
function shouldShowPreview() {
  return state.selectedMode !== "participate";
}

function setRandomButtonsEnabled() {
  const disabled = state.selectedMode === "participate";
  const aBtn = document.getElementById("avalon-reroll-roles");
  const dBtn = document.getElementById("diplomacy-shuffle-powers");
  if (aBtn) aBtn.disabled = disabled;
  if (dBtn) dBtn.disabled = disabled;
}

function requiredCountForPreview() {
  const game = state.selectedGame;
  if (!game) return 0;
  if (game === "avalon") return 5;      // 仅观战预览 5 人
  if (game === "diplomacy") return 7;   // 仅观战预览 7 人
  return 0;
}

// Avalon(5人) 前端复刻 roles assign：与后端 engine.py 的思想一致（不保证与后端完全一致，因后端仍随机）
function avalonAssignRolesFor5() {
  // 固定 5 人：2 evil(Assassin+Minion) + 3 good(Merlin+Percival+Servant)
  // role 名称直接用于 UI 展示
  const roles = ["Merlin", "Percival", "Servant", "Minion", "Assassin"];
  // 洗牌
  return shuffleInPlace(roles.slice());
}

function updateTableHeadPreview() {
  if (!DOM.tablePlayers) return;

  // 先清空所有 label
  Array.from(DOM.tablePlayers.querySelectorAll(".seat")).forEach(seat => {
    const label = seat.querySelector(".seat-label");
    if (label) label.textContent = "";
    seat.classList.remove("has-label");
  });

  setRandomButtonsEnabled();

  if (!shouldShowPreview()) return;
  
  const game = state.selectedGame;
  const ids = state.selectedIdsOrder.filter(id => state.selectedIds.has(id));
  
  // 检查人数是否正确（observe 模式需要完整人数）
  if (game === "avalon" && ids.length !== 5) return;
  if (game === "diplomacy" && ids.length !== 7) return;

  if (game === "avalon") {
    if (!state.avalonRoleOrder || state.avalonRoleOrder.length !== 5) {
      state.avalonRoleOrder = avalonAssignRolesFor5();
    }
    // 存储预览结果，用于下发给后端
    state.avalonPreviewRoles = state.avalonRoleOrder.map((roleName, idx) => ({
      role_id: AVALON_ROLE_MAP[roleName] || 0,
      role_name: roleName,
      is_good: AVALON_GOOD_ROLES.includes(roleName),
    }));
    // 为每个 portrait id 设置 label
    ids.forEach((portraitId, idx) => {
      setSeatLabelBySeatId(String(portraitId), state.avalonRoleOrder[idx]);
    });
  } else if (game === "diplomacy") {
    const powers = (state.diplomacyPowerOrder && state.diplomacyPowerOrder.length === 7)
      ? state.diplomacyPowerOrder
      : (state.diplomacyOptions && Array.isArray(state.diplomacyOptions.powers) ? state.diplomacyOptions.powers.slice() : []);
    if (powers.length !== 7) return;
    // 存储预览结果，用于下发给后端
    state.diplomacyPreviewPowers = powers.slice();
    // 为每个 portrait id 设置 label
    ids.forEach((portraitId, idx) => {
      setSeatLabelBySeatId(String(portraitId), powers[idx]);
    });
  }
}

function layoutTablePlayers() {
  if (!DOM.tablePlayers) return;
  
  // 使用有序数组而不是Set
  const ids = state.selectedIdsOrder.filter(id => state.selectedIds.has(id));
  const wantHuman = state.selectedMode === "participate";
  
  // 在 participate 模式下，根据 user_agent_id 决定 human 的位置
  let keys = [];
  if (wantHuman) {
    const game = state.selectedGame;
    let userAgentId = 0;
    
    if (game === "avalon") {
      const userAgentEl = document.getElementById("avalon-user-agent-id");
      userAgentId = userAgentEl ? parseInt(userAgentEl.value, 10) : 0;
    } else if (game === "diplomacy") {
      // Diplomacy 使用 power 名称，需要转换为索引
      const hpEl = document.getElementById("diplomacy-human-power");
      const humanPower = hpEl ? hpEl.value : "";
      if (state.diplomacyOptions && state.diplomacyOptions.powers) {
        userAgentId = state.diplomacyOptions.powers.indexOf(humanPower);
        if (userAgentId === -1) userAgentId = 0;
      }
    }
    
    // 按游戏中的实际顺序构建 keys
    const totalPlayers = ids.length + 1;  // AI + human
    keys = [];
    for (let i = 0; i < totalPlayers; i++) {
      if (i === userAgentId) {
        keys.push("human");
      } else {
        // AI 玩家的索引：如果在 human 之前，直接用 i；如果在 human 之后，用 i-1
        const aiIndex = i < userAgentId ? i : (i - 1);
        if (aiIndex < ids.length) {
          keys.push(String(ids[aiIndex]));
        }
      }
    }
  } else {
    // observe 模式：只有 AI 玩家
    keys = ids.map((x) => String(x));
  }
  
  const keySet = new Set(keys);
  
  // 移除未选中的座位
  Array.from(DOM.tablePlayers.querySelectorAll(".seat")).forEach(el => {
    const key = String(el.dataset.id || "");
    if (!keySet.has(key)) {
      el.classList.add("leave");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
    }
  });
  
  if (!keys.length) return;
  
  // 确保所有座位存在
  keys.forEach(id => ensureSeat(id));
  
  // 布局计算
  const rect = DOM.tablePlayers.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const seatSize = 70;
  const radiusX = Math.min(280, Math.max(150, rect.width * 0.35));
  const radiusY = Math.min(125, Math.max(90, rect.height * 0.35));
  const positions = polarPositions(keys.length, radiusX, radiusY);
  
  // 应用位置和事件
  keys.forEach((id, i) => {
    const el = DOM.tablePlayers.querySelector(`.seat[data-id="${id}"]`);
    if (!el) return;
    
    // 应用位置和样式
    el.style.left = `${cx + positions[i].x - seatSize / 2}px`;
    el.style.top = `${cy + positions[i].y - seatSize / 2}px`;
    el.style.transform = `rotate(${(i % 2 ? 1 : -1) * 2}deg)`;
    el.style.zIndex = state.dragState.isDragging && state.dragState.draggedSeat === el ? "1000" : "1";
    el.style.cursor = id === "human" ? "default" : "pointer";
    el.style.pointerEvents = "auto"; // 确保可以点击
    
    // 只在元素还没有事件监听器标记时添加事件（通过检查 data-has-events 属性）
    if (id !== "human" && !el.dataset.hasEvents) {
      el.dataset.hasEvents = "true";
      
      // 点击取消选中
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const portraitId = parseInt(id, 10);
        if (!isNaN(portraitId)) {
          // 从上方人物列表中获取正确的名称，保持格式一致
          const portraitCard = DOM.strip?.querySelector(`.portrait-card[data-id="${portraitId}"]`);
          let agentName = `Agent ${portraitId}`;
          if (portraitCard) {
            const nameEl = portraitCard.querySelector(".portrait-name");
            if (nameEl) {
              agentName = nameEl.textContent.trim();
            }
          }
          toggleAgent({ id: portraitId, name: agentName }, null);
        }
      });
      
      // 拖拽开始
      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // 只处理左键
        e.stopPropagation();
        state.dragState.isDragging = true;
        state.dragState.draggedSeat = el;
        state.dragState.draggedIndex = keys.indexOf(id);
        el.style.opacity = "0.6";
        el.style.zIndex = "1000";
      });
    }
  });
  
  // 全局鼠标移动和释放事件
  if (!window._tableDragHandlersAdded) {
    window._tableDragHandlersAdded = true;
    let currentTargetSeat = null;
    
    document.addEventListener("mousemove", (e) => {
      if (!state.dragState.isDragging || !state.dragState.draggedSeat) return;
      
      // 找到当前鼠标下的seat
      const seatUnderMouse = document.elementFromPoint(e.clientX, e.clientY);
      const seat = seatUnderMouse?.closest?.(".seat");
      if (seat && seat !== state.dragState.draggedSeat && seat.dataset.id !== "human") {
        if (currentTargetSeat !== seat) {
          if (currentTargetSeat) {
            currentTargetSeat.style.borderColor = "";
            currentTargetSeat.style.transform = currentTargetSeat.style.transform.replace("scale(1.1)", "");
          }
          currentTargetSeat = seat;
          seat.style.borderColor = "var(--accent)";
          seat.style.transform = (seat.style.transform || "").replace(/scale\([^)]+\)/, "") + " scale(1.1)";
        }
      } else if (currentTargetSeat && (!seat || seat === state.dragState.draggedSeat || seat.dataset.id === "human")) {
        currentTargetSeat.style.borderColor = "";
        currentTargetSeat.style.transform = currentTargetSeat.style.transform.replace("scale(1.1)", "");
        currentTargetSeat = null;
      }
    });
    
    document.addEventListener("mouseup", (e) => {
      if (!state.dragState.isDragging) return;
      
      const draggedSeat = state.dragState.draggedSeat;
      const draggedId = draggedSeat.dataset.id;
      
      // 找到释放位置下的seat
      const seatUnderMouse = document.elementFromPoint(e.clientX, e.clientY);
      const targetSeat = seatUnderMouse?.closest?.(".seat");
      
      if (targetSeat && targetSeat !== draggedSeat && targetSeat.dataset.id !== "human") {
        const targetId = targetSeat.dataset.id;
        const draggedPortraitId = parseInt(draggedId, 10);
        const targetPortraitId = parseInt(targetId, 10);
        
        if (!isNaN(draggedPortraitId) && !isNaN(targetPortraitId)) {
          // 交换顺序
          const draggedIdx = state.selectedIdsOrder.indexOf(draggedPortraitId);
          const targetIdx = state.selectedIdsOrder.indexOf(targetPortraitId);
          
          if (draggedIdx !== -1 && targetIdx !== -1) {
            [state.selectedIdsOrder[draggedIdx], state.selectedIdsOrder[targetIdx]] = 
              [state.selectedIdsOrder[targetIdx], state.selectedIdsOrder[draggedIdx]];
            
            // 重新布局
            layoutTablePlayers();
            addStatusMessage(`Swapped positions`);
          }
        }
      }
      
      // 重置拖拽状态
      if (currentTargetSeat) {
        currentTargetSeat.style.borderColor = "";
        currentTargetSeat.style.transform = currentTargetSeat.style.transform.replace("scale(1.1)", "");
        currentTargetSeat = null;
      }
      
      if (draggedSeat) {
        draggedSeat.style.opacity = "";
        draggedSeat.style.zIndex = "";
      }
      
      state.dragState.isDragging = false;
      state.dragState.draggedSeat = null;
      state.dragState.draggedIndex = -1;
    });
  }

  // 更新头顶预览（依赖 seat 已存在且定位完成）
  updateTableHeadPreview();
}

// -------------------- 人物选择 --------------------
function updateCounter() {
  if (DOM.counterEl) {
    DOM.counterEl.textContent = `${state.selectedIds.size}`;
  }
  updateSelectionHint();
}

function updateSelectionHint() {
  const game = state.selectedGame;
  const mode = state.selectedMode;
  const selected = state.selectedIds.size;
  const hintPill = document.getElementById('selection-hint-pill');
  const hintEl = document.getElementById('selection-hint');
  
  if (!hintPill || !hintEl) return;
  
  let hint = '';
  let showHint = false;
  let required = 0;
  
  if (game === 'avalon') {
    // Observe 模式需要 5 人，Participate 模式需要 4 人（玩家自己是第5人）
    required = (mode === 'participate') ? 4 : 5;
    showHint = true;
    if (selected < required) {
      hint = `${required - selected} more`;
      hintPill.style.borderColor = '#ffdd57';
    } else if (selected === required) {
      hint = `✓ Correct`;
      hintPill.style.borderColor = '#51f6a5';
    } else {
      hint = `⚠ Exceed ${selected - required}`;
      hintPill.style.borderColor = '#ff6b6b';
    }
  } else if (game === 'diplomacy') {
    // Observe 模式需要 7 人，Participate 模式需要 6 人（玩家自己是第7人）
    required = (mode === 'participate') ? 6 : 7;
    showHint = true;
    if (selected < required) {
      hint = `${required - selected} more`;
      hintPill.style.borderColor = '#ffdd57';
    } else if (selected === required) {
      hint = `✓ Correct`;
      hintPill.style.borderColor = '#51f6a5';
    } else {
      hint = `⚠ Exceed ${selected - required}`;
      hintPill.style.borderColor = '#ff6b6b';
    }
  }
  
  if (showHint) {
    hintEl.textContent = hint;
    hintPill.style.display = 'inline-flex';
  } else {
    hintPill.style.display = 'none';
  }
}

function updatePortraitCardActiveState(portraitId, isActive) {
  // 更新上方人物列表中对应卡片的 active 状态
  if (!DOM.strip) return;
  const card = DOM.strip.querySelector(`.portrait-card[data-id="${portraitId}"]`);
  if (card) {
    if (isActive) {
      card.classList.add("active");
    } else {
      card.classList.remove("active");
    }
  }
}

function toggleAgent(person, card) {
  const existed = state.selectedIds.has(person.id);
  
  if (existed) {
    state.selectedIds.delete(person.id);
    // 从有序数组中移除
    const idx = state.selectedIdsOrder.indexOf(person.id);
    if (idx !== -1) {
      state.selectedIdsOrder.splice(idx, 1);
    }
    // 更新上方人物列表的 active 状态（即使 card 为 null 也要更新）
    if (card) {
      card.classList.remove("active");
    } else {
      updatePortraitCardActiveState(person.id, false);
    }
    updateCounter();
    layoutTablePlayers();
    addStatusMessage(`${person.name} left the team!`); 
    return;
  }
  
  state.selectedIds.add(person.id);
  // 添加到有序数组末尾
  if (!state.selectedIdsOrder.includes(person.id)) {
    state.selectedIdsOrder.push(person.id);
  }
  // 更新上方人物列表的 active 状态（即使 card 为 null 也要更新）
  if (card) {
    card.classList.add("active");
  } else {
    updatePortraitCardActiveState(person.id, true);
  }
  updateCounter();
  layoutTablePlayers();
  addStatusMessage(`${person.name} joined the team!`);
}

function renderPortraits() {
  if (!DOM.strip) return;
  
  // 先清空现有内容，避免重复渲染
  DOM.strip.innerHTML = "";
  
  const AgentConfigs = loadAgentConfigs();
  
  const portraits = Array.from({ length: CONFIG.portraitCount }).map((_, i) => {
    const id = i + 1;
    const cfg = AgentConfigs[id] || {};
    return {
      id,
      name: cfg.name || `Agent ${id}`,
      src: `${CONFIG.portraitsBase}portrait_${id}.png`,
    };
  });
  
  portraits.forEach(p => {
    const card = document.createElement("div");
    card.className = "portrait-card";
    // 如果这个角色已经被选中，添加 active 类
    if (state.selectedIds.has(p.id)) {
      card.classList.add("active");
    }
    card.dataset.id = String(p.id);
    card.innerHTML = `
      <img src="${p.src}" alt="${p.name}">
      <div class="portrait-name">${p.name}</div>
    `;
    card.addEventListener("click", () => toggleAgent(p, card));
    DOM.strip.appendChild(card);
  });
}

// -------------------- 游戏/模式选择 --------------------
function focusGame(game) {
  if (!DOM.gameCards) return;
  DOM.gameCards.forEach(c => c.classList.toggle("active", c.dataset.game === game));
}

function setGame(game) {
  state.selectedGame = game || "";
  focusGame(state.selectedGame);
  
  if (!state.selectedGame) {
    if (DOM.avalonFields) DOM.avalonFields.classList.remove("show");
    if (DOM.diplomacyFields) DOM.diplomacyFields.classList.remove("show");
    return;
  }
  
  addStatusMessage(`已选择游戏：${state.selectedGame}`);
  if (DOM.gameLabelEl) {
    DOM.gameLabelEl.textContent = state.selectedGame;
  }
  
  // 选择游戏后，从 localStorage 加载或从后端获取游戏配置
  if (state.selectedGame === "diplomacy") {
    // 检查是否需要刷新配置（如果上次选择的游戏不同，则刷新）
    const lastGame = localStorage.getItem(STORAGE_KEYS.LAST_GAME_OPTIONS);
    const forceRefresh = lastGame !== "diplomacy";
    if (forceRefresh) {
      localStorage.setItem(STORAGE_KEYS.LAST_GAME_OPTIONS, "diplomacy");
    }
    fetchDiplomacyOptions(forceRefresh);
  } else if (state.selectedGame === "avalon") {
    // Avalon 配置处理（如果需要的话）
    const lastGame = localStorage.getItem(STORAGE_KEYS.LAST_GAME_OPTIONS);
    const forceRefresh = lastGame !== "avalon";
    if (forceRefresh) {
      localStorage.setItem(STORAGE_KEYS.LAST_GAME_OPTIONS, "avalon");
      // 可以在这里加载 avalon 配置
    }
  }
  
  updateConfigVisibility();
  updateSelectionHint();
  updateTableHeadPreview();
}

function setMode(mode) {
  state.selectedMode = mode || "observe";
  
  // 更新 label 显示
  if (DOM.modeLabelEl) {
    DOM.modeLabelEl.textContent = state.selectedMode === "observe" ? "Observer" : "Participate";
  }
  
  // 更新 mode-opt 按钮的 active 状态
  if (DOM.modeToggle) {
    DOM.modeToggle.querySelectorAll(".mode-opt").forEach(opt => {
      opt.classList.toggle("active", opt.dataset.mode === state.selectedMode);
    });
  }
  
  updateConfigVisibility();
  updateSelectionHint(); // 模式改变时更新提示
  layoutTablePlayers(); // 重新布局以显示/隐藏人类头像
  // 参与模式需要强制隐藏预览并禁用 random
  updateTableHeadPreview();
}

function updateConfigVisibility() {
  const game = state.selectedGame;
  const mode = state.selectedMode;
  
  if (DOM.avalonFields) {
    DOM.avalonFields.classList.toggle("show", game === "avalon" && !!mode);
  }
  if (DOM.diplomacyFields) {
    DOM.diplomacyFields.classList.toggle("show", game === "diplomacy" && !!mode);
  }
  
  document.querySelectorAll(".avalon-participate-only").forEach(el => {
    el.style.display = (game === "avalon" && mode === "participate") ? "flex" : "none";
  });
  
  document.querySelectorAll(".diplomacy-participate-only").forEach(el => {
    el.style.display = (game === "diplomacy" && mode === "participate") ? "flex" : "none";
  });
  
  if (DOM.powerModelsSection) {
    DOM.powerModelsSection.style.display = (game === "diplomacy" && state.diplomacyOptions) ? "block" : "none";
  }
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// -------------------- Diplomacy 配置 --------------------
async function fetchDiplomacyOptions(forceRefresh = false) {
  try {
    if (window.location.protocol === "file:") {
      state.diplomacyOptions = null;
      updateConfigVisibility();
      return;
    }
    
    // 先尝试从 localStorage 读取
    const cachedOptions = loadGameOptions();
    if (!forceRefresh && cachedOptions.diplomacy) {
      state.diplomacyOptions = cachedOptions.diplomacy;
      state.diplomacyPowerOrder = Array.isArray(state.diplomacyOptions.powers) ? state.diplomacyOptions.powers.slice() : null;
    } else {
      // 从后端获取
      const resp = await fetch("/api/options?game=diplomacy");
      if (!resp.ok) throw new Error("Failed to fetch options");
      state.diplomacyOptions = await resp.json();
      state.diplomacyPowerOrder = Array.isArray(state.diplomacyOptions.powers) ? state.diplomacyOptions.powers.slice() : null;
      
      // 保存到 localStorage
      const gameOptions = loadGameOptions();
      gameOptions.diplomacy = state.diplomacyOptions;
      saveGameOptions(gameOptions);
    }
    
    // 填充 human power 下拉
    const hpSelect = document.getElementById("diplomacy-human-power");
    if (hpSelect && state.diplomacyOptions.powers) {
      hpSelect.innerHTML = "";
      state.diplomacyOptions.powers.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        hpSelect.appendChild(opt);
      });
    }
    
    // 填充 power models
    if (DOM.powerModelsGrid && state.diplomacyOptions.powers) {
      DOM.powerModelsGrid.innerHTML = "";
      state.diplomacyOptions.powers.forEach(power => {
        const item = document.createElement("div");
        item.className = "config-item";
        
        const label = document.createElement("label");
        label.textContent = power;
        
        const select = document.createElement("select");
        select.id = `power-model-${power}`;
        if (state.diplomacyOptions.models) {
          state.diplomacyOptions.models.forEach(m => {
            const opt = document.createElement("option");
            opt.value = m;
            opt.textContent = m;
            select.appendChild(opt);
          });
        }
        select.value = (state.diplomacyOptions.power_models && state.diplomacyOptions.power_models[power]) || 
                       (state.diplomacyOptions.defaults && state.diplomacyOptions.defaults.model_name);
        
        item.appendChild(label);
        item.appendChild(select);
        DOM.powerModelsGrid.appendChild(item);
      });
    }
    
    // 设置默认值
    if (state.diplomacyOptions.defaults) {
      const maxPhasesEl = document.getElementById("diplomacy-max-phases");
      const negRoundsEl = document.getElementById("diplomacy-negotiation-rounds");
      const langEl = document.getElementById("diplomacy-language");
      
      if (maxPhasesEl) maxPhasesEl.value = state.diplomacyOptions.defaults.max_phases;
      if (negRoundsEl) negRoundsEl.value = state.diplomacyOptions.defaults.negotiation_rounds;
      if (langEl) langEl.value = state.diplomacyOptions.defaults.language;
    }
    
    updateConfigVisibility();
    updateTableHeadPreview();
  } catch (e) {
    console.error("Failed to fetch diplomacy options:", e);
    state.diplomacyOptions = null;
    updateConfigVisibility();
  }
}

// -------------------- 游戏启动 --------------------
function buildPayload(game, mode) {
  const payload = { game, mode };
  
  if (game === "avalon") {
    const numPlayersEl = document.getElementById("avalon-num-players");
    const languageEl = document.getElementById("avalon-language");
    const userAgentEl = document.getElementById("avalon-user-agent-id");
    
    payload.num_players = numPlayersEl ? parseInt(numPlayersEl.value, 10) : 5;
    payload.language = languageEl ? languageEl.value : "en";
    if (mode === "participate" && userAgentEl) {
      payload.user_agent_id = parseInt(userAgentEl.value, 10);
    }
    
    // 下发预览的 preset_roles（如果有）
    if (state.avalonPreviewRoles && state.avalonPreviewRoles.length > 0) {
      payload.preset_roles = state.avalonPreviewRoles;
    }
    
    // 下发选择的 portrait ids（保持顺序）
    payload.selected_portrait_ids = state.selectedIdsOrder.filter(id => state.selectedIds.has(id));
    
    // 读取并传递 agent 配置（从 localStorage）
    const agentConfigs = loadAgentConfigs();
    const agent_configs = {};
    payload.selected_portrait_ids.forEach(portraitId => {
      const config = agentConfigs[portraitId];
      if (config && (config.base_model || config.api_base || config.api_key)) {
        agent_configs[portraitId] = {
          base_model: config.base_model || "",
          api_base: config.api_base || "",
          api_key: config.api_key || "",
        };
      }
    });
    if (Object.keys(agent_configs).length > 0) {
      payload.agent_configs = agent_configs;
    }
    
  } else if (game === "diplomacy") {
    const maxPhasesEl = document.getElementById("diplomacy-max-phases");
    const negRoundsEl = document.getElementById("diplomacy-negotiation-rounds");
    const langEl = document.getElementById("diplomacy-language");
    const hpEl = document.getElementById("diplomacy-human-power");
    
    payload.max_phases = maxPhasesEl ? parseInt(maxPhasesEl.value, 10) : 20;
    payload.negotiation_rounds = negRoundsEl ? parseInt(negRoundsEl.value, 10) : 3;
    payload.language = langEl ? langEl.value : "en";
    
    if (mode === "participate" && hpEl && hpEl.value) {
      payload.human_power = hpEl.value;
    }
    
    // 下发打乱的 power_names（如果有预览结果就用预览，否则用默认顺序）
    if (state.diplomacyPreviewPowers && state.diplomacyPreviewPowers.length > 0) {
      payload.power_names = state.diplomacyPreviewPowers;
    } else if (state.diplomacyOptions && state.diplomacyOptions.powers && state.diplomacyOptions.powers.length === 7) {
      // participate 模式下可能没有预览，使用默认顺序
      payload.power_names = state.diplomacyOptions.powers.slice();
    }
    
    if (state.diplomacyOptions && state.diplomacyOptions.powers) {
      const power_models = {};
      state.diplomacyOptions.powers.forEach(power => {
        const sel = document.getElementById(`power-model-${power}`);
        if (sel) power_models[power] = sel.value;
      });
      payload.power_models = power_models;
    }
    
    // 读取并传递 agent 配置（从 localStorage）
    // Diplomacy 需要根据 power_names 的顺序映射到 selected_portrait_ids
    const agentConfigs = loadAgentConfigs();
    const agent_configs = {};
    const ids = state.selectedIdsOrder.filter(id => state.selectedIds.has(id));
    
    // 构建完整的 selected_portrait_ids 数组，长度与 power_names 一致
    // 在 participate 模式下，human player 位置插入 -1 作为占位符
    let fullPortraitIds = [];
    if (payload.power_names && payload.power_names.length > 0) {
        if (mode === "participate" && payload.human_power) {
          const humanPowerIndex = payload.power_names.indexOf(payload.human_power);
          let aiIndex = 0;
          for (let i = 0; i < payload.power_names.length; i++) {
            if (i === humanPowerIndex) {
              fullPortraitIds.push(-1);
            } else {
              if (aiIndex < ids.length) {
                fullPortraitIds.push(ids[aiIndex]);
                aiIndex++;
              } else {
                fullPortraitIds.push(-1);
              }
            }
          }
        } else {
          fullPortraitIds = ids.slice(0, payload.power_names.length);
          while (fullPortraitIds.length < payload.power_names.length) {
            fullPortraitIds.push(-1);
          }
        }
      } else {
        fullPortraitIds = ids;
      }
      
      if (payload.power_names && fullPortraitIds.length === payload.power_names.length) {
        payload.power_names.forEach((power, index) => {
          const portraitId = fullPortraitIds[index];
          if (portraitId !== -1 && portraitId !== null && portraitId !== undefined) {
            const config = agentConfigs[portraitId];
            if (config && (config.base_model || config.api_base || config.api_key)) {
              agent_configs[portraitId] = {
                base_model: config.base_model || "",
                api_base: config.api_base || "",
                api_key: config.api_key || "",
              };
            }
          }
        });
      }
      
      if (Object.keys(agent_configs).length > 0) {
        payload.agent_configs = agent_configs;
      }
      
      payload.selected_portrait_ids = fullPortraitIds;
  }
  
  return payload;
}

// -------------------- 下拉菜单控制 --------------------
function closeModeDropdown() {
  if (DOM.modeToggle) {
    DOM.modeToggle.classList.remove("open");
  }
}

// -------------------- 事件监听器 --------------------
function initEventListeners() {
  // 游戏卡片点击选择游戏
  if (DOM.gameCards) {
    DOM.gameCards.forEach(card => {
      card.addEventListener("click", () => {
        setGame(card.dataset.game);
      });
    });
  }
  
  // Mode 下拉按钮（打开/关闭菜单）
  if (DOM.modeToggle) {
    const pill = DOM.modeToggle.querySelector(".pill-mode");
    if (pill) {
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        DOM.modeToggle.classList.toggle("open");
      });
    }
    
    // Mode 选项点击
    DOM.modeToggle.querySelectorAll(".mode-opt").forEach(opt => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        setMode(opt.dataset.mode);
        closeModeDropdown();
        addStatusMessage(`已切换到 ${opt.dataset.mode === "observe" ? "观战" : "参与"} 模式`);
      });
    });
  }
  
  // 点击页面其他地方关闭下拉
  document.addEventListener("click", () => closeModeDropdown());
  
  // Avalon 人数变化时更新玩家 ID 选项
  const avalonNumPlayers = document.getElementById("avalon-num-players");
  if (avalonNumPlayers) {
    avalonNumPlayers.addEventListener("change", function() {
      const numPlayers = parseInt(this.value, 10);
      const userAgentSelect = document.getElementById("avalon-user-agent-id");
      if (userAgentSelect) {
        userAgentSelect.innerHTML = "";
        for (let i = 0; i < numPlayers; i++) {
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = String(i);
          userAgentSelect.appendChild(opt);
        }
      }
      // 目前 index 只支持 5 人；人数变化时刷新一次预览
      state.avalonRoleOrder = null;
      updateTableHeadPreview();
    });
  }
  
  // Avalon user_agent_id 变化时重新布局圆桌（participate 模式下人类头像位置会改变）
  const avalonUserAgentId = document.getElementById("avalon-user-agent-id");
  if (avalonUserAgentId) {
    avalonUserAgentId.addEventListener("change", function() {
      layoutTablePlayers();
      updateTableHeadPreview();
    });
  }
  
  // Avalon：重新随机角色分配（仅影响本次启动）
  if (DOM.avalonRerollRolesBtn) {
    DOM.avalonRerollRolesBtn.addEventListener("click", (e) => {
      e.preventDefault();
      // participate 模式强制禁用（按钮 disabled 但这里也再保护一次）
      if (state.selectedMode === "participate") return;
      state.avalonRoleOrder = avalonAssignRolesFor5();
      updateTableHeadPreview();
    });
  }

  // Diplomacy human_power 变化时重新布局圆桌（participate 模式下人类头像位置会改变）
  const diplomacyHumanPower = document.getElementById("diplomacy-human-power");
  if (diplomacyHumanPower) {
    diplomacyHumanPower.addEventListener("change", function() {
      layoutTablePlayers();
      updateTableHeadPreview();
    });
  }

  // Diplomacy：随机打乱 power_names（仅影响 index 圆桌预览，不影响实际后端开局）
  if (DOM.diplomacyShufflePowersBtn) {
    DOM.diplomacyShufflePowersBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (state.selectedMode === "participate") return;
      if (!state.diplomacyPowerOrder && state.diplomacyOptions && Array.isArray(state.diplomacyOptions.powers)) {
        state.diplomacyPowerOrder = state.diplomacyOptions.powers.slice();
      }
      if (state.diplomacyPowerOrder) shuffleInPlace(state.diplomacyPowerOrder);
      updateTableHeadPreview();
    });
  }
  
  // 开始游戏按钮
  if (DOM.startBtn) {
    DOM.startBtn.addEventListener("click", async () => {
      const game = state.selectedGame;
      const mode = state.selectedMode;
      const required =
        game === "avalon" ? (mode === "participate" ? 4 : 5) :
        game === "diplomacy" ? (mode === "participate" ? 6 : 7) :
        1;
      
      if (!game) {
        addStatusMessage("Please select a game on the right");
        return;
      }
      if (!mode) {
        addStatusMessage("Please select a mode");
        return;
      }
      if (state.selectedIds.size !== required) {
        addStatusMessage(`Currently selected ${state.selectedIds.size} agents, need to select ${Math.max(0, required - state.selectedIds.size)} more agents`);
        return;
      }
      
      try {
        DOM.startBtn.disabled = true;
        addStatusMessage("Preparing to start...");
        
        const payload = buildPayload(game, mode);
        
        // 清除旧的游戏相关缓存数据，避免页面使用过期数据
        const keysToKeep = ['gameConfig', 'selectedPortraits', 'gameLanguage'];
        Object.keys(sessionStorage).forEach(key => {
          if (!keysToKeep.includes(key)) {
            sessionStorage.removeItem(key);
          }
        });
        
        // 保存配置数据到 sessionStorage
        // 按游戏中的实际顺序保存头像（与圆桌布局顺序一致）
        const ids = state.selectedIdsOrder.filter(id => state.selectedIds.has(id));
        let selectedPortraitsArray = [];
        
        if (mode === "participate") {
          // participate 模式：按 user_agent_id 位置重新排列
          let userAgentId = 0;
          let numPlayers = 0;
          
          if (game === "avalon") {
            userAgentId = payload.user_agent_id || 0;
            numPlayers = payload.num_players || 5;
          } else if (game === "diplomacy") {
            // Diplomacy: 将 human_power 名称转换为索引
            const humanPower = payload.human_power || "";
            numPlayers = 7;
            if (state.diplomacyOptions && state.diplomacyOptions.powers) {
              userAgentId = state.diplomacyOptions.powers.indexOf(humanPower);
              if (userAgentId === -1) userAgentId = 0;
            }
          }
          
          for (let i = 0; i < numPlayers; i++) {
            if (i !== userAgentId) {
              const aiIndex = i < userAgentId ? i : (i - 1);
              if (aiIndex < ids.length) {
                selectedPortraitsArray.push(ids[aiIndex]);
              }
            }
          }
        } else {
          // observe 模式：直接保存
          selectedPortraitsArray = ids;
        }
        
        sessionStorage.setItem("gameConfig", JSON.stringify(payload));
        sessionStorage.setItem("selectedPortraits", JSON.stringify(selectedPortraitsArray));
        sessionStorage.setItem("gameLanguage", payload.language || "en");
        
        setTimeout(() => {
          // 添加时间戳参数强制浏览器不使用缓存的页面
          const url = computeRedirectUrl(game, mode);
          const timestamp = Date.now();
          const separator = url.includes('?') ? '&' : '?';
          window.location.href = `${url}${separator}_t=${timestamp}`;
        }, CONFIG.travelDuration + 300);
      } catch (e) {
        alert("启动失败: " + e.message);
        DOM.startBtn.disabled = false;
      }
    });
  }
  
  // 窗口大小变化时重新布局
  window.addEventListener("resize", () => layoutTablePlayers());
}

// -------------------- 初始化DOM引用 --------------------
function initDOM() {
  DOM = {
    strip: document.getElementById("portraits-strip"),
    tablePlayers: document.getElementById("table-players"),
    statusLog: document.getElementById("status-log"),
    counterEl: document.getElementById("counter"),
    gameLabelEl: document.getElementById("game-label"),
    modeLabelEl: document.getElementById("mode-label"),
    avalonFields: document.getElementById("avalon-fields"),
    diplomacyFields: document.getElementById("diplomacy-fields"),
    startBtn: document.getElementById("start-btn"),
    powerModelsSection: document.getElementById("power-models-section"),
    powerModelsGrid: document.getElementById("power-models-grid"),
    gameCards: Array.from(document.querySelectorAll(".game-card")),
    modeToggle: document.querySelector(".mode-toggle"),
    selectionHintPill: document.getElementById("selection-hint-pill"),
    selectionHint: document.getElementById("selection-hint"),
    avalonRerollRolesBtn: document.getElementById("avalon-reroll-roles"),
    diplomacyShufflePowersBtn: document.getElementById("diplomacy-shuffle-powers"),
  };
}

// -------------------- 初始化 --------------------
// 全局变量：跟踪配置更新时间
let lastConfigUpdateTime = localStorage.getItem(STORAGE_KEYS.CONFIG_UPDATE_TIME) || "0";

async function init() {
  // 首先初始化DOM引用
  initDOM();
  
  // 从后端加载 web_config.yaml 配置（角色名字等）- 仅在首次加载时
  await loadWebConfig();
  
  // 渲染人物（此时会使用更新后的配置）
  renderPortraits();
  updateCounter();
  layoutTablePlayers();
  
  // 设置默认模式
  setMode("observe");
  updateConfigVisibility();
  updateTableHeadPreview();
  
  // 初始化事件监听
  initEventListeners();
  
  // 监听页面焦点变化，当从 character_config 返回时重新加载配置
  let lastFocusTime = Date.now();
  
  window.addEventListener("focus", () => {
    // 避免频繁刷新（至少间隔 500ms）
    const now = Date.now();
    if (now - lastFocusTime < 500) return;
    lastFocusTime = now;
    
    // 检查配置是否已更新
    const currentUpdateTime = localStorage.getItem(STORAGE_KEYS.CONFIG_UPDATE_TIME) || "0";
    if (currentUpdateTime !== lastConfigUpdateTime) {
      lastConfigUpdateTime = currentUpdateTime;
      // 重新渲染角色列表（重新读取 localStorage 中的配置）
      renderPortraits();
    }
  });
  
  // 监听 storage 事件（跨标签页/窗口的配置变化）
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEYS.AGENT_CONFIGS) {
      // localStorage 中的配置已变化，重新渲染
      renderPortraits();
    }
  });
  
  // 监听自定义事件（同一窗口内的配置变化，由 character_config 页面触发）
  window.addEventListener('localStorageChange', () => {
    renderPortraits();
  });
  
  // 初始消息
  addStatusMessage("Welcome to Agent Arena!");
  addStatusMessage("Please select Agents and start the game...");
}

// DOM 加载完成后初始化
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
