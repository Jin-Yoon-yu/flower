# 指尖花语 · 手势花朵

通过摄像头识别手部 21 个关键点，**握拳** 时花朵聚成小花苞，**张开手掌** 时花瓣向外绽放，并随手指位置产生轻微牵引感。

## 技术栈
- Three.js（ES Module + CDN importmap）
- MediaPipe Hands（CDN）
- 原生 JavaScript + HTML/CSS，零构建

## 本地运行（必须 HTTP，不能用 file://）
```bash
cd garden-flower
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

## 给别人看（手机也能打开）

**关键**：手机摄像头需要 `https://`（`http://` 手机会拒权）。本地 `http://localhost` 仅限电脑。

**方案 A（推荐）：公网隧道，零配置**
```bash
# 电脑装 cloudflared（免费，无需注册）
brew install cloudflared            # macOS
# 或下载 https://github.com/cloudflare/cloudflared/releases
cd garden-flower
python3 -m http.server 8000 &       # 起本地服务
cloudflared tunnel --url http://localhost:8000
# 会打印一个 https://xxxx.trycloudflare.com 地址，手机同网/任网都可直接开
```

**方案 B：GitHub Pages**
把本目录推到 GitHub repo，开启 Pages。Pages 默认 `https://`，手机直接开。但 CDN（MediaPipe/Three）需外网可达。

**方案 C：家里手机同 WiFi**
手机开 `http://<电脑局域网IP>:8000/`，但**摄像头仍不可用**（http 手机拒权），只能看 3D 花 + 鼠标/触屏交互，无手势。

> 结论：要完整体验（含手势），请用方案 A 的 `https://` 公网地址。

## 配置项
`main.js` 顶部 `CONFIG`：
| 字段 | 默认 | 说明 |
|---|---|---|
| `particleCount` | 桌面12000/手机6000 | 粒子数 |
| `fistThreshold` | 0.3 | 握拳判定 |
| `autoRotate` | 0.25 | 自转速度 rad/s |
| `mouseRepelRadius` | 0.9 | 驱散半径 |
| `mouseSettleRate` | 0.06 | 回拢速率 |

## 交互
- 单手握拳/张掌 → 花苞 ↔ 杯状绽放
- 双拳保持 0.5s → 换花色+花瓣形状（樱粉/蓝铃/金盏/青瓷）
- 鼠标/手指经过花上 → 粒子散开，离开缓缓回拢
- 鼠标长按拖拽 / 单指滑动 → 全方位转花
- 双指捏合（手机）→ 换色；双指开合 → 缩放
- 不操作 → 花持续 360° 自转
