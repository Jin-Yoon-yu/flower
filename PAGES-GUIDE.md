# 部署到 GitHub Pages 指引

把花园放到 GitHub Pages，得到一个 `https://` 公网地址，
**异地任意设备（电脑/手机）都能打开**，无需对方连你的网。

---

## 方式 A（推荐 · 最少打字）

1. 在浏览器登录 `https://github.com`（没有就注册）
2. 点右上角 `+` → **New repository**
   - Repository name：`flower-gesture`（任意名字，不能重名就换个）
   - Public（必须 public 才能用 Pages）
   - 点 **Create repository**
3. 复制我给你的 **zip 文件**（见下方），下载存到电脑
4. 解压 zip
5. 回到刚建好的仓库网页，点 **"uploading an existing files"**
   - 把解压出来的文件夹里 **所有文件**（index.html、main.js、style.css、README.md 等，**包括文件夹里的内容**，不要选文件夹本身）拖进去
   - 点 **Commit changes**
6. 左侧 **Settings** → 最上面 **Pages**
   - **Build and deployment** 区域：
     - Source：`Deploy from a branch`
     - Branch：`main`，文件夹选 `/ (root)`，点 Save
7. 等 1–2 分钟，回到 Pages 页顶会显示
   `Your site is live at https://你的用户名.github.io/flower-gesture/`
8. 把那个链接发出去，谁都能开 ✅

> 手机端操作：第 3 步把 zip 存手机；第 5 步用手机浏览器 GitHub 网页拖文件（或用文件管理器复制）。

---

## 方式 B（有终端）

```bash
# 假设你的花园目录在 ~/Downloads/garden-flower
cd ~/Downloads/garden-flower

# 1. 建好 GitHub 仓库后，获取仓库的 git 地址（网页上复制）
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/你的用户名/flower-gesture.git
git push -u origin main
```
然后照 A 第 6、7 步开 Pages 即可。

---

## 验证

打开 `https://你的用户名.github.io/flower-gesture/`
- 桌面：直接授权摄像头，手势控花 ✅
- 手机：授权摄像头，单指转花 / 双指捏合换色 ✅
- 没摄像头权限的环境：自动进入手动模式，鼠标/触屏控花 ✅

---

## 注意

- 仓库必须 **Public**（私有仓库 Pages 需 Pro 账号）
- 换仓库名 → 链接里 `/flower-gesture/` 跟着变
- GitHub Pages 偶尔加载慢（CDN 在中国不一定快），第一次开可能转圈几秒
- 想改花 / 参数：改 main.js 重新 commit push，Pages 自动更新
