/**
 * 指尖花语 · 手势花朵
 * 摄像头 + MediaPipe Hands + Three.js 粒子花朵
 *
 * 运行（必须 HTTP）：
 *   python3 -m http.server 8000   →   http://localhost:8000/
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ============================================================
 * 1. 配置
 * ============================================================ */
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

const CONFIG = {
  // 粒子数量：桌面 12000，手机 6000（移动端性能降档）
  particleCount: IS_MOBILE ? 6000 : 12000,
  petalLayers: 3,
  bloomMin: 0.32,
  bloomMax: 0.66,
  fistThreshold: 0.3,      // 单手握拳判定：tension < 0.3
  smoothing: 0.08,
  spreadEase: 0.1,
  tipInfluence: 0.25,
  autoRotate: 0.25,        // 360° 自动旋转速度（rad/s）
  // 鼠标/手指驱散
  mouseRepelRadius: 0.9,   // 驱散半径
  mouseRepelForce: 1.6,    // 驱散强度
  mouseSettleRate: 0.06,   // 移开后缓慢回拢的速率
  camera: { fov: 55, near: 0.1, far: 100 },
};

/* 花色主题：双拳碰撞时循环切换 */
const THEMES = [
  { name: '樱粉',
    layers: [
      { n: 6, R: 1.25, h: 0.30, colIn: 0xffb7d8, colOut: 0xff6fa5 },
      { n: 5, R: 0.90, h: 0.45, colIn: 0xd8b4ff, colOut: 0x9b5de5 },
      { n: 4, R: 0.55, h: 0.58, colIn: 0xfff0f6, colOut: 0xff9ecb },
    ]},
  { name: '蓝铃',
    layers: [
      { n: 6, R: 1.25, h: 0.30, colIn: 0x9fd0ff, colOut: 0x3a7bd5 },
      { n: 5, R: 0.90, h: 0.45, colIn: 0xcfe8ff, colOut: 0x5a8fd8 },
      { n: 4, R: 0.55, h: 0.58, colIn: 0xf0f8ff, colOut: 0x8fb3ff },
    ]},
  { name: '金盏',
    layers: [
      { n: 8, R: 1.30, h: 0.28, colIn: 0xfff0c0, colOut: 0xffaa33 },
      { n: 6, R: 0.95, h: 0.42, colIn: 0xffe89a, colOut: 0xffcc55 },
      { n: 4, R: 0.58, h: 0.56, colIn: 0xfff8e0, colOut: 0xffdd77 },
    ]},
  { name: '青瓷',
    layers: [
      { n: 5, R: 1.20, h: 0.32, colIn: 0x9ff0d8, colOut: 0x2e9e7e },
      { n: 4, R: 0.85, h: 0.46, colIn: 0xc8ffe8, colOut: 0x4fbf9f },
      { n: 3, R: 0.52, h: 0.58, colIn: 0xe8fff4, colOut: 0x7fdcb8 },
    ]},
];

const COL_TIP  = new THREE.Color(0xffe9f5);
const COL_CORE = new THREE.Color(0xffd166);

const state = {
  handDetected: false,
  targetSpread: 0,
  spread: 0,
  wrist: new THREE.Vector3(0, 0, 0),
  tip: new THREE.Vector3(0, 0, 0),
  /* 双手 */
  hands: [{ tension: 0, anchor: new THREE.Vector3(), tip3: new THREE.Vector3(), seen: false, facing: null },
          { tension: 0, anchor: new THREE.Vector3(), tip3: new THREE.Vector3(), seen: false, facing: null }],
  bothFistReady: false,
  bothFistHoldUntil: 0,
  themeIndex: 0,
  /* 手动平滑缓存（每手独立） */
  tensionSm: [0, 0],
  /* 鼠标驱散：鼠标在花朵局部空间（旋转前）的坐标 + 驱散强度（0~1） */
  mouse: {
    local: new THREE.Vector3(9999, 9999, 0),  // 远离花朵，默认不驱散
    strength: 0,
    ndc: new THREE.Vector2(9999, 9999),       // NDC
    active: false,
    // 长按拖拽旋转
    dragging: false,
    dragLastX: 0,
    dragLastY: 0,
    downTime: 0,        // 按下时刻
    longPressFired: false,
    rotY: 0,            // 花朵当前 y 旋转（由拖拽累积）
    rotYTarget: 0,
  },
  manual: false,
};

const el = {
  canvas: document.getElementById('glcanvas'),
  video: document.getElementById('video'),
  handCanvas: document.getElementById('handCanvas'),
  stateText: document.getElementById('stateText'),
  meterFill: document.getElementById('meterFill'),
  diag: document.getElementById('diag'),
  chipClosed: document.querySelector('.chip-closed'),
  chipOpen: document.querySelector('.chip-open'),
  errorBox: document.getElementById('errorBox'),
};
const handCtx = el.handCanvas.getContext('2d');

/** 诊断横幅（#diag 不存在时安全返回，绝不抛错） */
function diag(msg) {
  if (el.diag) el.diag.textContent = msg;
  else console.warn('[diag]', msg);
}

/* ============================================================
 * 2. 手势：MediaPipe Hands
 * ============================================================ */
const FINGER_TIPS = [4, 8, 12, 16, 20];
const FINGER_PIPS = [5, 9, 13, 17];
const WRIST = 0;
const TENSION_MIN = 1.05;
const TENSION_MAX = 1.85;

function dist2d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function computeTensionRaw(lm) {
  const w = lm[WRIST];
  let ratio = 0;
  for (let i = 0; i < FINGER_PIPS.length; i++) {
    const dRoot = dist2d(w, lm[FINGER_PIPS[i]]);
    const dTip  = dist2d(w, lm[FINGER_TIPS[i]]);
    if (dRoot > 1e-4) ratio += dTip / dRoot;
  }
  ratio /= FINGER_PIPS.length;
  return Math.max(0, Math.min(1, (ratio - TENSION_MIN) / (TENSION_MAX - TENSION_MIN)));
}

function smoothTension(idx, raw) {
  state.tensionSm[idx] += (raw - state.tensionSm[idx]) * CONFIG.smoothing;
  return state.tensionSm[idx];
}

function handAnchor(lm) {
  const w = lm[WRIST], m = lm[12];
  const fx = 1 - w.x, fy = w.y, mx = 1 - m.x, my = m.y;
  return {
    world:    new THREE.Vector3(fx * 2 - 1, 1 - fy, 0.6),
    worldTip: new THREE.Vector3(mx * 2 - 1, 1 - my, 0.6),
  };
}

/** 估算手掌朝向（腕→中指 方向）映射为花的 y 轴旋转角。
 *  手部在屏幕内转圈 → 花的朝向跟着全方位转动。 */
function handFacingAngle(lm, index = 0) {
  const w = lm[WRIST], m = lm[12];
  // 镜像后的屏幕坐标（x 取反，与 handAnchor 一致）
  const wx = 1 - w.x, wy = w.y;
  const mx = 1 - m.x, my = m.y;
  // 相对手腕的指向向量（屏幕系，y 向下）
  const vx = mx - wx, vy = my - wy;
  const len = Math.hypot(vx, vy) || 1;
  const ang = Math.atan2(vy / len, vx / len); // 手掌朝向角（0 = 朝右）
  // 转成花的 y 轴旋转：手朝上 → 花正面朝你；手转圈 → 花全方位转
  const faceY = -ang - Math.PI / 2;
  return faceY;
}

let hands = null;

/** 等待某个全局脚本就绪（MediaPipe CDN 异步加载） */
function waitForGlobal(name, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (typeof window[name] !== 'undefined') {
        clearInterval(iv); res();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv); rej(new Error(`CDN 脚本 ${name} 加载超时，请检查网络`));
      }
    }, 200);
  });
}

async function initHands() {
  await waitForGlobal('Hands');
  hands = new Hands({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
  });
  hands.setOptions({
    maxNumHands: 2,             // 支持双手
    modelComplexity: 0,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  hands.onResults(onHandsResults);
}

async function startCamera() {
  // 手机用前置摄像头，分辨率也降一档（省流量/省电）
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: IS_MOBILE ? 480 : 640,
      height: IS_MOBILE ? 360 : 480,
      facingMode: IS_MOBILE ? 'user' : 'user',
    },
    audio: false,
  });
  el.video.srcObject = stream;
  await new Promise((res) => {
    if (el.video.readyState >= 2) return res();
    el.video.onloadeddata = res;
    el.video.play().then(res).catch(res);
  });
  el.handCanvas.width  = el.video.videoWidth  || 640;
  el.handCanvas.height = el.video.videoHeight || 480;
  diagStats.videoReady = true;
  diagStats.videoSize = `${el.video.videoWidth}x${el.video.videoHeight}`;

  // MediaPipe 推理在 JS 端同步阻塞主线程，
  // 用 setInterval 控制在 ~15fps，与 rAF 渲染循环解耦
  const INFER_INTERVAL_MS = 66;
  inferTimer = setInterval(() => {
    if (!hands || el.video.readyState < 2 || state.manual || inferBusy) return;
    inferBusy = true;
    diagStats.sends++;
    try {
      hands.send({ image: el.video });
    } catch (e) {
      diagStats.sendErrors++;
      console.warn('[hands.send]', e);
    }
    setTimeout(() => { inferBusy = false; }, INFER_INTERVAL_MS * 0.8);
  }, INFER_INTERVAL_MS);

  // 每 2s 刷新一次诊断横幅（send / 结果回调 / 检测到手 三段计数）
  statsTimer = setInterval(updateDiagStats, 2000);
}

let inferTimer = null, inferBusy = false, statsTimer = null;
const diagStats = {
  sends: 0, sendErrors: 0, results: 0, handHits: 0,
  lastResultAt: 0, lastHandAt: 0, videoReady: false, videoSize: '-',
};

function updateDiagStats() {
  const s = diagStats;
  const now = performance.now();
  const sec = (ms) => ms ? `${((now - ms) / 1000).toFixed(0)}s前` : '无';
  const stage = !s.videoReady ? '视频未就绪'
    : s.sends === 0 ? '未开始推理'
    : s.results === 0 ? `推理中(${s.sends}次send，无结果回调)`
    : s.handHits === 0 ? `结果中(${s.results}帧，未检测到手)`
    : `检测到手 ✓`;
  diag(`[手势] 视频${s.videoReady?'就绪':'未就绪'}(${s.videoSize}) · ${s.sends}send/${s.results}结果/${s.handHits}手 · ${sec(s.lastResultAt)} · ${sec(s.lastHandAt)} · ${stage}${s.sendErrors?` · ${s.sendErrors}错误`:''}`);
}

function onHandsResults(results) {
  if (state.manual) return;
  diagStats.results++;
  diagStats.lastResultAt = performance.now();
  const vw = el.handCanvas.width, vh = el.handCanvas.height;
  handCtx.clearRect(0, 0, vw, vh);

  const lms = results.multiHandLandmarks || [];
  const now = performance.now();
  state.handDetected = lms.length > 0;

  // 每手独立处理；MediaPipe 不保证手的顺序稳定，按手腕 x 坐标排序（左/右）
  const sorted = [...lms].sort((a, b) => a[WRIST].x - b[WRIST].x);
  const count = Math.min(2, sorted.length);

  for (let i = 0; i < 2; i++) {
    const slot = state.hands[i];
    slot.seen = i < count;
    if (i >= count) continue;
    const lm = sorted[i];
    diagStats.handHits++;
    drawHand(lm, vw, vh, i);

    const raw = computeTensionRaw(lm);
    slot.tension = smoothTension(i, raw);
    const a = handAnchor(lm);
    slot.anchor.copy(a.world);
    slot.tip3.copy(a.worldTip);
  }

  diagStats.lastHandAt = now;

  // 目标绽放度：两手都有则取较大值（张开任意一只即可绽放），否则取有手的那只
  let target = 0;
  if (count === 2) target = Math.max(state.hands[0].tension, state.hands[1].tension);
  else if (count === 1) target = state.hands[0].seen ? state.hands[0].tension : 0;
  state.targetSpread = target;

  // 主锚点（用于 3D 牵引）：两手都有时取两手中点，单手取该手
  if (count === 2) {
    state.wrist.lerpVectors(state.hands[0].anchor, state.hands[1].anchor, 0.5);
    state.tip.lerpVectors(state.hands[0].tip3, state.hands[1].tip3, 0.5);
  } else if (count === 1 && state.hands[0].seen) {
    state.wrist.copy(state.hands[0].anchor);
    state.tip.copy(state.hands[0].tip3);
  }

  // 双拳检测：两手都握拳且持续 350ms → 切换花色主题（带冷却，防抖）
  const bothFist = count === 2 &&
    state.hands[0].tension < CONFIG.fistThreshold &&
    state.hands[1].tension < CONFIG.fistThreshold;
  if (bothFist && now - state.bothFistHoldUntil > 1500) {
    if (!state.bothFistReady) {
      state.bothFistReady = true;
      state.bothFistHoldStart = now;
    } else if (now - state.bothFistHoldStart > 350) {
      switchTheme();
      state.bothFistReady = false;
      state.bothFistHoldUntil = now;   // 1.5s 冷却
      state.bothFistHoldStart = 0;
    }
  } else {
    state.bothFistReady = false;
    state.bothFistHoldStart = 0;
  }

  updateHUD(count);
}

function drawHand(lm, vw, vh, handIndex = 0) {
  const p = (i) => ({ x: (1 - lm[i].x) * vw, y: lm[i].y * vh });
  const conn = [
    [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],[0,17],
  ];
  // 两只手用不同颜色，方便区分
  const lineCol = handIndex === 0 ? 'rgba(124,245,216,0.9)' : 'rgba(255,158,203,0.9)';
  const dotCol  = handIndex === 0 ? 'rgba(124,245,216,0.95)' : 'rgba(255,158,203,0.95)';
  handCtx.strokeStyle = lineCol;
  handCtx.lineWidth = 2;
  handCtx.beginPath();
  for (const [a, b] of conn) {
    const A = p(a), B = p(b);
    handCtx.moveTo(A.x, A.y); handCtx.lineTo(B.x, B.y);
  }
  handCtx.stroke();
  for (let i = 0; i < lm.length; i++) {
    const pt = p(i);
    handCtx.beginPath();
    handCtx.arc(pt.x, pt.y, i === 12 ? 5 : 3, 0, Math.PI * 2);
    handCtx.fillStyle = i === 12 ? '#ffd166' : dotCol;
    handCtx.fill();
  }
  // 标注 L / R
  handCtx.font = 'bold 14px sans-serif';
  handCtx.fillStyle = lineCol;
  handCtx.fillText(handIndex === 0 ? 'L' : 'R', p(0).x + 8, p(0).y - 8);
}

function updateHUD(handCount = 0) {
  const s = state.targetSpread;
  el.meterFill.style.width = `${(s * 100).toFixed(0)}%`;
  el.chipOpen.classList.toggle('active', s > CONFIG.bloomMax);
  el.chipClosed.classList.toggle('active', s < CONFIG.bloomMin);

  if (state.manual) {
    el.stateText.textContent = `手动模式 · ${(s * 100).toFixed(0)}%`;
    el.stateText.className = '';
    return;
  }
  if (!state.handDetected) {
    el.stateText.textContent = '未检测到手部，请进入画面';
    el.stateText.className = '';
    return;
  }

  const theme = THEMES[state.themeIndex].name;
  const handsLabel = handCount === 2 ? '双手 · ' : handCount === 1 ? '单 · ' : '';
  const bothFist = handCount === 2 &&
    state.hands[0].tension < CONFIG.fistThreshold &&
    state.hands[1].tension < CONFIG.fistThreshold;

  let label, cls;
  if (bothFist) { label = '双拳闭合 · 保持将换花色'; cls = 'closed'; }
  else if (s < CONFIG.bloomMin)      { label = `花苞闭合 · ${(s * 100).toFixed(0)}%`; cls = 'closed'; }
  else if (s > CONFIG.bloomMax)      { label = `正在绽放 · ${(s * 100).toFixed(0)}%`; cls = 'open'; }
  else                               { label = `过渡中 · ${(s * 100).toFixed(0)}%`;     cls = ''; }
  el.stateText.textContent = `${handsLabel}${label} · 花色：${theme}`;
  el.stateText.className = cls;
}

/* ============================================================
 * 3. Three.js 粒子花朵
 * ============================================================ */
let scene, camera, renderer, flowerPoints, heartField, testLight, orbit;

function buildPetal() {
  const N = CONFIG.particleCount;
  const positions = new Float32Array(N * 3);
  const budPos    = new Float32Array(N * 3);
  const colors    = new Float32Array(N * 3);
  const sizes     = new Float32Array(N);
  const seed      = new Float32Array(N);

  /*
   * 三层花瓣「杯状内收」造型：外层花瓣向外张开托底（碗沿），
   * 中层向内斜收（杯壁），内层向上立起（杯心），整体像一个
   * 花苞将开未开、向内收拢的杯子，而不是平摊在桌面上的花。
   * 每片花瓣局部坐标：
   *   - s ∈ [0,1]  沿花瓣从花心到瓣尖
   *   - w ∈ [-1,1] 横向
   *   关键：花瓣方向角 a 会随 s 向花心「旋转收拢」（inCup），
   *         外层收得少（张开）、内层收得多（立起）。
   */
  const themeDef = THEMES[state.themeIndex];
  const layers = themeDef.layers.map((l) => ({
    ...l,
    rot: l.rot ?? 0,
    colIn:  new THREE.Color(l.colIn),
    colOut: new THREE.Color(l.colOut),
  }));
  // 层参数（由外到内）：openF = 花瓣向外张开的程度（越大越张开/越平）
  // 外层张开托底、中层斜收、内层几乎立起 → 整体呈向内收的杯状
  const cupOpen = [1.15, 0.80, 0.45];      // 外→中→内
  const c = new THREE.Color();

  /* 花苞专属粒子：30% 的粒子专门构成「实心卵形花苞」，
     闭合时是饱满圆润的小花苞（像没开的郁金香苞），不是几根线。
     其余 70% 是花瓣，绽放时从花苞位置散开成杯状。 */
  const budDedicated = Math.floor(N * 0.30);
  const petalN = N - budDedicated;
  const perLayer = Math.floor(petalN / layers.length);

  const BUD_H = 0.75;   // 花苞总高
  const BUD_W = 0.30;   // 花苞最宽半径
  // 卵形半径：tPos 0=尖顶 ~ 1=花萼口；最宽处在中部、顶部收尖、底部收窄
  const budRAt = (tPos) =>
    BUD_W * Math.sin(tPos * Math.PI * 0.5 + 0.3) *
    (1 - 0.4 * Math.max(0, tPos - 0.75) / 0.25);

  // ---- 花苞专属粒子：卵形表面密铺 ----
  let idx = 0;
  for (let i = 0; i < budDedicated; i++) {
    const k = idx++;
    const theta = Math.random() * Math.PI * 2;
    // tPos: 0=尖顶, 1=底部（花萼口）；上密下疏
    const tPos = Math.pow(Math.random(), 0.8);
    // 卵形半径：最宽处在中下部，顶部收尖，底部收窄成花萼口
    const shapeR = BUD_W * Math.sin(tPos * Math.PI * 0.5 + 0.3) * (1 - 0.4 * Math.max(0, tPos - 0.75) / 0.25);
    const yB = BUD_H * (1 - tPos) + 0.05;
    // 闭合：卵形花苞表面
    budPos[k*3]   = shapeR * Math.cos(theta);
    budPos[k*3+1] = yB;
    budPos[k*3+2] = shapeR * Math.sin(theta);
    // 开放：向各方向散入外层花瓣（半径拉大、摊开、略抬高）
    const openR = BUD_W * 1.8 + tPos * 0.6 + Math.random() * 0.2;
    positions[k*3]   = openR * Math.cos(theta);
    positions[k*3+1] = yB + 0.3 + Math.random() * 0.2;
    positions[k*3+2] = openR * Math.sin(theta);
    // 颜色：外层深粉 → 花心金（越靠顶越金）
    c.copy(new THREE.Color(0xff6fa5)).lerp(COL_CORE, 1 - tPos);
    c.lerp(new THREE.Color(0xd8b4ff), 0.2);
    colors[k*3] = c.r; colors[k*3+1] = c.g; colors[k*3+2] = c.b;
    sizes[k] = 4.5;
    seed[k] = Math.random() * 1000;
  }

  // ---- 花瓣粒子：70% 分三层，有清晰瓣尖；闭合时贴回卵形花苞表面 ----
  for (let L = 0; L < layers.length; L++) {
    const lay = layers[L];
    const openF = cupOpen[L];               // 当前层的杯口张开度
    const perPetal = Math.floor(perLayer / lay.n);

    const petalParams = [];
    for (let P = 0; P < lay.n; P++) {
      petalParams.push({
        w: (Math.random() * 0.25 + 0.75),
        curl: (Math.random() * 0.35 + 0.45),
        tilt: (Math.random() - 0.5) * 0.1,
        angleJit: (Math.random() - 0.5) * 0.05,
      });
    }

    for (let P = 0; P < lay.n; P++) {
      const centerA = (P / lay.n) * Math.PI * 2 + lay.rot + petalParams[P].angleJit;
      const pp = petalParams[P];
      for (let i = 0; i < perPetal; i++) {
        if (idx >= N) break;
        const k = idx++;
        const s = Math.pow(Math.random(), 0.65) * 0.96 + 0.04;
        const isRim = Math.random() > 0.7;
        const wMax = pp.w * Math.sin(Math.PI * Math.pow(s, 0.7)) * (1 - 0.15 * s);
        const w = isRim
          ? (Math.random() < 0.5 ? -1 : 1) * (0.92 + 0.08 * Math.random()) * wMax
          : (Math.random() * 2 - 1) * 0.85 * wMax;

        const r = lay.R * s;
        // 杯状：花瓣方向角随 s 向花心「旋转收拢」。
        // openF 越小收得越多：外层(1.15)张开托底、中层(0.8)斜收、内层(0.45)立起成杯心。
        const cup = Math.max(0, 1 - Math.min(1, openF));  // 收拢量（0~0.55）
        const inSwing = cup * s * s;                        // 随 s 平方收拢
        // 横向偏移被「拉向中心」：收拢越多，横向摆动越小
        const ang = centerA + (w * (0.55 + 0.45 * s)) * (1 - inSwing * 0.5);
        // 半径向内收：越收拢、越靠近瓣尖整体越向花心缩
        const rIn = r * (1 - inSwing * 0.35);
        let x = rIn * Math.cos(ang);
        let z = rIn * Math.sin(ang);
        // 杯状高度：瓣面从花心向上鼓、瓣尖略回落形成杯沿
        const lift = Math.sin(Math.min(1, s) * Math.PI * 0.5);
        let y = lay.h * lift + pp.tilt * s * s;
        if (L === 2) y += s * 0.25;              // 内层向上立起（杯心）
        // 瓣缘微卷（内收后保留，让杯沿更有层次）
        const curlAmt = pp.curl * Math.pow(Math.max(0, s - 0.55) / 0.45, 2.2) * 0.4;
        if (curlAmt > 0.001) {
          const toCenter = Math.atan2(x, z);
          x -= Math.sin(toCenter) * curlAmt * 0.5;
          z -= Math.cos(toCenter) * curlAmt * 0.5;
          y += curlAmt * 0.3;
        }

        positions[k*3] = x; positions[k*3+1] = y; positions[k*3+2] = z;

        // 花瓣粒子闭合时贴回卵形花苞表面（瓣心 s→0 贴花苞中上部，瓣尖 s→1 贴花苞中下部）
        const tPos = s;                            // 0=瓣心(靠顶), 1=瓣尖(靠底)
        const bR = BUD_W * Math.sin(tPos * Math.PI * 0.5 + 0.3) * (1 - 0.4 * Math.max(0, tPos - 0.75) / 0.25);
        const bTheta = ang;
        budPos[k*3]   = bR * Math.cos(bTheta);
        budPos[k*3+1] = BUD_H * (1 - tPos) + 0.05;
        budPos[k*3+2] = bR * Math.sin(bTheta);

        c.copy(lay.colOut).lerp(lay.colIn, 1 - s);
        c.lerp(COL_CORE, (1 - s) * 0.55);
        if (isRim) c.lerp(COL_TIP, 0.25);
        colors[k*3] = c.r; colors[k*3+1] = c.g; colors[k*3+2] = c.b;
        sizes[k] = isRim ? 5.5 : 4.0;
        seed[k] = Math.random() * 1000;
      }
    }
  }
  while (idx < N) {
    const s = Math.max(0, idx - 1);
    const k = idx++;
    positions[k*3]=positions[s*3]; positions[k*3+1]=positions[s*3+1]; positions[k*3+2]=positions[s*3+2];
    budPos[k*3]=budPos[s*3]; budPos[k*3+1]=budPos[s*3+1]; budPos[k*3+2]=budPos[s*3+2];
    colors[k*3]=colors[s*3]; colors[k*3+1]=colors[s*3+1]; colors[k*3+2]=colors[s*3+2];
    sizes[k]=sizes[s]; seed[k]=seed[s];
  }
  return { positions, budPos, colors, sizes, seed };
}

/** 双拳碰撞 → 切换下一个主题（颜色 + 花瓣形状），并重建几何体 */
function switchTheme() {
  state.themeIndex = (state.themeIndex + 1) % THEMES.length;
  const name = THEMES[state.themeIndex].name;
  rebuildFlowerGeometry();
  showStatus(`已切换花色：${name}`, 'open');
  diag(`[主题] 双拳碰撞 → ${name}`);
}

/** 用当前主题重建花朵几何体（替换旧 Points 对象） */
function rebuildFlowerGeometry() {
  if (!flowerPoints) return;
  const old = flowerPoints;
  buildFlower();   // 重新创建 flowerPoints
  scene.remove(old);
  old.geometry.dispose();
  old.material.map?.dispose?.();
  old.material.dispose();
  updateHUD(state.handDetected ? (state.hands.filter(h => h.seen).length) : 0);
}

function makeGlowSprite() {
  // 生成 64x64 圆形光晕贴图，供 PointsMaterial 使用（带发光，边缘柔和）
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const cx = cv.getContext('2d');
  const g = cx.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25,'rgba(255,255,255,0.85)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  cx.fillStyle = g;
  cx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

function buildFlower() {
  const geo = new THREE.BufferGeometry();
  const d = buildPetal();
  geo.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(d.colors, 3));
  // 保存两套静态形态：openPos（开放花瓣）与 budPos（闭合花苞），
  // 实时 position 数组每帧由这两者插值，绝不基于自身累加
  const openPos = new Float32Array(d.positions); // 拷贝，避免被实时覆盖
  flowerUserData = { openPos, budPos: new Float32Array(d.budPos) };
  geo.userData = flowerUserData;

  const sprite = makeGlowSprite();
  const mat = new THREE.PointsMaterial({
    size: 0.032,                 // 更小更细腻，避免糊成一团
    sizeAttenuation: true,
    map: sprite,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    alphaTest: 0.0,
    opacity: 1.0,
  });
  flowerPoints = new THREE.Points(geo, mat);
  flowerPoints.frustumCulled = false;
  scene.add(flowerPoints);
}

let flowerUserData = null;
let lastPosUpdate = 0;
const UPDATE_INTERVAL = 1000 / 30; // 位置最多 30fps 更新，省 CPU

/** 基于静态「开放形态 open[]」与「闭合形态 bud[]」插值 position。
    避免在已修改的 pos 上反复累加（旧实现每帧漂移 + 每点三角函数，CPU 过高、
    与 MediaPipe 抢主线程导致检测丢手）。
 */
function updateFlowerPositions(t) {
  if (!flowerUserData) return;
  const now = performance.now();
  if (now - lastPosUpdate < UPDATE_INTERVAL) return;
  lastPosUpdate = now;

  const u = flowerUserData;
  const pos = flowerPoints.geometry.attributes.position.array;
  const open = u.openPos, bud = u.budPos;
  const N = pos.length / 3;
  const S = state.spread;
  const tip = state.tip;
  const infl = CONFIG.tipInfluence * S * 0.15;
  for (let i = 0; i < N; i++) {
    const i3 = i * 3;
    // 1) 开放 <-> 花苞 插值（基于两套静态坐标）
    const x = open[i3]   + (bud[i3]   - open[i3])   * (1 - S);
    const y = open[i3+1] + (bud[i3+1] - open[i3+1]) * (1 - S);
    const z = open[i3+2] + (bud[i3+2] - open[i3+2]) * (1 - S);
    // 2) 指尖牵引（仅开放时生效）
    let fx = x, fy = y, fz = z;
    if (infl > 0.001) {
      const dx = tip.x - x, dy = tip.y - y, dz = tip.z - z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const pull = infl / (d + 1.2);
      fx = x + dx * pull;
      fy = y + dy * pull;
      fz = z + dz * pull;
    }
    // 2.5) 鼠标驱散：靠近鼠标（花朵局部坐标）的粒子向外推
    const repel = state.mouse.strength;
    if (repel > 0.01) {
      const ml = state.mouse.local;
      const dxm = x - ml.x, dym = y - ml.y, dzm = z - ml.z;
      const dm = Math.sqrt(dxm*dxm + dym*dym + dzm*dzm);
      const force = repel * CONFIG.mouseRepelForce / (dm + 0.25);
      // 向外推 + 轻微上浮，形成「被吹散」感
      const push = Math.min(force, 0.9);
      fx += dxm * push * 0.4;
      fy += dym * push * 0.4 + push * 0.15;
      fz += dzm * push * 0.4;
    }
    // 3) 轻抖动（无每点三角函数，用全局相位即可）
    const wob = Math.sin(t * 0.9) * 0.012;
    pos[i3]   = fx + wob;
    pos[i3+1] = fy + Math.cos(t * 0.7) * 0.01;
    pos[i3+2] = fz;
  }
  flowerPoints.geometry.attributes.position.needsUpdate = true;
  flowerPoints.material.opacity = 0.55 + 0.45 * S;
}

function buildStarField() {
  const N = 1500;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 6 + Math.random() * 18;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
    pos[i*3+1] = r * Math.cos(ph);
    pos[i*3+2] = r * Math.sin(ph) * Math.sin(th);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    size: 0.06, color: 0x8fb3ff, transparent: true,
    opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  heartField = new THREE.Points(g, m);
  scene.add(heartField);

  // 「test light」：一个保证可见的 Sprite（不依赖点精灵/着色器），用于诊断
  const sTex = makeGlowSprite();
  testLight = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sTex, color: 0xffd166, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  testLight.position.set(0, 0.5, 0.4);
  testLight.scale.set(0.3, 0.3, 1);
  scene.add(testLight);
}

/* ============================================================
 * 4. 渲染循环
 * ============================================================ */
const clock = new THREE.Clock();

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const t = clock.getElapsedTime();
  state.spread += (state.targetSpread - state.spread) * CONFIG.spreadEase;

  // 鼠标驱散：更新花朵局部坐标 + 强度衰减
  if (flowerPoints) updateMouseRepel();

  // CPU 端插值位置（闭合 <-> 开放）+ 指尖牵引 + 鼠标驱散
  updateFlowerPositions(t);

  // 朝向：持续自转（360° 展示）+ 长按拖拽累积角（rotY 停住后保留方位）
  const m = state.mouse;
  flowerPoints.rotation.y = t * CONFIG.autoRotate + m.rotY + state.spread * 0.6;
  // 花苞更矮、绽放时抬升：整体 y 在 [0.15, 0.75] 间随绽放度移动
  flowerPoints.position.y = 0.15 + state.spread * 0.6;
  // 同步 testLight 到花心（随花一起抬升）
  if (testLight) testLight.position.y = 0.15 + state.spread * 0.6 + 0.3;
  heartField.rotation.y = -t * 0.03;
  if (testLight) {
    testLight.scale.setScalar(0.2 + 0.5 * state.spread);
    testLight.material.color.setRGB(1, 0.82 - 0.3 * state.spread, 0.4 + 0.5 * state.spread);
  }

  if (orbit) orbit.update();
  renderer.render(scene, camera);
}

/* 2D 兜底渲染：当 WebGL/Three.js 不可用时，用 canvas 2D 画粒子花朵 */
let fallback2D = null;

function initFallback2D() {
  fallback2D = { ctx: el.canvas.getContext('2d'), pts: [] };
  resizeFallbackCanvas();
  window.addEventListener('resize', resizeFallbackCanvas);
  const d = buildPetal();
  const mix255 = (a, b, t) => Math.round(a + (b - a) * t);
  for (let i = 0; i < CONFIG.particleCount; i++) {
    const t = 0.3 + 0.7 * Math.random();
    const core = [255, 209, 102], petal = [255, 158, 203];
    fallback2D.pts.push({
      x: d.positions[i * 3], y: d.positions[i * 3 + 1], z: d.positions[i * 3 + 2],
      bx: d.budPos[i * 3], by: d.budPos[i * 3 + 1], bz: d.budPos[i * 3 + 2],
      col: [mix255(core[0], petal[0], t), mix255(core[1], petal[1], t), mix255(core[2], petal[2], t)],
      size: d.sizes[i],
    });
  }
  diag(`[渲染] 2D 兜底 · WebGL 不可用 · 粒子 ${CONFIG.particleCount}`);
  requestAnimationFrame(fallbackLoop);
}

function resizeFallbackCanvas() {
  const c = el.canvas;
  c.width = window.innerWidth;
  c.height = window.innerHeight;
}

function fallbackLoop() {
  requestAnimationFrame(fallbackLoop);
  const t = performance.now() * 0.001;
  const ctx = fallback2D.ctx, c = el.canvas;
  state.spread += (state.targetSpread - state.spread) * CONFIG.spreadEase;
  const S = state.spread;
  ctx.fillStyle = '#05030c';
  ctx.fillRect(0, 0, c.width, c.height);
  const cx = c.width / 2, cy = c.height * 0.45;
  const scale = Math.min(c.width, c.height) * 0.45;
  ctx.globalCompositeOperation = 'lighter';
  for (const p of fallback2D.pts) {
    // 闭合 <-> 开放 插值
    const px = p.x + (p.bx - p.x) * (1 - S);
    const py = p.y + (p.by - p.y) * (1 - S);
    const pz = p.z + (p.bz - p.z) * (1 - S);
    const rot = t * 0.15 + S * 0.6;
    const rx = px * Math.cos(rot) - pz * Math.sin(rot);
    const rz = px * Math.sin(rot) + pz * Math.cos(rot);
    const px2 = cx + rx * scale;
    const py2 = cy - py * scale + rz * scale * 0.25;
    const alpha = 0.15 + 0.5 * S * (Math.abs(rz) * 0.5 + 0.5);
    ctx.fillStyle = `rgba(${p.col[0]},${p.col[1]},${p.col[2]},${alpha})`;
    const s = p.size * (scale / 400) * (0.6 + 0.4 * S);
    ctx.beginPath();
    ctx.arc(px2, py2, s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* ============================================================
 * 5. 初始化 + 错误处理
 * ============================================================ */
function initThree() {
  scene = new THREE.Scene();
  // 不用 FogExp2：它与自定义加色粒子叠加时可能在部分 GPU 上导致渲染异常，保持简洁

  camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near, CONFIG.camera.far,
  );
  camera.position.set(0, 0.4, 3.2);
  camera.lookAt(0, 0.5, 0);

  // OrbitControls：360° 展示 —— 拖拽旋转 / 滚轮缩放
  orbit = new OrbitControls(camera, el.canvas);
  orbit.target.set(0, 0.5, 0);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.autoRotate = false;            // 花朵本身在自转，相机不再自动转，避免双重旋转
  orbit.minDistance = 1.5;
  orbit.maxDistance = 12;
  orbit.maxPolarAngle = Math.PI * 0.95;
  orbit.update();

  renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true });
  // 移动端限制像素比 ≤ 1.5，省电省内存
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_MOBILE ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x05030c, 1);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  initMouseInteraction();

  buildFlower();
  buildStarField();
  renderLoop();
}

function showStatus(msg, kind = 'info') {
  el.stateText.textContent = msg;
  el.stateText.className = kind;
}

/* ============================================================
 * 4.5 鼠标交互：靠近花朵时粒子散开，移开后缓慢回拢
 * ============================================================ */
const mouseRay = new THREE.Raycaster();
const mousePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // 世界 z=0 平面
const mouseWorldHit = new THREE.Vector3();

function initMouseInteraction() {
  const m = state.mouse;
  const LONG_PRESS_MS = 250; // 长按判定时长

  const onMove = (e) => {
    m.ndc.set((e.clientX / window.innerWidth) * 2 - 1,
              -(e.clientY / window.innerHeight) * 2 + 1);
    m.active = true;
    if (m.dragging) {
      const dx = e.clientX - m.dragLastX;
      const dy = e.clientY - m.dragLastY;
      // 拖拽 → 旋转花朵（x 轴转 y 角、y 轴转 x 角，全方位）
      m.rotYTarget += dx * 0.008;
      m.rotYTarget = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, m.rotYTarget));
      m.dragLastX = e.clientX;
      m.dragLastY = e.clientY;
    }
  };
  const onDown = (e) => {
    if (e.target !== el.canvas) return;
    m.downTime = performance.now();
    m.dragLastX = e.clientX;
    m.dragLastY = e.clientY;
    m.longPressFired = false;
  };
  const onUp = () => {
    if (m.downTime > 0) {
      const held = performance.now() - m.downTime;
      if (held < 200 && !m.dragging) {
        // 快速点击（非长按非拖拽）→ 花心轻弹一下（可选反馈）
      }
      m.downTime = 0;
      m.dragging = false;
      m.longPressFired = false;
    }
  };
  const onLeave = () => {
    m.active = false;
    m.local.set(9999, 9999, 0);
    m.dragging = false;
  };

  // 长按检测：按下后 250ms 仍在按 → 进入拖拽模式
  const pressCheck = () => {
    if (m.downTime > 0 && !m.longPressFired &&
        performance.now() - m.downTime >= LONG_PRESS_MS) {
      m.longPressFired = true;
      m.dragging = true;
      diag('[交互] 长按拖拽中：移动鼠标全方位旋转花朵');
    }
  };
  setInterval(pressCheck, 40);

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);
  document.addEventListener('mouseleave', onLeave);

  /* ---- 触屏：单指滑动=驱散/旋转，双指=缩放 + 捏合换色 ---- */
  let touchPrev = null;      // 上次触摸 {x,y, dist}
  const touchState = { dragging: false, pinchDist: 0, themeHoldUntil: 0 };

  el.canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t0 = e.touches[0];
      onDown({ clientX: t0.clientX, clientY: t0.clientY, target: el.canvas });
      m.ndc.set((t0.clientX / window.innerWidth) * 2 - 1,
                -(t0.clientY / window.innerHeight) * 2 + 1);
      m.active = true;
    } else if (e.touches.length === 2) {
      // 双指：进入捏合/缩放模式，暂停单指长按逻辑
      m.downTime = 0;
      m.dragging = false;
      m.active = false;
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      touchState.pinchDist = Math.hypot(dx, dy);
      touchState.dragging = true;
    }
  }, { passive: false });

  el.canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && m.downTime > 0) {
      const t0 = e.touches[0];
      m.ndc.set((t0.clientX / window.innerWidth) * 2 - 1,
                -(t0.clientY / window.innerHeight) * 2 + 1);
      onMove({ clientX: t0.clientX, clientY: t0.clientY });
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      if (touchState.pinchDist > 0) {
        // 双指捏合（距离快速缩小）→ 换色；双指张开 → 缩放
        const scale = dist / touchState.pinchDist;
        if (scale < 0.55 && performance.now() - touchState.themeHoldUntil > 1500) {
          switchTheme();
          touchState.themeHoldUntil = performance.now();
        }
        // 缩放：用双指间距缩放相机距离（通过 orbit 的距离调整）
        if (orbit) {
          // 把中点投影到相机前方，缩放 orbit 的 radius
          const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          const zoomDelta = (touchState.pinchDist - dist) * 0.01;
          // 沿「相机看向 target」方向平移相机
          const offset = new THREE.Vector3();
          camera.position.copy(orbit.target).add(
            new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion)
          );
          const currentDist = camera.position.distanceTo(orbit.target);
          const newDist = Math.max(orbit.minDistance, Math.min(orbit.maxDistance, currentDist + zoomDelta));
          const dir = new THREE.Vector3().subVectors(camera.position, orbit.target).normalize();
          camera.position.copy(orbit.target).add(dir.multiplyScalar(newDist));
          orbit.update();
        }
      }
      touchState.pinchDist = dist;
    }
  }, { passive: false });

  el.canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      onUp();
      m.active = false;
      touchState.pinchDist = 0;
      touchState.dragging = false;
    } else if (e.touches.length === 1) {
      // 从双指回到单指：重新初始化单指
      touchState.pinchDist = 0;
      m.downTime = 0;
      m.dragging = false;
      m.active = true;
      const t0 = e.touches[0];
      m.ndc.set((t0.clientX / window.innerWidth) * 2 - 1,
                -(t0.clientY / window.innerHeight) * 2 + 1);
    }
  });
}

/** 每帧：把鼠标 NDC 投影到世界 z=0 平面，再变换到花朵局部坐标，
    计算驱散强度（鼠标在区域内强、远离时归零），强度做慢回拢；
    同时平滑拖拽旋转目标
 */
function updateMouseRepel() {
  const m = state.mouse;
  if (m.active) {
    mouseRay.setFromCamera(m.ndc, camera);
    if (mouseRay.ray.intersectPlane(mousePlane, mouseWorldHit)) {
      const inv = new THREE.Matrix4().copy(flowerPoints.matrixWorld).invert();
      m.local.copy(mouseWorldHit).applyMatrix4(inv);
    }
    const dist = m.local.length();
    m.strength = m.dragging ? 0 : Math.max(0, 1 - dist / CONFIG.mouseRepelRadius);
  }
  // 回拢：驱散量按 slow 速率衰减 → 「慢慢汇拢」（衰减在下一帧发生）
  m.strength += (0 - m.strength) * CONFIG.mouseSettleRate;
  // 拖拽旋转：rotY 平滑逼近 rotYTarget（拖拽时跟手，松开后缓慢停住）
  m.rotY += (m.rotYTarget - m.rotY) * (m.dragging ? 0.35 : 0.08);
}

function showError(title, body) {
  const box = el.errorBox;
  box.classList.remove('hidden');
  const h = box.querySelector('p');
  const ul = box.querySelector('ul');
  h.textContent = title;
  ul.innerHTML = body;
}

/** 摄像头/识别失败 → 进入手动模式（鼠标控制），同时保留粒子花朵
    注意：鼠标驱散/旋转由 initMouseInteraction + OrbitControls 接管，
    这里只把手势目标（绽放度）交给鼠标 X/Y 混合控制。 */
function enterManualMode(reason) {
  state.manual = true;
  showStatus('手动模式 · 移动鼠标控制绽放', 'open');
  window.addEventListener('mousemove', (e) => {
    const nx = e.clientX / window.innerWidth;
    const ny = 1 - e.clientY / window.innerHeight;
    state.targetSpread = Math.min(1, Math.max(0, (nx + ny) / 2));
    state.wrist.set(nx * 2 - 1, ny * 2 - 1, 0.6);
    state.tip.copy(state.wrist);
  });
  if (reason) console.warn('[manual mode]', reason);
}

async function main() {
  // 0) 全局错误捕获：任何未捕获异常都在诊断横幅显示，方便定位
  window.addEventListener('error', (e) => {
    diag(`[错误] ${e.message || String(e.error)}`);
  });

  // 1) Three.js / WebGL：失败则 2D 兜底，保证画面不黑屏
  let threeOk = false;
  try {
    initThree();
    threeOk = true;
    diag(`[渲染] WebGL · Three ${THREE.REVISION} · 粒子 ${CONFIG.particleCount} · 手势加载中`);
    showStatus('正在加载手势模型…');
  } catch (e) {
    console.error('[Three.js init failed] → 2D fallback', e);
    try { initFallback2D(); } catch (e2) {
      showError('渲染失败', `<li>WebGL 与 Canvas 2D 均不可用：${e.message}</li>`);
      diag(`[错误] 渲染失败：${e.message}`);
      return;
    }
    showError('WebGL 不可用，已切换 2D 渲染',
      '<li>请更新浏览器/启用硬件加速（Chrome: chrome://gpu）</li><li>花朵仍可正常交互</li>');
    setTimeout(() => el.errorBox.classList.add('hidden'), 8000);
  }

  // 2) 手势模型
  try {
    await initHands();
    if (!threeOk) showStatus('摄像头初始化中…');
    diag(`[手势] 模型加载完成，等待摄像头`);
  } catch (e) {
    enterManualMode(e.message);
    showError('手势识别模型加载失败（网络/CDN）',
      '<li>MediaPipe Hands 需从 CDN 加载模型，请检查网络</li>' +
      '<li>当前已进入鼠标手动模式，移动鼠标控制绽放</li>');
    diag(`[错误] 手势模型失败：${e.message} → 手动模式`);
    setTimeout(() => el.errorBox.classList.add('hidden'), 12000);
    return;
  }

  // 3) 摄像头
  try {
    await startCamera();
    diag(
      threeOk
        ? `[渲染] WebGL · 粒子 ${CONFIG.particleCount} · 摄像头就绪`
        : `[渲染] 2D 兜底 · 粒子 ${CONFIG.particleCount} · 摄像头就绪`
    );
    showStatus('摄像头已就绪，请展示手部');
  } catch (e) {
    let msg = e && e.message ? e.message : String(e);
    if (e.name === 'NotAllowedError') msg = '摄像头权限被拒绝，请在浏览器地址栏授权摄像头';
    else if (e.name === 'NotFoundError') msg = '未检测到摄像头设备';
    enterManualMode(msg);
    showError('摄像头不可用', `<li>${msg}</li><li>已切换为鼠标手动模式</li>`);
    diag(`[错误] 摄像头：${msg} → 手动模式`);
    setTimeout(() => el.errorBox.classList.add('hidden'), 12000);
  }
}

main();
