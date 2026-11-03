const { app, shell, desktopCapturer, nativeImage } = require('electron')
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const library = require('./library')

// 应用清单由 library.js 自己维护（%APPDATA%\dockpad\library.json）。
// 桌面上的「常用」文件夹只在首次迁移时当数据源，之后不再扫描、也不再往里移动文件。
const LEGACY_DIR = library.LEGACY_DIR
const ROOT_GROUP = library.ROOT_GROUP

// Dock 上固定显示的应用（按原始文件名匹配，不受重命名影响）
const PINNED = [
  { label: 'QQ', test: (n) => /^qq$/i.test(n) },
  { label: '微信', test: (n) => /微信|wechat/i.test(n) },
  {
    label: 'Edge',
    test: (n) => /edge/i.test(n),
    fallback: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  },
  { label: 'WeGame', test: (n) => /wegame/i.test(n) },
]

let cache = null
let disk = null
let diskDirty = false
let customIcons = null

// 清单失效：连版本号一起加，正在跑的那次构建结束时就不会把旧结果写回 cache
function invalidateCache() {
  buildGen++
  cache = null
}

function cacheFile() {
  return path.join(app.getPath('userData'), 'icon-cache.json')
}

function customIconsFile() {
  return path.join(app.getPath('userData'), 'custom-icons.json')
}

function dockOrderFile() {
  return path.join(app.getPath('userData'), 'dock-order.json')
}

function dockItemsFile() {
  return path.join(app.getPath('userData'), 'dock-items.json')
}

let dockOrder = null
let dockItems = null
let dockItemsLoaded = false

function loadDockItems() {
  if (dockItemsLoaded) return dockItems
  dockItemsLoaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(dockItemsFile(), 'utf8'))
    dockItems = Array.isArray(raw) ? raw : null
  } catch (e) {
    dockItems = null
  }
  return dockItems
}

function saveDockItems(paths) {
  dockItems = Array.isArray(paths) ? paths.slice() : null
  dockItemsLoaded = true
  try {
    if (dockItems) {
      fs.mkdirSync(path.dirname(dockItemsFile()), { recursive: true })
      fs.writeFileSync(dockItemsFile(), JSON.stringify(dockItems, null, 2))
    } else {
      fs.unlinkSync(dockItemsFile())
    }
  } catch (e) {
    /* ignore */
  }
  invalidateCache()
  return true
}

function loadDockOrder() {
  if (dockOrder) return dockOrder
  try {
    dockOrder = JSON.parse(fs.readFileSync(dockOrderFile(), 'utf8'))
    if (!Array.isArray(dockOrder)) dockOrder = []
  } catch (e) {
    dockOrder = []
  }
  return dockOrder
}

function saveDockOrder(paths) {
  dockOrder = Array.isArray(paths) ? paths.slice() : []
  try {
    fs.mkdirSync(path.dirname(dockOrderFile()), { recursive: true })
    fs.writeFileSync(dockOrderFile(), JSON.stringify(dockOrder, null, 2))
  } catch (e) {
    /* ignore */
  }
  invalidateCache()
  return true
}

function loadCustomIcons() {
  if (customIcons) return customIcons
  try {
    customIcons = JSON.parse(fs.readFileSync(customIconsFile(), 'utf8'))
    if (!customIcons || typeof customIcons !== 'object') customIcons = {}
  } catch (e) {
    customIcons = {}
  }
  return customIcons
}

function persistCustomIcons() {
  try {
    fs.mkdirSync(path.dirname(customIconsFile()), { recursive: true })
    fs.writeFileSync(customIconsFile(), JSON.stringify(customIcons))
  } catch (e) {
    /* ignore */
  }
}

function loadDisk() {
  if (disk) return disk
  try {
    disk = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (!disk || typeof disk !== 'object') disk = {}
  } catch (e) {
    disk = {}
  }
  return disk
}

function flushDisk() {
  if (!diskDirty || !disk) return
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify(disk))
    diskDirty = false
  } catch (e) {
    /* ignore */
  }
}

const IMAGE_EXTS = ['.ico', '.png', '.jpg', '.jpeg', '.webp', '.bmp']

// 图标提取逻辑变更时递增，让旧缓存自动失效
// v4：改为多来源分级提取（剥离 icon 字段的 ,索引 后缀，并试 target/同目录 ico）
// v5：图标统一缩到 192px，缓存体积和内存里的字符串都小一截
const ICON_CACHE_VERSION = 5

// 面板最大图标 96px，算上 150% 缩放 144px，192 够用且不会糊
const ICON_EDGE = 192

// 统一缩放：图标不用留 256px 的原图，每个字符串都会在主进程和两个窗口里各存一份
function shrinkIcon(img) {
  const s = img.getSize()
  const edge = Math.max(s.width, s.height)
  if (!edge) return ''
  if (edge <= ICON_EDGE) return img.toDataURL()
  const k = ICON_EDGE / edge
  return img
    .resize({ width: Math.round(s.width * k), height: Math.round(s.height * k), quality: 'best' })
    .toDataURL()
}

// 预提取的图标兜底表（由 extract_icons.py 从 exe 资源里直接抠出来的，
// 用来补 Electron getFileIcon 取不到的那批）
let fallbackIcons = null

function loadFallback() {
  if (fallbackIcons) return fallbackIcons
  try {
    fallbackIcons = JSON.parse(fs.readFileSync(path.join(__dirname, 'icon-fallback.json'), 'utf8'))
    if (!fallbackIcons || typeof fallbackIcons !== 'object') fallbackIcons = {}
  } catch (e) {
    fallbackIcons = {}
  }
  return fallbackIcons
}

// 直接读图片文件内容。注意不能用 getFileIcon：它对 .ico 返回的是「ico 文件类型」图标，
// 不是图标本身
function iconFromImageFile(filePath) {
  try {
    const img = nativeImage.createFromPath(filePath)
    if (img && !img.isEmpty()) return shrinkIcon(img)
  } catch (e) {
    /* ignore */
  }
  return ''
}

// .url 是 INI 文本，图标写在 IconFile 字段里；不解析的话只会拿到系统默认的地球图标
function iconPathFromUrlFile(urlPath) {
  try {
    const txt = fs.readFileSync(urlPath, 'utf8')
    const m = txt.match(/^\s*IconFile\s*=\s*(.+)$/im)
    if (m) {
      const p = m[1].trim().replace(/^"|"$/g, '')
      if (p && fs.existsSync(p)) return p
    }
  } catch (e) {
    /* ignore */
  }
  return ''
}

async function iconFor(target) {
  const ext = path.extname(target).toLowerCase()
  if (IMAGE_EXTS.includes(ext)) {
    const direct = iconFromImageFile(target)
    if (direct) return direct
  }
  try {
    const img = await app.getFileIcon(target, { size: 'large' })
    if (img && !img.isEmpty()) return shrinkIcon(img)
  } catch (e) {
    /* ignore */
  }
  return ''
}

// 有限并发，避免一次性拉起上百个图标请求
async function mapLimit(items, limit, fn) {
  const result = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      result[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return result
}

// 快捷方式的 icon 字段常写成 "C:\Windows\system32\shell32.dll,3"，
// 逗号后面是资源序号。拿来当路径用会 existsSync 失败，所以先剥掉。
function stripIconIndex(p) {
  return String(p || '')
    .replace(/,\s*-?\d+\s*$/, '')
    .replace(/^"|"$/g, '')
    .trim()
}

// 一个快捷方式能取图标的来源不止一个。只试一种的话，很多应用会落到系统通用图标上：
// icon 字段 → target exe → target 同目录同名 .ico / icon.ico → 工作目录 icon.ico → 快捷方式自身
async function iconSourcesFor(filePath) {
  const out = []
  let deferred = '' // 带序号索引的 dll 图标取不到指定序号，放到最后再试
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.lnk') {
    let d = null
    try {
      d = shell.readShortcutLink(filePath)
    } catch (e) {
      /* 解析失败就只用快捷方式自身 */
    }
    if (d) {
      const iconPath = stripIconIndex(d.icon)
      if (iconPath) {
        const isResourceLib = /\.(dll|icl|ocx)$/i.test(iconPath)
        if (isResourceLib && typeof d.iconIndex === 'number' && d.iconIndex > 0) {
          deferred = iconPath
        } else {
          out.push(iconPath)
        }
      }
      if (d.target) {
        out.push(d.target)
        // 绿色软件常把图标单独放一份 ico 在 exe 旁边
        const dir = path.dirname(d.target)
        const base = path.basename(d.target, path.extname(d.target))
        out.push(path.join(dir, base + '.ico'))
        out.push(path.join(dir, 'icon.ico'))
      }
      if (d.cwd) out.push(path.join(d.cwd, 'icon.ico'))
    }
  } else if (ext === '.url') {
    const ico = iconPathFromUrlFile(filePath)
    if (ico) out.push(ico)
  }

  out.push(filePath)
  if (deferred) out.push(deferred)

  return out.filter((p, i, arr) => p && arr.indexOf(p) === i)
}

// 分级取图标：先查预提取表（最可靠），再直接读图片，最后交给系统。
// 每个来源都过一遍，第一个取到就用。
async function extractIcon(filePath) {
  const sources = await iconSourcesFor(filePath)
  const fb = loadFallback()

  for (const src of sources) {
    if (!fs.existsSync(src)) continue
    const hit = fb[String(src).toLowerCase()]
    if (hit) return hit
  }

  for (const src of sources) {
    if (!fs.existsSync(src)) continue
    const icon = await iconFor(src)
    if (icon) return icon
  }

  return ''
}

// 并发保护：Dock 和面板启动时会同时来要清单，没这层的话会各自跑一遍提取，
// 后完成的那次还会把内存里的 disk 重新读一遍
let building = null
let buildGen = 0

function buildApps() {
  if (cache) return Promise.resolve(cache)
  if (!building) {
    building = doBuildApps().finally(() => {
      building = null
    })
  }
  return building
}

async function doBuildApps() {
  const myGen = buildGen
  const items = library.getApps()
  const store = loadDisk()
  const custom = loadCustomIcons()

  const apps = await mapLimit(items, 10, async (item) => {
    let mtime = 0
    let exists = false
    try {
      mtime = fs.statSync(item.path).mtimeMs
      exists = true
    } catch (e) {
      /* 文件被删了：图标留空，前端标灰，但不从库里自动清掉 */
    }

    // 缓存 key 带 mtime，快捷方式被重建时能自愈
    const key = ICON_CACHE_VERSION + '|' + item.path + '|' + mtime
    let icon = exists ? store[key] : ''

    if (exists && !icon) {
      icon = await extractIcon(item.path)
      if (icon) {
        store[key] = icon
        diskDirty = true
      }
    }

    return {
      name: item.name,
      origName: item.origName,
      path: item.path,
      icon: custom[item.path] || icon || '',
      group: item.group,
      missing: !exists,
      lastUsed: item.lastUsed || 0,
    }
  })

  flushDisk()
  pruneDisk()
  if (myGen === buildGen) cache = apps
  return apps
}

// 缓存文件里会攒下旧版本、还有已经从库里删掉的应用的图标，几百条 base64 全在主进程
// 内存里放着。每次重建完就清掉非当前版本的 key，再把 disk 放掉，下次要用时按需重读。
function pruneDisk() {
  if (!disk) return
  const prefix = ICON_CACHE_VERSION + '|'
  let removed = 0
  for (const k of Object.keys(disk)) {
    if (!k.startsWith(prefix)) {
      delete disk[k]
      removed++
    }
  }
  if (removed) {
    diskDirty = true
    flushDisk()
  }
  disk = null
  diskDirty = false
}

// Dock 固定项：优先在「常用」里按原始名找，找不到就用 fallback 的 exe 路径
async function buildPinned() {
  const all = await buildApps()
  const custom = loadDockItems()
  const result = []

  if (custom) {
    // 用户自定义的 Dock 列表
    for (const p of custom) {
      const hit = all.find((a) => a.path === p)
      if (hit) {
        result.push({ name: hit.name, path: hit.path, icon: hit.icon, proc: exeOf(hit.path) })
      } else if (fs.existsSync(p)) {
        // 不在「常用」目录里的外部程序（例如 Edge）
        const fb = loadFallback()
        let icon = fb[String(p).toLowerCase()] || ''
        if (!icon) icon = await iconFor(p)
        result.push({ name: path.basename(p, path.extname(p)), path: p, icon, proc: exeOf(p) })
      }
    }
  } else {
    // 默认列表
    for (const cfg of PINNED) {
      const hit = all.find((a) => cfg.test(a.origName))
      if (hit) {
        result.push({ name: hit.name, path: hit.path, icon: hit.icon, proc: exeOf(hit.path) })
      } else if (cfg.fallback) {
        result.push({
          name: cfg.label,
          path: cfg.fallback,
          icon: await iconFor(cfg.fallback),
          proc: exeOf(cfg.fallback),
        })
      }
    }
  }

  // Dock 自定义排序
  const order = loadDockOrder()
  if (order.length) {
    result.sort((a, b) => {
      const ia = order.indexOf(a.path)
      const ib = order.indexOf(b.path)
      if (ia === -1 && ib === -1) return 0
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    })
  }
  return result
}

// 当前 Dock 的路径列表（前端用来判断某个应用是否已固定）
async function getDockPaths() {
  const list = await buildPinned()
  return list.map((x) => x.path)
}

// 固定到 Dock
async function addToDock(appPath) {
  if (!appPath) return { ok: false }
  const current = loadDockItems()
  let list
  if (current) {
    list = current.slice()
  } else {
    const def = await buildPinned()
    list = def.map((x) => x.path)
  }
  if (!list.includes(appPath)) list.push(appPath)
  saveDockItems(list)
  return { ok: true, paths: list }
}

// 从 Dock 移除
async function removeFromDock(appPath) {
  if (!appPath) return { ok: false }
  const current = loadDockItems()
  let list
  if (current) {
    list = current.slice()
  } else {
    const def = await buildPinned()
    list = def.map((x) => x.path)
  }
  list = list.filter((p) => p !== appPath)
  saveDockItems(list)
  return { ok: true, paths: list }
}

async function renameApp(targetPath, newName) {
  const res = library.rename(targetPath, newName)
  invalidateCache()
  return res.ok
}

// 保存排序：传入按新顺序排列的路径数组。
// 允许只传当前可见的一部分（例如只重排某个分类），其余应用保持原有相对顺序追加在后。
function saveOrder(paths) {
  library.setOrder(paths)
  invalidateCache()
  return true
}

// 自定义图标：传入 dataURL，传空则恢复默认
function setCustomIcon(appPath, dataUrl) {
  const map = loadCustomIcons()
  if (dataUrl) map[appPath] = dataUrl
  else delete map[appPath]
  persistCustomIcons()
  invalidateCache()
  return true
}

// 新建分类：只写进库里的 groups 列表，不再建文件夹
function createGroup(name) {
  const res = library.createGroup(name)
  if (res.ok) invalidateCache()
  return res
}

// 把应用移到指定分类：改的是库里的 group 字段，.lnk 文件原地不动
function moveToGroup(appPath, group) {
  const res = library.setGroup(appPath, group)
  if (res.ok) invalidateCache()
  return res
}

// 分类列表来自库，空分类也会显示
function listGroups() {
  return library.getGroups()
}

// 分类锁 / 密码 / 改名的实现都在 library.js，这里只做转发
function getLockedGroups() {
  return library.getLockedGroups()
}

function setGroupLocked(group, locked) {
  return library.setGroupLocked(group, locked)
}

function renameGroup(oldName, newName) {
  const res = library.renameGroup(oldName, newName)
  if (res.ok) invalidateCache()
  return res
}

function removeGroup(name) {
  const res = library.removeGroup(name)
  if (res.ok) invalidateCache()
  return res
}

function setGroupPassword(group, plain) {
  return library.setGroupPassword(group, plain)
}

function getPasswordGroups() {
  return library.getPasswordGroups()
}

function verifyGroupPassword(group, plain) {
  return library.verifyGroupPassword(group, plain)
}

// 悬停预览：按进程名匹配窗口，用 desktopCapturer 抓缩略图
const thumbCache = new Map()
const THUMB_TTL = 1500

function exeOf(shortcutPath) {
  let target = shortcutPath
  if (path.extname(shortcutPath).toLowerCase() === '.lnk') {
    try {
      const d = shell.readShortcutLink(shortcutPath)
      // WeGame 这类通过 schtasks 提权的，target 是 schtasks.exe，真实程序在 icon 字段
      if (d && d.icon) target = d.icon
      else if (d && d.target) target = d.target
    } catch (e) {
      /* ignore */
    }
  }
  return path.basename(target, path.extname(target)).toLowerCase()
}

const procCache = { list: null, ts: 0, inflight: null }

// 兜底：tasklist 拿全部进程名。desktopCapturer 在已经跑着的应用里偶尔会返回空
// （Windows 图形捕获初始化失败，日志里是 wgc_capturer_win.cc 报错），不能只靠它。
function listProcsByTasklist() {
  // 2 秒内的重复请求直接复用上一次结果：Dock 的轮询比 tasklist 启动还快，
  // 不缓存的话每次都要拉一个进程起来
  const now = Date.now()
  if (procCache.list && now - procCache.ts < 2000) return Promise.resolve(procCache.list)
  if (procCache.inflight) return procCache.inflight

  const job = new Promise((resolve) => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      procCache.inflight = null
      if (err) return resolve(procCache.list || [])
      const set = new Set()
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/)
        if (m) set.add(m[1].replace(/\.exe$/i, '').toLowerCase())
      }
      const list = [...set]
      procCache.list = list
      procCache.ts = Date.now()
      resolve(list)
    })
  })
  procCache.inflight = job
  return job
}

// 这台机器上 WGC 抓窗口是坏的：每次调用都会在 wgc_capturer_win.cc 报
// -2147024809，而且 Promise 既不 resolve 也不 reject，一次挂住就漏十几 MB。
// 所以只允许试探一次，失败（或 2.5 秒没回音）就整个会话不再碰它。
// 结论按系统版本存文件：同一台机器重启后也不用再交一次学费。
const CAPTURE_TIMEOUT = 2500
let captureDead = false
let captureBlocked = null
let captureProbing = null

function captureMarkerFile() {
  return path.join(app.getPath('userData'), 'capture-broken.json')
}

function isCaptureBlocked() {
  if (captureBlocked !== null) return captureBlocked
  try {
    const d = JSON.parse(fs.readFileSync(captureMarkerFile(), 'utf8'))
    // 换了系统大版本再给一次机会，避免旧结论一直卡着
    captureBlocked = !!d && d.build === os.release()
  } catch (e) {
    captureBlocked = false
  }
  return captureBlocked
}

function markCaptureBlocked() {
  captureDead = true
  captureBlocked = true
  try {
    fs.mkdirSync(path.dirname(captureMarkerFile()), { recursive: true })
    fs.writeFileSync(captureMarkerFile(), JSON.stringify({ build: os.release(), at: Date.now() }))
  } catch (e) {
    /* ignore */
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(null)
    }, ms)
    Promise.resolve(promise).then(
      (v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

async function captureSources(thumbSize) {
  if (captureDead || isCaptureBlocked()) return null
  if (captureProbing) return captureProbing

  captureProbing = withTimeout(
    desktopCapturer.getSources({ types: ['window'], thumbnailSize: thumbSize, fetchWindowIcons: false }),
    CAPTURE_TIMEOUT
  )
    .then((sources) => {
      if (!sources || !sources.length) {
        markCaptureBlocked()
        return null
      }
      return sources
    })
    .finally(() => {
      captureProbing = null
    })

  return captureProbing
}

// 当前有哪些进程名。Dock 上用它判断「这个应用是不是正开着」，也用来在点击时切回已有窗口。
// 这里只认 tasklist：desktopCapturer 能给「有可见窗口的进程」，但在这台机器上它是坏的，
// 挂住一次就漏内存，不值得为这点精度每 4 秒冒一次风险。
async function listRunningProcs() {
  return listProcsByTasklist()
}

// 缩略图缓存设上限，避免开过的应用越多、字符串越攒越多
const THUMB_LIMIT = 10

async function windowThumbFor(appPath) {
  const proc = exeOf(appPath)
  if (!proc) return ''

  const now = Date.now()
  const hit = thumbCache.get(proc)
  if (hit && now - hit.ts < THUMB_TTL) return hit.dataUrl

  const remember = (dataUrl) => {
    thumbCache.delete(proc)
    thumbCache.set(proc, { dataUrl, ts: now })
    while (thumbCache.size > THUMB_LIMIT) {
      thumbCache.delete(thumbCache.keys().next().value)
    }
    return dataUrl
  }

  const sources = await captureSources({ width: 420, height: 260 })
  if (sources) {
    // 一个能用的缩略图都没有，说明这台机器的窗口捕获其实是坏的，
    // 别再每悬停一次就付一次十几 MB 的代价
    let usable = 0
    for (const s of sources) {
      const owner = String((s.owner && s.owner.name) || '').toLowerCase()
      if (!owner) continue
      if (!s.thumbnail || s.thumbnail.isEmpty()) continue
      usable++
      if (owner === proc || owner.includes(proc) || proc.includes(owner)) {
        return remember(s.thumbnail.toDataURL())
      }
    }
    if (!usable) markCaptureBlocked()
  }
  return remember('')
}

// 库操作：添加 / 移除 / 重新导入，前端设置界面用
function addApp(filePath, group) {
  const res = library.addApp(filePath, group)
  if (res.ok) invalidateCache()
  return res
}

function removeApp(appPath) {
  const res = library.removeApp(appPath)
  if (res.ok) invalidateCache()
  return res
}

// 记一次使用时间。直接改缓存里的对应项，避免为了一个时间戳重建整个图标列表。
function touchApp(appPath) {
  const ok = library.touchApp(appPath)
  if (ok && cache) {
    const hit = cache.find((a) => a.path === appPath)
    if (hit) hit.lastUsed = Date.now()
  }
  return ok
}

// 改目标路径。自定义图标是按路径存 key 的，路径变了图标要跟着搬，否则又变空白。
function updateAppPath(appPath, newPath) {
  const res = library.updateAppPath(appPath, newPath)
  if (res.ok) {
    const icons = loadCustomIcons()
    if (icons[appPath]) {
      icons[newPath] = icons[appPath]
      delete icons[appPath]
      persistCustomIcons()
    }
    invalidateCache()
  }
  return res
}

function importFolder(dir) {
  const res = library.importFolder(dir)
  if (res.ok && res.added) invalidateCache()
  return res
}

// 拖放导入：文件夹 → 建同名分类整批导入；快捷方式 → 直接加进库（未分类）
function importDropped(paths) {
  const list = Array.isArray(paths) ? paths : []
  const result = { added: 0, folders: [], files: 0, skipped: 0, errors: [] }

  for (const p of list) {
    let st = null
    try {
      st = fs.statSync(p)
    } catch (e) {
      result.errors.push(path.basename(p || '') + ' 找不到')
      continue
    }

    if (st.isDirectory()) {
      const r = library.addFolderAsGroup(p)
      if (r.ok) {
        result.folders.push({ name: r.group, added: r.added, isNew: r.isNewGroup, skipped: r.skipped })
        result.added += r.added
        result.skipped += r.skipped
      } else {
        result.errors.push(r.error || '文件夹导入失败')
      }
      continue
    }

    const ext = path.extname(p).toLowerCase()
    if (ext !== '.lnk' && ext !== '.url') {
      result.errors.push(path.basename(p) + ' 不是快捷方式')
      continue
    }
    const r = library.addApp(p)
    if (r.ok) {
      result.added++
      result.files++
    } else {
      result.skipped++
      result.errors.push(r.error || path.basename(p) + ' 添加失败')
    }
  }

  if (result.added) invalidateCache()
  return result
}

// 一键扫描：把一个文件夹里像主程序的 exe 全加进库（自动跳过卸载/更新/崩溃上报这类）
// 只扫描不落库：列出这个文件夹里会被加进来的主程序，交给界面勾选
async function planAppsFromFolder(dir) {
  const target = String(dir || '').trim()
  if (!target) return { ok: false, error: '路径为空', picked: [] }
  let st = null
  try {
    st = await fs.promises.stat(target)
  } catch (e) {
    return { ok: false, error: '文件夹不存在', picked: [] }
  }
  if (!st.isDirectory()) return { ok: false, error: '不是一个文件夹', picked: [] }

  const all = []
  await library.walkForExe(target, target, all, 0)

  const groups = new Map()
  for (const e of all) {
    const rel = path.relative(target, e.path)
    const parts = rel.split(path.sep)
    const key = parts.length > 1 ? parts[0] : '__root__'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }

  const picked = []
  if (groups.has('__root__')) {
    // 根目录自己就有 exe，说明用户选的就是某个程序的安装目录 —— 只要这一个，
    // 别把 data\ / resources\ 里的组件也一起加进来
    const one = library.pickMain(groups.get('__root__'), path.basename(target))
    if (one) picked.push(one)
  } else {
    for (const [key, arr] of groups) {
      const one = library.pickMain(arr, key === '__root__' ? path.basename(target) : key)
      if (one) picked.push(one)
    }
  }
  return { ok: true, picked, scanned: all.length }
}

// 把勾选的主程序加进库（去重逻辑和整包扫描一致）
function addPickedApps(list) {
  const arr = Array.isArray(list) ? list : []
  const lib2 = library.getLibrary()
  const seenPath = new Set(lib2.apps.map((a) => a.path.toLowerCase()))
  const seenName = new Set(lib2.apps.map((a) => a.origName.toLowerCase()))
  let added = 0
  let duplicate = 0

  for (const e of arr) {
    if (!e || !e.path) continue
    if (seenPath.has(e.path.toLowerCase()) || seenName.has((e.name || '').toLowerCase())) {
      duplicate++
      continue
    }
    lib2.apps.push({
      path: e.path,
      origName: e.name,
      name: e.name,
      group: library.ROOT_GROUP,
      order: lib2.apps.length,
    })
    seenPath.add(e.path.toLowerCase())
    seenName.add(e.name.toLowerCase())
    added++
  }

  if (added) library.persistLibrary()
  return { ok: true, added, duplicate }
}

async function scanAppsFolder(dir) {
  const plan = await planAppsFromFolder(dir)
  if (!plan.ok) return plan
  const res = addPickedApps(plan.picked)
  if (res.added) invalidateCache()
  return { ok: true, scanned: plan.scanned, added: res.added, duplicate: res.duplicate }
}

function getLibraryInfo() {
  const lib = library.getLibrary()
  return {
    apps: lib.apps.length,
    groups: lib.groups.slice(),
    file: library.libraryFile(),
    legacyDir: LEGACY_DIR,
  }
}

function invalidate() {
  buildGen++
  cache = null
  disk = null
  diskDirty = false
  library.invalidateLibrary()
  try {
    fs.unlinkSync(cacheFile())
  } catch (e) {
    /* ignore */
  }
}

module.exports = {
  buildApps,
  buildPinned,
  renameApp,
  updateAppPath,
  touchApp,
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
  importFolder,
  importDropped,
  scanAppsFolder,
  planAppsFromFolder,
  addPickedApps,
  planImportFolder: library.planImportFolder,
  importPicked: library.importPicked,
  planFolderAsGroup: library.planFolderAsGroup,
  addFolderAsGroup: library.addFolderAsGroup,
  planAppsFromFolder,
  addPickedApps,
  getLibraryInfo,
  invalidate,
  LEGACY_DIR,
  PINNED,
  ROOT_GROUP,
}
