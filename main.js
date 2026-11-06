const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  shell,
  Menu,
  Tray,
  nativeImage,
  dialog,
  Notification,
  globalShortcut,
  powerMonitor,
} = require('electron')
const { execFile, execFileSync, spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const settings = require('./settings')
const {
  buildApps,
  buildPinned,
  renameApp,
  saveOrder,
  saveDockOrder,
  setCustomIcon,
  createGroup,
  moveToGroup,
  renameGroup,
  removeGroup,
  getLockedGroups,
  setGroupLocked,
  setGroupPassword,
  getPasswordGroups,
  verifyGroupPassword,
  getDockPaths,
  addToDock,
  removeFromDock,
  windowThumbFor,
  listRunningProcs,
  exeOf,
  listGroups,
  addApp,
  removeApp,
  updateAppPath,
  touchApp,
  importFolder,
  importDropped,
  scanAppsFolder,
  planAppsFromFolder,
  addPickedApps,
  planImportFolder,
  importPicked,
  planFolderAsGroup,
  addFolderAsGroup,
  getLibraryInfo,
  invalidate,
  LEGACY_DIR,
} = require('./apps')

let dockWin = null
let gridWin = null
let previewWin = null
let settingsWin = null
let tray = null
let previewReady = Promise.resolve()
let previewIdleTimer = null

// 主进程 V8 堆封顶：正常只用到几十 MB，设个上限可以逼它及时回收，
// 万一哪里又漏了也不至于把内存吃到 1GB 再被系统杀掉
// expose-gc：让主进程能定期叫渲染进程做全量 GC（JS 堆本身不大，但能压住长期增长）
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --max-semi-space-size=8 --expose-gc')

// 任务栏/通知的应用标识：不设的话通知会显示成 electron.app.Electron
app.setAppUserModelId('DockPad')

// 省内存模式：关掉 GPU 加速。GPU 进程是除主进程外最大的一块（~120MB），
// 关掉它内存立省一大截，代价是背景模糊和动画走软件渲染，低配机器可能卡。
// 设置里可以开关，改完重启生效（GPU 开关只能在启动时决定）。
if (settings.get().lowGpu) {
  app.commandLine.appendSwitch('disable-gpu')
}

// 单实例锁：重复启动时直接退出，并把已有实例唤出来
const singleInstance = app.requestSingleInstanceLock()
// 临时启动日志：排查"启动即退出"用，定位后删除
function logBoot(msg) {
  try {
    fs.appendFileSync(path.join(require('os').tmpdir(), 'dp-boot.log'), new Date().toISOString() + ' ' + msg + '\n')
  } catch (e) { /* ignore */ }
}
try {
  logBoot('boot pid=' + process.pid + ' lock=' + singleInstance)
} catch (e) { /* ignore */ }

// ---------- Dock 尺寸 / 贴边吸附状态 ----------
const DOCK_H_W = 780 // 横排窗口宽
const DOCK_H_H = 100 // 横排窗口高
const DOCK_V_W = 100 // 竖排窗口宽
const DOCK_V_MIN_H = 300 // 竖排窗口最小高
const SNAP_EDGE = 30 // 窗口边缘距屏幕左右边多近触发吸附

let dockOrient = 'h' // 'h' | 'left' | 'right'
let orientBusy = false // 切换形态期间忽略 moved，避免自触发死循环
let orientChangedAt = 0 // 最近一次切换形态的时间，用于决定 resize 后是否重新居中
let dockContentH = 0 // 渲染进程上报的竖排内容高度

function dockPosFile() {
  return path.join(app.getPath('userData'), 'dock-pos.json')
}

function loadDockPos() {
  try {
    // 记事本/PowerShell 保存会带 UTF-8 BOM，JSON.parse 会直接抛错
    const raw = fs.readFileSync(dockPosFile(), 'utf8').replace(/^\uFEFF/, '')
    const p = JSON.parse(raw)
    if (p && typeof p.x === 'number' && typeof p.y === 'number') return p
  } catch (e) {
    /* ignore */
  }
  return null
}

function saveDockPos(x, y, orient) {
  try {
    fs.writeFileSync(
      dockPosFile(),
      JSON.stringify({ x: Math.round(x), y: Math.round(y), orient: orient || dockOrient })
    )
  } catch (e) {
    /* ignore */
  }
}

function isVertical(orient) {
  return orient === 'left' || orient === 'right'
}

// 按目标形态重新布局窗口：横排 780x100，竖排 100x内容高，贴左/右边缘
function applyDockOrient(orient) {
  if (!dockWin || dockWin.isDestroyed()) return
  const b = dockWin.getBounds()
  const area = screen.getDisplayMatching(b).workArea
  let W, H, x, y

  if (orient === 'h') {
    W = DOCK_H_W
    H = DOCK_H_H
    // 从竖排拖出来：以当前窗口中心为锚点放回横排，避免跳到角落里
    x = b.x + b.width / 2 - W / 2
    y = b.y + b.height / 2 - H / 2
    x = Math.max(area.x + 8, Math.min(x, area.x + area.width - W - 8))
    y = Math.max(area.y, Math.min(y, area.y + area.height - H - 6))
  } else {
    W = DOCK_V_W
    H = Math.min(Math.max(dockContentH + 24, DOCK_V_MIN_H), area.height - 40)
    x = orient === 'left' ? area.x + 2 : area.x + area.width - W - 2
    y = area.y + (area.height - H) / 2
  }

  orientBusy = true
  dockOrient = orient
  orientChangedAt = Date.now()
  dockWin.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: W,
    height: Math.round(H),
  })
  if (dockWin.webContents && !dockWin.webContents.isDestroyed()) {
    dockWin.webContents.send('dock-orient', orient)
  }
  saveDockPos(x, y, orient)
  setTimeout(() => {
    orientBusy = false
  }, 320)
}

// 拖动结束：判断是否贴边 → 切形态；否则只把窗口约束回可视范围并记住位置
function onDockMoveEnd() {
  if (!dockWin || dockWin.isDestroyed() || orientBusy) return
  // 任务栏让位是程序自己挪的窗口，别当成用户拖放
  if (Date.now() < dockDodgeHold) return
  // 用户拖过了：以他拖到的位置为准，不再按让位前的基准归位
  if (dockDodged) dockDodged = false
  const b = dockWin.getBounds()
  const area = screen.getDisplayMatching(b).workArea

  // 吸附距离可配置，设成 0 就是关掉吸附
  const snap = Math.max(0, Number(settings.get().snapEdge) || 0)
  let target = 'h'
  if (snap > 0 && b.x <= area.x + snap) target = 'left'
  else if (snap > 0 && b.x + b.width >= area.x + area.width - snap) target = 'right'

  if (target !== dockOrient) {
    applyDockOrient(target)
    return
  }

  // 形态没变：贴边的重新贴紧，横排的保留用户拖到的位置
  let x = b.x
  let y = b.y
  if (dockOrient === 'left') x = area.x + 2
  else if (dockOrient === 'right') x = area.x + area.width - b.width - 2
  else {
    const minVisible = 120
    x = Math.max(area.x - b.width + minVisible, Math.min(x, area.x + area.width - minVisible))
  }
  y = Math.max(area.y - 24, Math.min(y, area.y + area.height - 48))

  x = Math.round(x)
  y = Math.round(y)
  if (x !== b.x || y !== b.y) {
    orientBusy = true
    dockWin.setPosition(x, y)
    setTimeout(() => {
      orientBusy = false
    }, 200)
  }
  saveDockPos(x, y, dockOrient)
  syncDockAnchor()
}

// 让 Dock 把「全部应用」按钮的最新屏幕坐标报上来（Dock 挪过位置后要重算）
// ---- 任务栏呼叫时给 Dock 让位 ----
// 任务栏设成自动隐藏时，鼠标碰到底边它才会滑出来，而且它压在 Dock 上面，两者互相遮挡。
// 这里轮询光标：光标贴住屏幕底边 → 把 Dock 临时上移一条任务栏的高度；光标离开 → 归位。
// 只在「Dock 横排贴在底边 + 任务栏没有预留工作区（= 自动隐藏）」时生效。
const TASKBAR_H = 48
let dockDodged = false
let dockDodgeHold = 0
let dockDodgeBaseY = 0
let dockDodgeTimer = null

function dockNeedsDodge() {
  if (!dockWin || dockWin.isDestroyed() || !dockWin.isVisible()) return null
  if (settings.get().autoHide) return null // 自动隐藏自己会收，别两边抢着挪窗口
  if (dockOrient !== 'h') return null
  const b = dockWin.getBounds()
  const disp = screen.getDisplayMatching(b)
  const area = disp.bounds
  const wa = disp.workArea
  // 任务栏在左/右/上留住空间的话，底部没它的事，不用让
  if (wa.y > area.y + 4) return null
  if (wa.x > area.x + 4 || wa.width < area.width - 4) return null
  // 底部预留了空间说明任务栏常驻（不是自动隐藏），Dock 本来就在它上方
  if (wa.y + wa.height < area.y + area.height - 4) return null
  // Dock 必须贴在底边附近（离底 28px 以内），否则是在半空飘着，别动它。
  // 已经让位时要按让位前的基准位置判断，不然一挪上去就判定成「不贴底」，立刻又归位，来回闪。
  const baseY = dockDodged ? dockDodgeBaseY : b.y
  const gap = area.y + area.height - (baseY + b.height)
  if (gap < -2 || gap > 28) return null
  return { b, area }
}

function pollTaskbarDodge() {
  const info = dockNeedsDodge()
  if (!info) {
    if (dockDodged) restoreDockDodge()
    return
  }
  const p = screen.getCursorScreenPoint()
  const b = info.b
  // 光标落在 Dock 自己身上（含按住拖动）时完全不干预，
  // 否则一拖就被 setBounds 打断，Dock 会变成"拖不动"
  const overDock =
    p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  if (overDock) return
  const bottom = info.area.y + info.area.height
  const nearBottom = p.y >= bottom - 3 && p.x >= info.area.x && p.x <= info.area.x + info.area.width
  if (nearBottom && !dockDodged) {
    dockDodgeBaseY = b.y
    dockDodged = true
    dockDodgeHold = Date.now() + 900
    orientBusy = true
    dockWin.setBounds({ x: b.x, y: b.y - TASKBAR_H, width: b.width, height: b.height })
    setTimeout(() => { orientBusy = false }, 260)
    syncDockAnchor()
  } else if (dockDodged && p.y < bottom - TASKBAR_H - 10) {
    restoreDockDodge()
    syncDockAnchor()
  }
}

function restoreDockDodge() {
  if (!dockDodged) return
  dockDodged = false
  if (!dockWin || dockWin.isDestroyed()) return
  const b = dockWin.getBounds()
  const area = screen.getDisplayMatching(b).bounds
  orientBusy = true
  dockWin.setBounds({
    x: b.x,
    y: Math.min(dockDodgeBaseY, area.y + area.height - b.height - 2),
    width: b.width,
    height: b.height,
  })
  setTimeout(() => { orientBusy = false }, 240)
}

function startTaskbarDodge() {
  if (dockDodgeTimer) return
  dockDodgeTimer = setInterval(pollTaskbarDodge, 90)
}

function syncDockAnchor() {
  if (dockWin && !dockWin.isDestroyed() && !dockWin.webContents.isDestroyed()) {
    dockWin.webContents.send('dock-moved')
  }
}

// 托盘/设置里点「重置位置」：回到底部居中横排
function resetDockPosition() {
  if (!dockWin || dockWin.isDestroyed()) return
  const area = screen.getPrimaryDisplay().workArea
  const x = Math.round(area.x + (area.width - DOCK_H_W) / 2)
  const y = Math.round(area.y + area.height - DOCK_H_H - 6)
  orientBusy = true
  dockOrient = 'h'
  dockWin.setBounds({ x, y, width: DOCK_H_W, height: DOCK_H_H })
  if (!dockWin.webContents.isDestroyed()) dockWin.webContents.send('dock-orient', 'h')
  saveDockPos(x, y, 'h')
  setTimeout(() => {
    orientBusy = false
  }, 320)
}

// Dock 是否压在所有窗口上面。默认 false：让位给浏览器/游戏，只有桌面可见时才露出来
function applyDockOnTop(on) {
  if (!dockWin || dockWin.isDestroyed()) return
  dockWin.setAlwaysOnTop(!!on, on ? 'screen-saver' : 'normal')
  if (on) dockWin.moveTop()
}

function createDock() {
  const area = screen.getPrimaryDisplay().workArea
  const saved = loadDockPos()
  const startOrient = saved && isVertical(saved.orient) ? saved.orient : 'h'
  dockOrient = startOrient
  const pin = !!settings.get().dockOnTop

  const W = isVertical(startOrient) ? DOCK_V_W : DOCK_H_W
  const H = isVertical(startOrient) ? Math.min(DOCK_V_MIN_H, area.height - 40) : DOCK_H_H
  const startX = saved ? saved.x : Math.round(area.x + (area.width - W) / 2)
  const startY = saved ? saved.y : Math.round(area.y + area.height - H - 6)
  // 竖排恢复时窗口高度从占位值涨到真实内容高，这段时间内保持居中
  if (isVertical(startOrient)) orientChangedAt = Date.now()

  dockWin = new BrowserWindow({
    width: W,
    height: H,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: pin,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  if (pin) dockWin.setAlwaysOnTop(true, 'screen-saver')

  // 拖动停下 300ms 后判定贴边吸附
  let posTimer = null
  dockWin.on('moved', () => {
    if (orientBusy) return
    // 拖动中预览浮窗留在原地会很怪，直接收起来
    if (previewWin && !previewWin.isDestroyed() && previewWin.isVisible()) previewWin.hide()
    clearTimeout(posTimer)
    posTimer = setTimeout(onDockMoveEnd, 300)
  })
  dockWin.loadFile(path.join(__dirname, 'renderer', 'dock.html'))
  dockWin.webContents.on('did-finish-load', () => {
    if (dockWin && !dockWin.isDestroyed() && !dockWin.webContents.isDestroyed()) {
      dockWin.webContents.send('dock-orient', dockOrient)
    }
  })
  dockWin.once('ready-to-show', () => {
    if (!dockWin || dockWin.isDestroyed()) return
    dockWin.show()
    // 不置顶时先把窗口提到同层最前，否则启动瞬间就被别的窗口压住了
    if (!pin) dockWin.moveTop()
    // 任务栏自动隐藏时，鼠标碰底边要让开，别互相压着
    startTaskbarDodge()
  })
}

// 面板拖到哪儿就记在哪儿，下次打开还在原位
function panelPosFile() {
  return path.join(app.getPath('userData'), 'panel-pos.json')
}

function loadPanelPos() {
  try {
    const p = JSON.parse(fs.readFileSync(panelPosFile(), 'utf8'))
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p
  } catch (e) {
    /* 没存过就居中 */
  }
  return null
}

let panelPosTimer = 0

function savePanelPos() {
  if (!gridWin || gridWin.isDestroyed()) return
  const b = gridWin.getBounds()
  try {
    fs.writeFileSync(panelPosFile(), JSON.stringify({ x: b.x, y: b.y }))
  } catch (e) {
    /* ignore */
  }
}

function savePanelPosSoon() {
  clearTimeout(panelPosTimer)
  panelPosTimer = setTimeout(savePanelPos, 400)
}

function createGrid() {
  panelPad = { r: 0, b: 0 }
  const area = screen.getPrimaryDisplay().workArea
  // 面板只占屏幕约三分之二，居中浮动；太窄放不下图标网格，太宽就变回全屏了
  const W = Math.min(1320, Math.max(760, Math.round(area.width * 0.66)))
  const H = Math.min(860, Math.max(520, Math.round(area.height * 0.7)))
  const defX = Math.round(area.x + (area.width - W) / 2)
  const defY = Math.round(area.y + (area.height - H) / 2)

  // 上次拖到的位置：屏幕接了又拔、分辨率变过，旧坐标可能整块跑到屏幕外，那种就回中
  let px = defX
  let py = defY
  const saved = loadPanelPos()
  if (saved) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return saved.x + W > a.x + 120 && saved.x < a.x + a.width - 120 &&
             saved.y + H > a.y + 80 && saved.y < a.y + a.height - 80
    })
    if (onScreen) {
      px = saved.x
      py = saved.y
    }
  }

  gridWin = new BrowserWindow({
    x: px,
    y: py,
    width: W,
    height: H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  gridWin.setAlwaysOnTop(true, 'screen-saver')
  // 拖动结束后记下位置（debounce，拖的过程中不写盘）
  gridWin.on('moved', savePanelPosSoon)
  // 面板不再铺满屏幕，点外面收不到事件，只能靠失焦来关。
  // 打开设置窗时也会失焦，那种情况别关。
  gridWin.on('blur', () => {
    if (!settings.get().closeOnBlur) return
    setTimeout(() => {
      if (!gridWin || gridWin.isDestroyed() || !gridWin.isVisible()) return
      // 换图标 / 导入 / 扫描时会弹原生对话框，父窗口必然失焦，别把面板一起关了
      if (nativeDialogOpen) return
      if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) return
      if (gridWin.isFocused()) return
      hideGridAnimated()
    }, 260)
  })
  gridWin.loadFile(path.join(__dirname, 'renderer', 'grid.html'))
}

function createPreview() {
  previewWin = new BrowserWindow({
    width: 380,
    height: 252,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  previewWin.setAlwaysOnTop(true, 'screen-saver')
  previewWin.setIgnoreMouseEvents(true)
  previewWin.loadFile(path.join(__dirname, 'renderer', 'preview.html'))
  previewReady = new Promise((resolve) => {
    previewWin.once('ready-to-show', () => resolve())
    previewWin.webContents.once('did-finish-load', () => resolve())
  })
  previewWin.on('closed', () => {
    previewWin = null
    previewReady = Promise.resolve()
  })
}

// 悬停缩略图窗不再常驻：没人悬停的时候它是一个完整的渲染进程，
// 白白占七八十 MB。第一次要用才创建，闲置一段时间就销毁。
function ensurePreview() {
  if (previewWin && !previewWin.isDestroyed()) {
    clearTimeout(previewIdleTimer)
    return previewWin
  }
  createPreview()
  return previewWin
}

function schedulePreviewIdleClose() {
  clearTimeout(previewIdleTimer)
  previewIdleTimer = setTimeout(() => {
    if (!previewWin || previewWin.isDestroyed()) return
    if (previewWin.isVisible()) return
    previewWin.destroy()
    previewWin = null
  }, 120000)
}

function createSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    // 40ms 销毁宽限期内被重新打开的话，把透明度恢复回来
    settingsWin.setOpacity(1)
    settingsWin.show()
    settingsWin.focus()
    return
  }
  const area = screen.getPrimaryDisplay().workArea
  const W = 472
  const H = Math.min(870, area.height - 80)

  settingsWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(area.x + (area.width - W) / 2),
    y: Math.round(area.y + (area.height - H) / 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    // 阴影必须关：非前台状态下 hide/destroy 时，DWM 的投影要慢半拍才收掉，
    // 窗口超出应用面板的上下两段会残留一圈暗影（点 ✕ 时是前台所以看不出，点外面/齿轮就露馅）
    hasShadow: false,
    show: false,
    title: 'DockPad 设置',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'))
  // 网格是 screen-saver 级置顶，设置窗必须同级，否则会被网格压住看不见
  settingsWin.setAlwaysOnTop(true, 'screen-saver')
  settingsWin.once('ready-to-show', () => settingsWin.show())
  // 点窗口外面的东西就关掉。延迟一小段：拖动窗口、切原生对话框都会瞬时失焦，别误关
  settingsWin.on('blur', () => {
    setTimeout(() => {
      if (!settingsWin || settingsWin.isDestroyed()) return
      if (settingsWin.isFocused()) return
      if (nativeDialogOpen) return
      closeSettingsWindow()
    }, 60)
  })
  settingsWin.on('closed', () => {
    settingsWin = null
  })
}

// 关闭设置窗：先 setOpacity(0) 再延迟销毁。
// 实测（录屏逐帧）：设置窗不是前台窗口时，直接 hide/destroy DWM 会偷懒不重绘，
// 窗口超出应用面板的上下两段会在屏幕上残留 0.8 秒以上。
// setOpacity(0) 会强制 DWM 立刻按全透明重排这块区域，残影当场消失；
// 延迟的 40ms 里窗口已经是全透明的，肉眼无感知，随后立即销毁、不复用。
let settingsHideTimer = null
let settingsClosedAt = 0

function closeSettingsWindow() {
  if (!settingsWin || settingsWin.isDestroyed()) return
  clearTimeout(settingsHideTimer)
  settingsWin.setOpacity(0)
  settingsHideTimer = setTimeout(() => {
    settingsHideTimer = null
    if (!settingsWin || settingsWin.isDestroyed()) return
    settingsWin.hide()
    settingsWin.destroy()
    settingsWin = null
    settingsClosedAt = Date.now()
  }, 40)
}

// 原生对话框打开期间父窗口会失焦，设置窗的「点外面关闭」靠这个标志跳过。
// 注意：里面必须直接调 dialog.showOpenDialog，调自己会无限递归（踩过）。
let nativeDialogOpen = false

async function showOpenDialogSafe(win, opts) {
  nativeDialogOpen = true
  try {
    return await dialog.showOpenDialog(win, opts)
  } finally {
    nativeDialogOpen = false
  }
}

ipcMain.handle('get-apps', () => buildApps())
ipcMain.handle('get-pinned', () => buildPinned())
ipcMain.handle('get-groups', () => listGroups())

ipcMain.handle('rename-app', async (event, targetPath, newName) => {
  const ok = await renameApp(targetPath, newName)
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  return ok
})

function broadcastAppsReset() {
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
}

// 从库里移除一个应用（不动磁盘上的文件）
ipcMain.handle('remove-app', (event, appPath) => {
  const res = removeApp(appPath)
  if (res.ok) broadcastAppsReset()
  return res
})

// 修改应用的目标路径（快捷方式失效后手动指到新位置）
ipcMain.handle('set-app-path', (event, oldPath, newPath) => {
  const res = updateAppPath(oldPath, newPath)
  if (res.ok) broadcastAppsReset()
  return res
})

ipcMain.handle('save-order', (event, paths) => {
  saveOrder(paths)
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  return true
})

ipcMain.handle('save-dock-order', (event, paths) => {
  saveDockOrder(paths)
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  return true
})

ipcMain.handle('window-thumb', (event, targetPath) => windowThumbFor(targetPath))

// 气泡本体：url 有值就是「名字 + 缩略图」的大卡片，没值就是一行字的小黑框。
// show-preview（应用图标）和 show-name-tip（Dock 上四个快捷按钮）共用它，
// 这样两边的提示观感完全一致。
async function showTipCard(url, label, anchorX, anchorY, textW) {
  if (!dockWin || dockWin.isDestroyed()) return false
  ensurePreview()
  if (!previewWin || previewWin.isDestroyed()) return false
  await previewReady
  if (!previewWin || previewWin.isDestroyed()) return false

  // 有缩略图时用大卡片；只有名字时做成和原来一样的紧凑小黑框（高度只够一行字），
  // 并且离 Dock 顶边留 16px，免得鼠标箭头压到框上
  const text = String(label || '')
  const chars = Array.from(text).length
  // 渲染进程能用 canvas 量出真实文字宽度（英文名比中文窄很多，按字数估会左右多出黑边）；
  // 拿不到就退回按字数估：中文字约 13px，英文约 7px
  const measured = Math.ceil(Number(textW) || 0)
  const est = Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 13 : 7), 0)
  const W = url ? 380 : Math.min(320, Math.max(64, (measured || est) + 22))
  const H = url ? 252 : 30
  const GAP = url ? 8 : 16
  const cur = previewWin.getBounds()
  if (cur.width !== W || cur.height !== H) previewWin.setBounds({ x: cur.x, y: cur.y, width: W, height: H })

  // 一律相对 Dock 窗口定位：以前横排写死「屏幕底部往上 100px」，
  // 结果把 Dock 拖到别处后预览框还留在原地
  const db = dockWin.getBounds()
  const area = screen.getDisplayMatching(db).workArea
  const b = previewWin.getBounds()
  let x
  let y

  if (isVertical(dockOrient)) {
    x = dockOrient === 'left' ? db.x + db.width + GAP : db.x - b.width - GAP
    y = (anchorY || db.y + db.height / 2) - b.height / 2
  } else {
    x = anchorX - b.width / 2
    y = db.y - b.height - GAP
    if (y < area.y + 8) y = db.y + db.height + GAP // 上方放不下就翻到下面
  }

  x = Math.round(Math.max(area.x + 8, Math.min(x, area.x + area.width - b.width - 8)))
  y = Math.round(Math.max(area.y + 8, Math.min(y, area.y + area.height - b.height - 8)))

  previewWin.setPosition(x, y)
  previewWin.webContents.send('preview-src', { src: url || '', name: text })
  previewWin.showInactive()
  return true
}

ipcMain.handle('show-preview', async (event, targetPath, appName, anchorX, anchorY, textW) => {
  if (!settings.get().hoverPreview) return false
  if (!dockWin || dockWin.isDestroyed()) return false
  // 截图失败也照样弹：只显示名字（有个别窗口抓不到缩略图）
  const url = await windowThumbFor(targetPath)
  return showTipCard(url, appName, anchorX, anchorY, textW)
})

// Dock 上四个快捷按钮的提示：纯文字，不受「悬停窗口预览」开关影响
ipcMain.handle('show-name-tip', async (event, label, anchorX, anchorY, textW) => {
  return showTipCard('', label, anchorX, anchorY, textW)
})

ipcMain.on('hide-preview', () => {
  if (previewWin && !previewWin.isDestroyed()) previewWin.hide()
  schedulePreviewIdleClose()
})

// ---------- 设置 ----------
function broadcastSettings(s) {
  for (const w of [dockWin, gridWin, settingsWin]) {
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
      w.webContents.send('settings-changed', s)
    }
  }
}

ipcMain.handle('get-settings', () => settings.get())

ipcMain.handle('set-settings', (event, patch) => {
  const prev = settings.get()
  const s = settings.set(patch)
  if (s.dockOnTop !== prev.dockOnTop) applyDockOnTop(s.dockOnTop)
  // 快捷键改动立刻重新注册（被占用会退回内置组合）
  if (s.hotkeyPanel !== prev.hotkeyPanel || s.hotkeySettings !== prev.hotkeySettings || s.hotkeyScan !== prev.hotkeyScan) {
    registerShortcuts()
  }
  broadcastSettings(s)
  return s
})
ipcMain.handle('get-shortcuts', () => Object.assign({}, activeShortcuts))

// 设置里录制快捷键时先全部注销，否则按下去的组合会被全局快捷键先吃掉，录不到
ipcMain.handle('suspend-shortcuts', () => {
  try { globalShortcut.unregisterAll() } catch (e) { /* ignore */ }
  return true
})
ipcMain.handle('resume-shortcuts', () => registerShortcuts())

ipcMain.handle('get-autostart', () => autoStartEnabled())

ipcMain.handle('set-autostart', (event, on) => {
  const ok = applyAutoStart(!!on)
  try {
    fs.writeFileSync(autoStartInitFile(), new Date().toISOString())
  } catch (e) {
    /* ignore */
  }
  return ok
})

// ---------- 运行状态与窗口切换 ----------
ipcMain.handle('running-procs', () => listRunningProcs())

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts || {}, (err, stdout) => resolve(err ? '' : String(stdout || '')))
  })
}

// 把已经开着的程序切到前台。Electron 没有窗口管理 API，只能借 WScript.Shell.AppActivate，
// 它按 PID 激活；拿不到就返回 false，让前端退回「重新启动」。
async function activateApp(appPath) {
  const proc = exeOf(appPath)
  if (!proc) return false
  const name = proc.replace(/'/g, "''")
  const ps =
    `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
    `if ($p) { try { $r = (New-Object -ComObject WScript.Shell).AppActivate($p.Id) } catch { $r = $false }; if ($r) { 'ok' } else { 'fail' } } else { 'none' }`
  const out = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    timeout: 4000,
    encoding: 'utf8',
  })
  return out.trim() === 'ok'
}

ipcMain.handle('activate-app', (event, appPath) => activateApp(appPath))

// ---------- Dock 自动隐藏 ----------
let autoHideTimer = null
let dockAutoHidden = false
let dockRestoreBounds = null
let dockLastHoverAt = 0

const REVEAL_PX = 8 // 屏幕底边这个高度内算「唤出区」

function tickAutoHide() {
  if (!dockWin || dockWin.isDestroyed()) return
  // 刚启动或刚开启时给一个宽限期，别一上来就把 Dock 藏起来
  if (!dockLastHoverAt) dockLastHoverAt = Date.now()
  const s = settings.get()
  // 竖排和「不自动隐藏」都直接还原，别让 Dock 卡在屏幕外
  if (!s.autoHide || isVertical(dockOrient)) {
    if (dockAutoHidden) revealDock()
    return
  }

  const area = screen.getPrimaryDisplay().workArea
  const rect = dockAutoHidden ? dockRestoreBounds : dockWin.getBounds()
  if (!rect) return
  const p = screen.getCursorScreenPoint()

  const overDock =
    p.x >= rect.x - 2 && p.x <= rect.x + rect.width + 2 && p.y >= rect.y - 2 && p.y <= rect.y + rect.height + 2

  if (overDock) {
    dockLastHoverAt = Date.now()
    if (dockAutoHidden) revealDock()
    return
  }

  if (dockAutoHidden) {
    const inReveal =
      p.y >= area.y + area.height - REVEAL_PX && p.x >= rect.x && p.x <= rect.x + rect.width
    if (inReveal) revealDock()
    return
  }

  if (Date.now() - dockLastHoverAt > s.autoHideDelay) hideDockAuto()
}

function hideDockAuto() {
  if (dockAutoHidden || !dockWin || dockWin.isDestroyed()) return
  dockRestoreBounds = dockWin.getBounds()
  dockAutoHidden = true
  if (previewWin && !previewWin.isDestroyed()) previewWin.hide()
  orientBusy = true
  dockWin.setPosition(dockRestoreBounds.x, dockRestoreBounds.y + dockRestoreBounds.height + 12)
  setTimeout(() => {
    orientBusy = false
    syncDockAnchor()
  }, 220)
}

function revealDock() {
  if (!dockAutoHidden || !dockWin || dockWin.isDestroyed()) return
  dockAutoHidden = false
  if (!dockRestoreBounds) return
  orientBusy = true
  dockWin.setBounds(dockRestoreBounds)
  setTimeout(() => {
    orientBusy = false
    syncDockAnchor()
  }, 220)
}

function startAutoHideLoop() {
  if (autoHideTimer) return
  autoHideTimer = setInterval(tickAutoHide, 110)
}

// ---------- 全局快捷键 ----------
// 面板收起：先让渲染进程播缩回动画，播完再真正 hide。
// 兜一层超时，万一动画事件没回来，别把面板永远留在屏幕上。
let gridClosing = false

// Dock 上「全部应用」按钮的屏幕矩形。Dock 渲染进程会在布局变化时报上来，
// 托盘菜单 / 快捷键开面板时没有点击坐标，就靠这份兜底，动画依然从按钮里出来。
let gridAnchorRect = null

function anchorCenter(a) {
  if (!a) return null
  const x = Number(a.x)
  const y = Number(a.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const w = Number(a.w) || 0
  const h = Number(a.h) || 0
  return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) }
}

function resolveGridAnchor(a) {
  return anchorCenter(a) || anchorCenter(gridAnchorRect)
}

ipcMain.on('grid-anchor', (event, rect) => {
  if (anchorCenter(rect)) gridAnchorRect = rect
})

// ---------- 开合动画用的临时窗口扩展 ----------
// 面板窗口只比面板本身大一圈，而 Dock 按钮在面板下方、落在窗口外，窗口外的内容画不出来，
// 所以缩小时面板只能缩到自己下边缘，跟按钮之间始终隔着一条空隙。
// 开合动画期间把窗口朝右下扩出一块透明区域，面板就能一路缩到按钮上。
// 只往右下扩：面板左上角不动，收回去的时候面板一个像素都不会跳。
let panelPad = { r: 0, b: 0 }
let panelPadTimer = null

function basePanelBounds() {
  const b = gridWin.getBounds()
  return { x: b.x, y: b.y, width: b.width - panelPad.r, height: b.height - panelPad.b }
}

function expandForAnchor(anchor) {
  if (!gridWin || gridWin.isDestroyed()) return panelPad
  const base = basePanelBounds()
  if (!anchor) return panelPad
  // 按钮在面板左上方向时没法靠「往右下扩」覆盖到，就保持原样（动画会贴着那条边收）
  if (anchor.x < base.x || anchor.y < base.y) return panelPad

  const M = 30 // 多留一点，让最小的面板能完整落在按钮周围
  const r = Math.max(0, Math.min(600, Math.round(anchor.x + M - (base.x + base.width))))
  const b = Math.max(0, Math.min(600, Math.round(anchor.y + M - (base.y + base.height))))
  if (r === panelPad.r && b === panelPad.b) return panelPad

  panelPad = { r, b }
  gridWin.setBounds({ x: base.x, y: base.y, width: base.width + r, height: base.height + b })
  return panelPad
}

function restorePanelBounds() {
  clearTimeout(panelPadTimer)
  panelPadTimer = null
  if (!gridWin || gridWin.isDestroyed()) return
  if (!panelPad.r && !panelPad.b) return
  const base = basePanelBounds()
  panelPad = { r: 0, b: 0 }
  gridWin.setBounds(base)
}

// 渲染进程动画播完会回报，这时把动画期间多出来的透明边收掉
ipcMain.on('grid-opened', () => {
  clearTimeout(panelPadTimer)
  panelPadTimer = null
  restorePanelBounds()
})

// 面板关闭后闲置一段时间就把窗口整个销毁，回收渲染进程的 ~80MB。
// 下次打开时 createGrid() 重建：图标缓存在磁盘上，重建很快，位置和设置都不受影响。
let gridIdleTimer = null

function armGridIdleDestroy() {
  clearTimeout(gridIdleTimer)
  gridIdleTimer = setTimeout(() => {
    gridIdleTimer = null
    if (!gridWin || gridWin.isDestroyed() || gridWin.isVisible()) return
    if (gridClosing) return
    savePanelPos()
    panelPad = { r: 0, b: 0 }
    gridWin.destroy()
    gridWin = null
  }, 90000)
}

function hideGridAnimated() {
  if (!gridWin || gridWin.isDestroyed() || !gridWin.isVisible()) return
  if (gridClosing) return
  gridClosing = true
  savePanelPos() // 收起时顺手记位置，drag 过程中 moved 事件可能被系统合并
  const a = resolveGridAnchor()
  const pad = expandForAnchor(a)
  const base = basePanelBounds()
  gridWin.webContents.send(
    'grid-closing',
    a ? { x: a.x, y: a.y, padR: pad.r, padB: pad.b, w: base.width, h: base.height } : null
  )
  setTimeout(() => {
    gridClosing = false
    if (gridWin && !gridWin.isDestroyed() && gridWin.isVisible()) gridWin.hide()
    restorePanelBounds()
    armGridIdleDestroy()
  }, 450)
}

ipcMain.on('grid-closed', () => {
  gridClosing = false
  if (gridWin && !gridWin.isDestroyed() && gridWin.isVisible()) gridWin.hide()
  restorePanelBounds()
})

// anchor 是 Dock 上按钮的屏幕坐标，动画从那儿展开 / 缩回去
function showGrid(anchor) {
  if (gridIdleTimer) {
    clearTimeout(gridIdleTimer)
    gridIdleTimer = null
  }
  // 闲置销毁过的话这里重建。页面要等 ready-to-show：太早发 grid-opening 会在页面加载前丢失
  if (!gridWin || gridWin.isDestroyed()) {
    createGrid()
    gridWin.once('ready-to-show', () => {
      if (gridWin && !gridWin.isDestroyed()) showGrid(anchor)
    })
    return
  }
  const a = resolveGridAnchor(anchor)
  const pad = expandForAnchor(a)
  const base = basePanelBounds()
  gridWin.webContents.send(
    'grid-opening',
    a ? { x: a.x, y: a.y, padR: pad.r, padB: pad.b, w: base.width, h: base.height } : null
  )
  // 显示前先修一次透明表面（隐藏状态重建无闪烁）：全屏游戏打碎过表面的话，这里能直接救回来
  healWindowSurface(gridWin)
  gridWin.show()
  gridWin.focus()
  // 兜底：动画事件没回来也要把透明边收掉
  clearTimeout(panelPadTimer)
  panelPadTimer = setTimeout(restorePanelBounds, 1400)
}

function toggleGrid(anchor) {
  if (!gridWin || gridWin.isDestroyed()) {
    showGrid(anchor)
    return
  }
  if (gridWin.isVisible()) hideGridAnimated()
  else showGrid(anchor)
}

// 每个动作准备几组备选按键：一组被别的软件占了（比如 Ctrl+Alt+A 是微信截图）就换下一组，
// 免得整条快捷键直接废掉。实际生效的那组会写进托盘菜单，用户能看见自己该按什么。
const SHORTCUT_ACTIONS = [
  {
    id: 'panel',
    label: '打开应用网格',
    settingKey: 'hotkeyPanel',
    keys: ['Control+Alt+Space', 'Control+Shift+Space', 'Control+Alt+D'],
    run: () => toggleGrid(),
  },
  {
    id: 'settings',
    label: '设置…',
    settingKey: 'hotkeySettings',
    keys: ['Control+Alt+S', 'Control+Shift+S', 'Control+Alt+O'],
    run: () => createSettings(),
  },
  {
    id: 'scan',
    label: '扫描文件夹添加应用…',
    settingKey: 'hotkeyScan',
    keys: ['Control+Alt+A', 'Control+Alt+Shift+A', 'Control+Alt+G'],
    run: () => runScanDialog(),
  },
]

let activeShortcuts = {}

// 每 10 分钟让还活着的渲染进程做一次全量 GC，压住长期驻留的堆增长
setInterval(() => {
  for (const w of [dockWin, gridWin]) {
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
      w.webContents.executeJavaScript('window.gc && window.gc()').catch(() => {})
    }
  }
}, 10 * 60 * 1000)

function registerShortcuts() {
  try { globalShortcut.unregisterAll() } catch (e) { /* ignore */ }
  activeShortcuts = {}
  const conf = settings.get()
  for (const action of SHORTCUT_ACTIONS) {
    const custom = action.settingKey ? String(conf[action.settingKey] || '').trim() : ''
    // 'none' = 用户明确要求不绑定：直接跳过，不回退到内置组合（空字符串才是"用默认"）
    if (custom.toLowerCase() === 'none') continue
    // 自定义的优先；被别的软件占了就退回内置候选，保证功能不会直接失效
    const tries = custom ? [custom].concat(action.keys) : action.keys
    for (const accel of tries) {
      let ok = false
      try {
        ok = globalShortcut.register(accel, action.run)
      } catch (e) {
        ok = false
      }
      if (ok) {
        activeShortcuts[action.id] = accel
        break
      }
    }
    if (!activeShortcuts[action.id]) {
      console.log('[shortcut]', action.id, '全部被占用')
    }
  }
  refreshTrayMenu()
  return Object.assign({}, activeShortcuts)
}

ipcMain.on('open-settings', () => createSettings())

// 面板右上角齿轮：开着就关，关着就开。
// 注意那个 400ms 守卫：设置窗有焦点时点齿轮，焦点切换会让设置窗先失焦、
// 60ms 后被「点外面关闭」的逻辑关掉，而点击的 IPC 是之后才到的——
// 不加守卫的话这里会看到「窗口没了」于是又开一个新的，看起来就是关了又弹回来。
ipcMain.on('toggle-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) {
    closeSettingsWindow()
    return
  }
  if (!settingsWin && Date.now() - settingsClosedAt < 400) return
  createSettings()
})

// Dock 上的网格按钮：点一下开，再点一下关
ipcMain.on('toggle-grid', (e, anchor) => toggleGrid(anchor))

// Dock 条空白处右键：和托盘共用同一份菜单（透明度、设置、网格、退出）
ipcMain.on('dock-menu', () => {
  if (!dockWin || dockWin.isDestroyed()) return
  try {
    Menu.buildFromTemplate(buildTrayTemplate()).popup({ window: dockWin })
  } catch (e) {
    /* ignore */
  }
})

ipcMain.on('close-settings', () => closeSettingsWindow())

// 挑一个还活着的窗口当原生对话框的父窗口（面板可能处于「关闭后销毁」的空闲期）
function dialogParent() {
  for (const w of [settingsWin, gridWin, dockWin]) {
    if (w && !w.isDestroyed()) return w
  }
  return null
}

// ---------- 应用库 ----------
ipcMain.handle('library-info', () => getLibraryInfo())

ipcMain.handle('library-import', async () => {
  const win = dialogParent()
  const res = await showOpenDialogSafe(win, {
    title: '选择要导入的文件夹（会递归扫描其中的 .lnk / .url）',
    defaultPath: LEGACY_DIR,
    buttonLabel: '导入',
    properties: ['openDirectory'],
  })
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }

  const plan = planImportFolder(res.filePaths[0])
  if (!plan.ok) {
    notifyImport({ added: 0, skipped: 0, errors: [plan.error || '导入失败'] })
    return plan
  }
  if (!plan.files.length) {
    notifyImport({ added: 0, skipped: 0, errors: ['没有可导入的新快捷方式'] })
    return { ok: true, added: 0 }
  }

  const chosen = await pickAppsInteractive(plan.files)
  if (!chosen || !chosen.length) return { ok: false, canceled: true }

  const out = importPicked(chosen)
  if (out.added) {
    if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
    if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
    notifyImport({ added: out.added, files: out.added })
  } else {
    notifyImport({ added: 0, skipped: chosen.length })
  }
  return out
})

ipcMain.handle('library-add', async () => {
  const win = dialogParent()
  const res = await showOpenDialogSafe(win, {
    title: '添加快捷方式',
    defaultPath: LEGACY_DIR,
    buttonLabel: '添加',
    filters: [{ name: '快捷方式', extensions: ['lnk', 'url'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }

  let added = 0
  let lastName = ''
  let lastError = ''
  for (const p of res.filePaths) {
    const r = addApp(p)
    if (r.ok) {
      added++
      lastName = path.basename(p, path.extname(p))
    } else {
      lastError = r.error || ''
    }
  }
  if (!added) return { ok: false, error: lastError || '没有添加成功' }
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  return { ok: true, added, name: lastName }
})

// 从桌面/资源管理器把文件夹或快捷方式拖到 Dock 条上
ipcMain.handle('import-drop', async (event, paths) => {
  const list = Array.isArray(paths) ? paths : []
  const dirs = []
  const files = []
  // 文件夹属于批量添加：先把里面会新增的快捷方式列出来，让用户勾选
  for (const p of list) {
    try {
      if (fs.statSync(p).isDirectory()) dirs.push(p)
      else files.push(p)
    } catch (e) {
      /* 找不到的路径丢给 importDropped 报错 */
      files.push(p)
    }
  }

  let dirPlans = []
  if (dirs.length) {
    dirPlans = dirs.map((d) => ({ d, plan: planFolderAsGroup(d) })).filter((x) => x.plan.ok && x.plan.files.length)
    const cands = []
    for (const { plan } of dirPlans) {
      for (const f of plan.files) cands.push({ path: f.path, name: f.name, group: plan.group })
    }
    if (cands.length) {
      const chosen = await pickAppsInteractive(cands)
      if (!chosen || !chosen.length) return { added: 0, skipped: cands.length, errors: ['已取消'], canceled: true }
      // 按文件夹分组回填各自要导入的路径（候选对象的 group 就是文件夹名）
      for (const item of dirPlans) {
        item.only = new Set(chosen.filter((c) => c.group === item.plan.group).map((c) => c.path))
      }
    }
  }

  // 不经确认的直接文件，走原有逻辑；带勾选的文件夹走过滤导入
  const res = importDropped(files)
  for (const item of dirPlans) {
    if (item.only && !item.only.size) {
      res.skipped += item.plan.files.length
      continue
    }
    const r = addFolderAsGroup(item.d, item.only)
    if (r.ok) {
      res.folders.push({ name: r.group, added: r.added, isNewGroup: r.isNewGroup, skipped: r.skipped })
      res.added += r.added
      res.skipped += r.skipped
    } else {
      res.errors.push(r.error || '文件夹导入失败')
    }
  }
  invalidate()
  if (res.added) {
    if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
    if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  }
  notifyImport(res)
  return res
})

function notifyImport(res) {
  try {
    if (!Notification.isSupported()) return
    const parts = []
    for (const f of res.folders || []) {
      if (f.added) parts.push((f.isNew ? '新建分类「' + f.name + '」并添加 ' : '分类「' + f.name + '」新增 ') + f.added + ' 个')
    }
    if (res.files) parts.push('直接添加 ' + res.files + ' 个')
    if (!parts.length) {
      const why = (res.errors && res.errors[0]) || (res.skipped ? '都已经在库里了' : '没有可导入的快捷方式')
      parts.push(why)
    }
    new Notification({ title: 'DockPad', body: parts.join('\n'), silent: true }).show()
  } catch (e) {
    /* 通知发不出来就算了，不影响导入本身 */
  }
}

// 一键扫描应用：设置页按钮和 Ctrl+Alt+A 共用这一套
// 把待选清单发给应用面板，让用户勾选要添加哪些；返回选中的数组，取消返回 null。
// 面板没开就先打开。选择框是面板内的页面元素，不会抢焦点、面板也不会被关掉。
async function pickAppsInteractive(candidates) {
  if (!gridWin || gridWin.isDestroyed()) showGrid()
  if (!gridWin || gridWin.isDestroyed()) return null
  // 等面板显示出来再弹选择框（刚从闲置销毁里重建的话页面还要加载一小会）
  for (let i = 0; i < 40 && !gridWin.isVisible(); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  await new Promise((r) => setTimeout(r, 250))
  try {
    return await gridWin.webContents.executeJavaScript(
      'window.pickApps ? window.pickApps(' + JSON.stringify(candidates || []) + ') : null',
      true
    )
  } catch (e) {
    return null
  }
}

async function runScanDialog() {
  const win = dialogParent()
  const res = await showOpenDialogSafe(win, {
    title: '选择要扫描的文件夹（会递归查找其中的 .exe）',
    buttonLabel: '开始扫描',
    properties: ['openDirectory'],
  })
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }

  const plan = await planAppsFromFolder(res.filePaths[0])
  if (!plan.ok) {
    notifyImport({ added: 0, skipped: 0, errors: [plan.error || '扫描失败'] })
    return plan
  }
  if (!plan.picked.length) {
    notifyImport({ added: 0, skipped: 0, errors: ['没找到可添加的主程序'] })
    return { ok: true, added: 0, duplicate: 0 }
  }

  const chosen = await pickAppsInteractive(plan.picked)
  if (!chosen || !chosen.length) return { ok: false, canceled: true }

  const out = addPickedApps(chosen)
  if (out.added) {
    invalidate()
    if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
    if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
    notifyImport({ added: out.added, files: out.added, skipped: out.duplicate || 0 })
  } else {
    notifyImport({ added: 0, skipped: out.duplicate || chosen.length })
  }
  return { ok: true, added: out.added, duplicate: out.duplicate }
}

ipcMain.handle('scan-apps', () => runScanDialog())

ipcMain.handle('reset-dock-pos', () => {
  resetDockPosition()
  return true
})

ipcMain.handle('clear-icon-cache', () => {
  invalidate()
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  return true
})

// 竖排时渲染进程上报真实内容高度，窗口贴合内容，避免大片透明区域挡住桌面点击
ipcMain.on('dock-resize', (event, h) => {
  if (!dockWin || dockWin.isDestroyed()) return
  const hh = Math.round(Number(h) || 0)
  if (!hh) return
  dockContentH = hh
  if (!isVertical(dockOrient)) return
  const b = dockWin.getBounds()
  const area = screen.getDisplayMatching(b).workArea
  const H = Math.min(Math.max(hh + 24, DOCK_V_MIN_H), area.height - 40)
  if (Math.abs(H - b.height) < 4) return
  // 刚切到竖排的 1.8 秒内重新居中；之后保留用户上下拖到的位置
  const recent = Date.now() - orientChangedAt < 1800
  const y = recent ? area.y + (area.height - H) / 2 : Math.max(area.y, Math.min(b.y, area.y + area.height - H))
  orientBusy = true
  dockWin.setBounds({ x: b.x, y: Math.round(y), width: b.width, height: Math.round(H) })
  saveDockPos(b.x, y, dockOrient)
  setTimeout(() => {
    orientBusy = false
  }, 260)
})

ipcMain.handle('pick-icon', async (event, targetPath) => {
  const win = BrowserWindow.getFocusedWindow() || dialogParent()
  const res = await showOpenDialogSafe(win, {
    title: '选择图标图片',
    filters: [{ name: '图片', extensions: ['png', 'ico', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    properties: ['openFile'],
  })
  if (res.canceled || !res.filePaths.length) return ''
  const img = nativeImage.createFromPath(res.filePaths[0])
  if (img.isEmpty()) return ''
  const size = img.getSize()
  const edge = Math.max(size.width, size.height)
  const scaled = edge > 256 ? img.resize({ width: Math.round((size.width * 256) / edge), height: Math.round((size.height * 256) / edge), quality: 'best' }) : img
  const dataUrl = scaled.toDataURL()
  setCustomIcon(targetPath, dataUrl)
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  return dataUrl
})

ipcMain.handle('reset-icon', (event, targetPath) => {
  setCustomIcon(targetPath, '')
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  return true
})

ipcMain.handle('create-group', (event, name) => {
  const res = createGroup(name)
  if (res.ok) {
    if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
    if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  }
  return res
})

ipcMain.handle('move-to-group', (event, targetPath, group) => {
  const res = moveToGroup(targetPath, group)
  if (res.ok) {
    if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
    if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  }
  return res
})

ipcMain.handle('get-locked-groups', () => getLockedGroups())

ipcMain.handle('set-group-locked', (event, group, locked) => {
  const res = setGroupLocked(group, locked)
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  return res
})

ipcMain.handle('get-password-groups', () => getPasswordGroups())

ipcMain.handle('set-group-password', (event, group, plain) => setGroupPassword(group, plain))

ipcMain.handle('verify-group-password', (event, group, plain) => verifyGroupPassword(group, plain))

ipcMain.handle('rename-group', (event, oldName, newName) => {
  const res = renameGroup(oldName, newName)
  if (res.ok) {
    if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
    if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  }
  return res
})

ipcMain.handle('remove-group', (event, name) => {
  const res = removeGroup(name)
  if (res.ok) {
    if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
    if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  }
  return res
})

ipcMain.handle('get-dock-paths', () => getDockPaths())

ipcMain.handle('add-to-dock', async (event, targetPath) => {
  const res = await addToDock(targetPath)
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  return res
})

ipcMain.handle('remove-from-dock', async (event, targetPath) => {
  const res = await removeFromDock(targetPath)
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  return res
})

ipcMain.handle('launch', async (event, target) => {
  if (gridWin && gridWin.isVisible()) hideGridAnimated()
  // 记下使用时间，「按最近使用排序」靠它
  try {
    touchApp(target)
  } catch (e) {
    /* 不在库里的（Dock 外部条目）忽略 */
  }
  const err = await shell.openPath(target)
  return err || ''
})

// ---- 桌面图标显示 / 隐藏 ----
// Windows 没给命令行开关，只能给桌面的 SHELLDLL_DefView 发 WM_COMMAND 0x7402。
// 用 Python + ctypes 调 Win32（PowerShell 的 Add-Type 被安全策略挡着）。
let pythonLauncher = null

function pythonCandidates() {
  return [
    ['py', ['-3']],
    ['python', []],
    ['python3', []],
    ['D:\\app\\python\\python.exe', []],
  ]
}

function runDesktopIcons(action) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'tools', 'deskicons.py')
    if (!fs.existsSync(script)) {
      resolve({ ok: false, error: '缺少 tools/deskicons.py' })
      return
    }
    const tries = pythonLauncher ? [pythonLauncher] : pythonCandidates()
    let idx = 0
    let lastErr = ''

    const next = () => {
      if (idx >= tries.length) {
        resolve({ ok: false, error: lastErr || '找不到可用的 Python' })
        return
      }
      const [cmd, pre] = tries[idx++]
      execFile(
        cmd,
        pre.concat([script, action]),
        { windowsHide: true, timeout: 6000 },
        (err, stdout) => {
          if (err) {
            lastErr = err.message
            next()
            return
          }
          try {
            const line = String(stdout).trim().split('\n').pop()
            const out = JSON.parse(line)
            pythonLauncher = [cmd, pre] // 记住能用的那个，下次不用再试
            resolve(out)
          } catch (e) {
            lastErr = '输出无法解析：' + String(stdout).slice(0, 80)
            next()
          }
        }
      )
    }
    next()
  })
}

ipcMain.handle('desktop-icons', (event, action) =>
  runDesktopIcons(action === 'query' ? 'query' : 'toggle')
)

ipcMain.on('show-grid', (e, anchor) => showGrid(anchor))
ipcMain.on('hide-grid', () => hideGridAnimated())

// Dock 上的「此电脑」：用资源管理器打开 My Computer 命名空间
ipcMain.on('open-this-pc', () => {
  try {
    execFile('explorer.exe', ['shell:MyComputerFolder'])
  } catch (e) {
    /* ignore */
  }
})


ipcMain.on('quit-app', () => app.quit())

ipcMain.on('reload-apps', () => {
  invalidate()
  if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset')
  if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset')
})

// 开机自启：写 HKCU 的 Run 项。
// 坑：Run 项只能指向「单一可执行文件」。指向 .bat 时绿色版的 %~dp0 会落到 resources\app，
// 那里没有 electron 运行时，必然启动失败。
// 绿色版的 process.execPath 就是 DockPad.exe，直接写它；只有开发模式（electron.exe 跑源码）
// 才需要走 bat 去清掉 ELECTRON_RUN_AS_NODE。
// 注意：本机安全策略拉黑了 reg.exe，所以走 PowerShell
const RUN_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function launcherTarget() {
  const exe = process.execPath
  if (path.basename(exe).toLowerCase() === 'electron.exe') {
    return path.join(__dirname, '启动 DockPad.bat')
  }
  return exe
}

function autoStartInitFile() {
  return path.join(app.getPath('userData'), 'autostart.init')
}

let autoStartCache
function autoStartRaw() {
  if (autoStartCache !== undefined) return autoStartCache
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-ItemProperty '${RUN_PATH}' -ErrorAction SilentlyContinue).DockPad`],
      { encoding: 'utf8', stdio: 'pipe', timeout: 4000 }
    )
    const v = String(out).trim()
    autoStartCache = v ? v : null
  } catch (e) {
    autoStartCache = null
  }
  return autoStartCache
}

// 「有没有开启」只看注册表项在不在；指向哪个 exe 是另一回事
function autoStartEnabled() {
  return !!autoStartRaw()
}

// 项存在但指向过期路径（比如历史上写的是 bat）时需要校正
function autoStartPointsToTarget() {
  const raw = autoStartRaw()
  if (!raw) return false
  return raw.replace(/^"|"$/g, '') === launcherTarget()
}

function applyAutoStart(enabled) {
  const ps = enabled
    ? `Set-ItemProperty -Path '${RUN_PATH}' -Name 'DockPad' -Value '"${launcherTarget()}"' -Type String`
    : `Remove-ItemProperty -Path '${RUN_PATH}' -Name 'DockPad' -ErrorAction SilentlyContinue`
  try {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], () => {
      autoStartCache = undefined
    })
    autoStartCache = enabled ? `"${launcherTarget()}"` : null
    return true
  } catch (e) {
    return false
  }
}


function buildTrayTemplate() {
  return [
    {
      label: '打开应用网格',
      click: () => {
        if (!gridWin || gridWin.isDestroyed()) return
        if (gridWin.isVisible()) gridWin.focus()
        else showGrid()
      },
    },
    { label: '扫描文件夹添加应用…', click: () => runScanDialog() },
    { label: '设置…', click: () => createSettings() },
    { label: '刷新图标', click: () => { invalidate(); if (gridWin && !gridWin.isDestroyed()) gridWin.webContents.send('apps-reset'); if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('apps-reset') } },
    { label: '修复黑屏（透明失效）', click: () => { surfHealState.fails = 0; healAllSurfaces(true) } },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autoStartEnabled(),
      click: (item) => {
        applyAutoStart(item.checked)
        try {
          fs.writeFileSync(autoStartInitFile(), new Date().toISOString())
        } catch (e) {
          /* ignore */
        }
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]
}

// 在菜单项回调里直接重设同一个托盘菜单容易崩，挪到下一轮事件循环再换
function refreshTrayMenu() {
  if (!tray) return
  setImmediate(() => {
    try {
      if (tray && !tray.isDestroyed()) {
        tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()))
      }
    } catch (e) {
      /* ignore */
    }
  })
}

function makeTray() {
  // 托盘用应用自己的图标（icon.ico 里有 16~256 全套尺寸，缩到 32 更清晰）
  let img = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'))
  if (!img.isEmpty()) {
    const s = img.getSize()
    if (s.width > 32) img = img.resize({ width: 32, height: 32, quality: 'best' })
  } else {
    // 兜底：以前那个灰圆点，图标文件缺失时才用
    const size = 32
    const buf = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        const dx = x - size / 2 + 0.5
        const dy = y - size / 2 + 0.5
        const inside = dx * dx + dy * dy < (size / 2 - 2) * (size / 2 - 2)
        buf[i] = inside ? 58 : 0
        buf[i + 1] = inside ? 58 : 0
        buf[i + 2] = inside ? 62 : 0
        buf[i + 3] = inside ? 255 : 0
      }
    }
    img = nativeImage.createFromBuffer(buf, { width: size, height: size })
  }
  tray = new Tray(img)
  tray.setToolTip('DockPad · ' + getLibraryInfo().apps + ' 个应用')
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()))
  tray.on('click', () => toggleGrid())
}

app.whenReady().then(() => {
  if (!singleInstance) {
    app.quit()
    return
  }

  createDock()
  createGrid()

  // 首次运行默认开启自启；之后尊重用户在托盘里的关闭选择（关掉就不再自动恢复）。
  // 若注册表项还在但指向过期路径（历史上写的是 bat），自动校正成 exe。
  const autoStartInit = autoStartInitFile()
  if (!fs.existsSync(autoStartInit)) {
    applyAutoStart(true)
    try {
      fs.writeFileSync(autoStartInit, new Date().toISOString())
    } catch (e) {
      /* ignore */
    }
  } else if (autoStartEnabled() && !autoStartPointsToTarget()) {
    applyAutoStart(true)
  }

  makeTray()
  logBoot('ready-ok')
  startAutoHideLoop()
  startSurfaceWatchdog()
  powerMonitor.on('resume', () => { healAllSurfaces() })
  powerMonitor.on('unlock-screen', () => { healAllSurfaces() })
  registerShortcuts()

  // 分辨率/显示器变化时把 Dock 拉回可视范围；贴边的保持贴边，不覆盖用户拖拽的位置
  screen.on('display-metrics-changed', () => {
    // 系统级显示事件正是透明表面被打碎的高发点，顺手修一次
    setTimeout(healAllSurfaces, 400)
    if (!dockWin || dockWin.isDestroyed()) return
    const b = dockWin.getBounds()
    const area = screen.getDisplayMatching(b).workArea
    let x = b.x
    let y = b.y
    if (isVertical(dockOrient)) {
      x = dockOrient === 'left' ? area.x + 2 : area.x + area.width - b.width - 2
      y = Math.max(area.y, Math.min(y, area.y + area.height - 60))
    } else {
      const minVisible = 120
      x = Math.max(area.x - b.width + minVisible, Math.min(x, area.x + area.width - minVisible))
      y = Math.max(area.y, Math.min(y, area.y + area.height - 48))
    }
    if (Math.round(x) !== b.x || Math.round(y) !== b.y) {
      orientBusy = true
      dockWin.setPosition(Math.round(x), Math.round(y))
      setTimeout(() => {
        orientBusy = false
      }, 200)
      saveDockPos(x, y, dockOrient)
    }
  })
})

app.on('second-instance', () => {
  if (gridWin && !gridWin.isDestroyed()) {
    gridWin.show()
    gridWin.focus()
  }
})

app.on('window-all-closed', (e) => {
  e.preventDefault()
})

// ---------- 透明表面自愈 ----------
// Windows 上 Electron 透明窗口的已知缺陷：全屏游戏（WeGame 启动三角洲等）、
// 分辨率切换等事件会让 DWM 重建合成表面，ARGB 分层窗口可能恢复不回来，
// 整个窗口变纯黑（连本该全透明的部分也是黑的）。
// ---------- 透明表面自愈 ----------
// Windows 上 Electron 透明窗口的已知缺陷：全屏游戏（WeGame 启动三角洲等）、
// 分辨率切换等事件会让 DWM 重建合成表面，ARGB 分层窗口可能恢复不回来，
// 整个窗口变纯黑（连本该全透明的部分也是黑的）。
// 方案：常驻探针进程每 2.5s 采样 Dock 窗口左右两个上角的像素（正常时全透明显壁纸）。
// 判定要求严格：两个角都近纯黑、且都与各自上方 12px 的壁纸参考差异明显、且连续
// 两轮都命中，才认为表面损坏。损坏后先做无损修复（尺寸+1 再还原，强制重建表面），
// 60 秒内没有新报就清零计数；连续 3 次修复无效才整进程重启兜底（5 分钟最多一次）。
//
// 关键：全屏应用（游戏）在前台时，探针只上报 FS 状态，主进程完全不动窗口——
// 否则 setBounds / setBackgroundColor / 重启窗口都会让 Dock 从游戏画面上冒出来。
// 退出全屏那一刻再补一次修复，游戏里绝不会闪。
let surfWatchProc = null
let surfRestartTries = 0
let surfaceBoundsTimer = null
let surfaceFullScreen = false
let surfHealState = { lastAt: 0, fails: 0, relaunchedAt: 0 }
let surfSettleTimer = null

const SURF_PS1 = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FsProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
'@
$bf = '__BOUNDSFILE__'
$pp = __PARENTPID__

function Test-FullScreen {
  # 主判据：Windows 官方的"用户通知状态"（任务栏/通知中心判断全屏应用用的同一套 API）
  # 2=全屏应用(F11等) 3=全屏D3D游戏 7=全屏商店应用
  $state = 0
  try { [FsProbe]::SHQueryUserNotificationState([ref]$state) | Out-Null } catch {}
  if (($state -eq 2) -or ($state -eq 3) -or ($state -eq 7)) { return $true }

  # 兜底：前台窗口铺满整屏且没有标题栏。有标题栏的一律当普通窗口——
  # 任务栏自动隐藏时任何最大化窗口都会铺满屏幕，不能算全屏
  $h = [FsProbe]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return $false }
  if ($h -eq [FsProbe]::GetShellWindow()) { return $false }
  $cls = [FsProbe]::Cls($h)
  if (($cls -eq 'Progman') -or ($cls -eq 'WorkerW') -or ($cls -eq 'Shell_TrayWnd')) { return $false }
  $style = [FsProbe]::GetWindowLong($h, -16)
  if (($style -band 0x00C00000) -ne 0) { return $false }
  $r = [FsProbe+RECT]::new()
  if (-not [FsProbe]::GetWindowRect($h, [ref]$r)) { return $false }
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    if (($r.Left -le $b.Left) -and ($r.Top -le $b.Top) -and ($r.Right -ge $b.Right) -and ($r.Bottom -ge $b.Bottom)) { return $true }
  }
  return $false
}

function Sample-Pixel($sx, $sy) {
  $bmp = New-Object System.Drawing.Bitmap 1,1
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($sx, $sy, 0, 0, (New-Object System.Drawing.Size 1,1))
  $c = $bmp.GetPixel(0,0)
  $g.Dispose(); $bmp.Dispose()
  return $c
}

function Test-Black($c) {
  if (($c.R -lt 12) -and ($c.G -lt 12) -and ($c.B -lt 12)) { return $true }
  return $false
}

function Test-Diff($c1, $c2) {
  $d = [Math]::Abs($c1.R-$c2.R) + [Math]::Abs($c1.G-$c2.G) + [Math]::Abs($c1.B-$c2.B)
  if ($d -gt 70) { return $true }
  return $false
}

$fsLast = -1
$hits = 0
while ($true) {
  Start-Sleep -Milliseconds 2500
  try {
    if (-not (Get-Process -Id $pp -ErrorAction SilentlyContinue)) { exit }
  } catch { exit }

  $fs = 0
  try { if (Test-FullScreen) { $fs = 1 } } catch {}
  if ($fs -ne $fsLast) { Write-Output ('FS ' + $fs); $fsLast = $fs }
  if ($fs -eq 1) { $hits = 0; continue }

  $raw = ''
  try { $raw = (Get-Content -Raw -ErrorAction SilentlyContinue $bf) } catch {}
  if (-not $raw) { continue }
  $raw = $raw.Trim()
  if ($raw -eq 'hidden' -or $raw -eq '') { continue }
  $p = $raw -split ' '
  if ($p.Count -lt 4) { continue }
  $x = [int]$p[0]; $y = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3]
  $lx = $x + 6; $rx = $x + $w - 7; $cy = $y + 3
  try {
    $l1 = Sample-Pixel $lx $cy
    $l2 = Sample-Pixel $lx ($y - 12)
    $r1 = Sample-Pixel $rx $cy
    $r2 = Sample-Pixel $rx ($y - 12)
    $bad = (Test-Black $l1) -and (Test-Black $r1) -and (Test-Diff $l1 $l2) -and (Test-Diff $r1 $r2)
    if ($bad) {
      $hits++
      if ($hits -ge 2) {
        Write-Output ('BROKEN hit=' + $hits)
        $hits = 0
      }
    } else {
      $hits = 0
    }
  } catch {}
}
`

function surfaceBoundsFile() {
  return path.join(app.getPath('appData'), 'dockpad', 'surface-bounds.txt')
}

// 把 Dock 窗口的物理像素坐标写给探针；全屏应用在前台、网格面板开着或 Dock 隐藏时暂停检测
function writeSurfaceBounds() {
  try {
    if (surfaceFullScreen
      || !dockWin || dockWin.isDestroyed() || !dockWin.isVisible()
      || (gridWin && !gridWin.isDestroyed() && gridWin.isVisible())) {
      fs.writeFileSync(surfaceBoundsFile(), 'hidden')
      return
    }
    const b = dockWin.getBounds()
    const sf = screen.getDisplayMatching(b).scaleFactor || 1
    fs.writeFileSync(
      surfaceBoundsFile(),
      [Math.round(b.x * sf), Math.round(b.y * sf), Math.round(b.width * sf), Math.round(b.height * sf)].join(' ')
    )
  } catch (e) {
    /* ignore */
  }
}

function healWindowSurface(win) {
  if (!win || win.isDestroyed()) return
  try {
    const b = win.getBounds()
    win.setBounds({ x: b.x, y: b.y, width: b.width + 1, height: b.height + 1 })
    win.setBounds(b)
  } catch (e) {
    /* ignore */
  }
  try { win.setBackgroundColor('#00000000') } catch (e) { /* ignore */ }
  try { win.webContents.invalidate() } catch (e) { /* ignore */ }
}

// 全屏应用在前台时不碰任何窗口（改了就会从游戏画面上冒出来）；force 只给托盘手动修复用
function healAllSurfaces(force) {
  if (surfaceFullScreen && !force) return
  healWindowSurface(dockWin)
  healWindowSurface(gridWin)
  healWindowSurface(previewWin)
}

function onSurfaceBroken() {
  if (surfaceFullScreen) {
    logBoot('surface-broken skipped (fullscreen)')
    return
  }
  const now = Date.now()
  if (now - surfHealState.lastAt < 3000) return
  surfHealState.lastAt = now
  surfHealState.fails++
  logBoot('surface-broken fails=' + surfHealState.fails)
  healAllSurfaces()
  // 60 秒内没有新报就当作修好了：fails 变成「连续失败」而不是累计误报
  if (surfSettleTimer) clearTimeout(surfSettleTimer)
  surfSettleTimer = setTimeout(() => {
    surfHealState.fails = 0
    surfSettleTimer = null
  }, 60000)
  // 连续 3 次修复无效才重启兜底，5 分钟内最多一次
  if (surfHealState.fails >= 3 && now - surfHealState.relaunchedAt > 5 * 60 * 1000) {
    surfHealState.relaunchedAt = now
    surfHealState.fails = 0
    logBoot('relaunch-due-to-broken-surface')
    app.relaunch()
    try { app.quit() } catch (e) { /* ignore */ }
    setTimeout(() => {
      try { app.exit(0) } catch (e) { /* ignore */ }
    }, 1500)
  }
}

// 宿主环境里可能混着大小写不同的重复变量（PATH/Path、HTTP_PROXY/http_proxy），
// PowerShell/.NET 子进程按不区分大小写建字典会直接崩（"已添加了具有相同键的项"）。
// 给子进程发一份去重后的环境。
function cleanChildEnv() {
  const out = {}
  const seen = new Set()
  for (const k of Object.keys(process.env)) {
    const lk = k.toLowerCase()
    if (seen.has(lk)) continue
    seen.add(lk)
    out[k] = process.env[k]
  }
  return out
}

function startSurfaceWatchdog() {
  if (surfWatchProc) return
  try {
    const dir = path.join(app.getPath('appData'), 'dockpad')
    fs.mkdirSync(dir, { recursive: true })
    const ps1 = path.join(dir, 'surface-watch.ps1')
    fs.writeFileSync(
      ps1,
      SURF_PS1.replace('__BOUNDSFILE__', surfaceBoundsFile()).replace('__PARENTPID__', String(process.pid))
    )
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    surfWatchProc = spawn(
      psExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: cleanChildEnv() }
    )
    let buf = ''
    surfWatchProc.stdout.on('data', (d) => {
      buf += String(d)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line.indexOf('BROKEN') === 0) {
          onSurfaceBroken()
        } else if (line.indexOf('FS ') === 0) {
          // 探针上报前台是否被全屏应用占着。全屏期间一个窗口动作都不能做，
          // 否则 Dock / 面板 / 重启都会从游戏画面上冒出来
          const v = line.slice(3).trim() === '1'
          if (v !== surfaceFullScreen) {
            surfaceFullScreen = v
            logBoot('fullscreen=' + (v ? 1 : 0))
            writeSurfaceBounds()
            if (!v) {
              // 退回桌面：游戏期间被打碎的表面在这里一次性补修
              setTimeout(() => { if (!surfaceFullScreen) healAllSurfaces() }, 900)
            }
          }
        }
      }
    })
    surfWatchProc.on('exit', () => {
      surfWatchProc = null
      // 探针没了就别再相信"全屏中"这个状态，免得退回桌面后永远不检测
      if (surfaceFullScreen) {
        surfaceFullScreen = false
        writeSurfaceBounds()
      }
      // 异常退出后 10 秒补一次，最多连续重试 3 次（防止死循环刷进程）
      if (surfRestartTries < 3) {
        surfRestartTries++
        setTimeout(() => { if (!surfWatchProc) startSurfaceWatchdog() }, 10000)
      }
    })
    // 稳定跑满 1 分钟才算这轮启动成功，重置重试计数
    setTimeout(() => { if (surfWatchProc) surfRestartTries = 0 }, 60000)
  } catch (e) {
    surfWatchProc = null
  }
  // 拖动 / 自动隐藏 / 分辨率变化都会改变窗口矩形，低频同步给探针（只建一个定时器）
  if (!surfaceBoundsTimer) {
    surfaceBoundsTimer = setInterval(writeSurfaceBounds, 800)
  }
  writeSurfaceBounds()
}

app.on('before-quit', (e) => {
  logBoot('before-quit')
  if (tray) tray.destroy()
  try {
    globalShortcut.unregisterAll()
  } catch (e) {
    /* ignore */
  }
  if (autoHideTimer) clearInterval(autoHideTimer)
  if (surfWatchProc) {
    try { surfWatchProc.kill() } catch (e) { /* ignore */ }
  }
})
