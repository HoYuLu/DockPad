// 应用库：DockPad 自己维护的应用清单，不再和桌面上的「常用」文件夹绑定。
// 首次启动时从那个文件夹迁移一次（连同旧的重命名/排序一起），之后只在库内增删改，
// 拖拽分类改的是库里的 group 字段，不会再去移动 .lnk 文件。
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

// 仅用于首次迁移的旧目录，迁移完成后不再读取（桌面下没有这个文件夹就跳过）
let LEGACY_DIR = ''
try {
  LEGACY_DIR = path.join(app.getPath('desktop'), '常用')
} catch (e) {
  LEGACY_DIR = ''
}
const ROOT_GROUP = '未分类'
const EXTS = ['.lnk', '.url']
const GROUP_ORDER = ['yoss', '免UAC', '娱乐', '工具']
const SCAN_DEPTH = 6

let lib = null

function userFile(name) {
  return path.join(app.getPath('userData'), name)
}

function libraryFile() {
  return userFile('library.json')
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : v
  } catch (e) {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    return true
  } catch (e) {
    return false
  }
}

function baseName(p) {
  return path.basename(p, path.extname(p)).trim()
}

function scanDir(dir, baseDir, out, depth) {
  if (depth > SCAN_DEPTH) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const ent of entries) {
    if (ent.name === 'desktop.ini' || ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      scanDir(full, baseDir, out, depth + 1)
    } else if (EXTS.includes(path.extname(ent.name).toLowerCase())) {
      const rel = path.relative(baseDir, dir)
      const group = rel ? rel.split(path.sep)[0] : ROOT_GROUP
      out.push({ path: full, group })
    }
  }
  return out
}

function sortGroups(list) {
  return list.slice().sort((x, y) => {
    const ix = GROUP_ORDER.indexOf(x)
    const iy = GROUP_ORDER.indexOf(y)
    if (ix !== -1 && iy !== -1) return ix - iy
    if (ix !== -1) return -1
    if (iy !== -1) return 1
    return String(x).localeCompare(String(y), 'zh-CN')
  })
}

// 老版本的定制分散在 renames.json / order.json 里，迁移时一并折进库里，不丢用户改动
function migrateFromLegacy() {
  const renames = readJson(userFile('renames.json'), {}) || {}
  const order = readJson(userFile('order.json'), {}) || {}
  const groups = []
  const apps = []
  const seen = new Set()

  const files = fs.existsSync(LEGACY_DIR) ? scanDir(LEGACY_DIR, LEGACY_DIR, [], 0) : []
  for (const f of files) {
    const orig = baseName(f.path)
    if (!orig) continue
    const key = orig.toLowerCase()
    if (seen.has(key)) continue // 和旧版一致：同名应用只保留第一个
    seen.add(key)
    if (f.group && f.group !== ROOT_GROUP && !groups.includes(f.group)) groups.push(f.group)
    apps.push({
      path: f.path,
      origName: orig,
      name: String(renames[f.path] || orig).trim() || orig,
      group: f.group || ROOT_GROUP,
      order: typeof order[f.path] === 'number' ? order[f.path] : null,
    })
  }

  // 空文件夹也算分类：只在这一刻读一次目录名，之后分类全部走库
  try {
    const dirs = fs
      .readdirSync(LEGACY_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
    for (const d of dirs) {
      if (d && !groups.includes(d)) groups.push(d)
    }
  } catch (e) {
    /* 目录不存在就算了 */
  }

  // 有 order 的按 order 在前，其余按名字排，统一补齐连续序号
  apps.sort((a, b) => {
    const oa = a.order
    const ob = b.order
    if (oa !== null && ob !== null) return oa - ob
    if (oa !== null) return -1
    if (ob !== null) return 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  apps.forEach((a, i) => {
    a.order = i
  })

  return { version: 1, groups: sortGroups(groups), apps, migratedFrom: LEGACY_DIR, migratedAt: Date.now() }
}

function normalize(raw) {
  const apps = (Array.isArray(raw.apps) ? raw.apps : [])
    .filter((a) => a && typeof a.path === 'string' && a.path)
    .map((a) => {
      const orig = baseName(a.path) || a.path
      return {
        path: a.path,
        origName: String(a.origName || orig),
        name: String(a.name || orig).trim() || orig,
        group: a.group || ROOT_GROUP,
        order: typeof a.order === 'number' ? a.order : 0,
      }
    })
  apps.sort((a, b) => a.order - b.order)
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((g) => typeof g === 'string' && g) : []
  // 库里有但 groups 没登记的，补进去
  for (const a of apps) {
    if (a.group && a.group !== ROOT_GROUP && !groups.includes(a.group)) groups.push(a.group)
  }
  return { version: 1, groups: sortGroups(groups), apps }
}

function persist() {
  if (!lib) return false
  return writeJson(libraryFile(), lib)
}

function ensure() {
  if (lib) return lib
  const raw = readJson(libraryFile(), null)
  if (raw && Array.isArray(raw.apps)) {
    lib = normalize(raw)
  } else {
    lib = normalize(migrateFromLegacy())
    persist()
  }
  return lib
}

function getLibrary() {
  return ensure()
}

function getApps() {
  return ensure().apps.slice()
}

// 记录一次使用时间，「按最近使用排序」用它。写在库条目里，跟应用一起走。
function touchApp(appPath) {
  const lib2 = ensure()
  const a = lib2.apps.find((x) => x.path === appPath)
  if (!a) return false
  a.lastUsed = Date.now()
  persist()
  return true
}

function getGroups() {
  return sortGroups(ensure().groups)
}

function find(appPath) {
  return ensure().apps.find((a) => a.path === appPath) || null
}

function addApp(filePath, group) {
  const lib2 = ensure()
  const p = String(filePath || '').trim()
  if (!p) return { ok: false, error: '路径为空' }
  if (!fs.existsSync(p)) return { ok: false, error: '文件不存在' }
  if (!EXTS.includes(path.extname(p).toLowerCase())) return { ok: false, error: '只支持 .lnk / .url' }
  if (lib2.apps.some((a) => a.path.toLowerCase() === p.toLowerCase())) {
    return { ok: false, error: '已经在库里了' }
  }
  const orig = baseName(p)
  lib2.apps.push({
    path: p,
    origName: orig,
    name: orig,
    group: group && lib2.groups.includes(group) ? group : ROOT_GROUP,
    order: lib2.apps.length,
  })
  persist()
  return { ok: true }
}

function removeApp(appPath) {
  const lib2 = ensure()
  const before = lib2.apps.length
  lib2.apps = lib2.apps.filter((a) => a.path !== appPath)
  if (lib2.apps.length === before) return { ok: false, error: '库里没有这个应用' }
  lib2.apps.forEach((a, i) => {
    a.order = i
  })
  persist()
  return { ok: true }
}

// 改应用的目标路径：快捷方式失效后手动指到新位置。
// 新路径必须真实存在，且不能和库里其他条目重复。
function updateAppPath(appPath, newPath) {
  const lib2 = ensure()
  const target = String(newPath || '').trim()
  if (!target) return { ok: false, error: '路径不能为空' }
  if (!fs.existsSync(target)) return { ok: false, error: '新路径不存在：' + target }
  const a = lib2.apps.find((x) => x.path === appPath)
  if (!a) return { ok: false, error: '库里没有这个应用' }
  if (lib2.apps.some((x) => x.path === target && x !== a)) {
    return { ok: false, error: '库里已经有这个路径了' }
  }
  a.path = target
  persist()
  return { ok: true }
}

function rename(appPath, newName) {
  const a = find(appPath)
  if (!a) return { ok: false, error: '库里没有这个应用' }
  const trimmed = String(newName || '').trim()
  a.name = trimmed || a.origName
  persist()
  return { ok: true, name: a.name }
}

function setOrder(paths) {
  const lib2 = ensure()
  const list = Array.isArray(paths) ? paths : []
  const rank = new Map()
  list.forEach((p, i) => rank.set(p, i))
  // 只重排传入的这批，没传到的保持原有相对顺序跟在后头
  let next = list.length
  const rest = lib2.apps
    .filter((a) => !rank.has(a.path))
    .sort((a, b) => a.order - b.order)
  for (const a of rest) rank.set(a.path, next++)
  lib2.apps.sort((a, b) => {
    const ra = rank.has(a.path) ? rank.get(a.path) : 1e9
    const rb = rank.has(b.path) ? rank.get(b.path) : 1e9
    return ra - rb
  })
  lib2.apps.forEach((a, i) => {
    a.order = i
  })
  persist()
  return true
}

function createGroup(name) {
  const safe = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '')
  if (!safe) return { ok: false, error: '名字不能为空' }
  if (safe === ROOT_GROUP) return { ok: false, error: '这个名字被保留了' }
  const lib2 = ensure()
  if (lib2.groups.includes(safe)) return { ok: false, error: '同名分类已存在' }
  lib2.groups.push(safe)
  lib2.groups = sortGroups(lib2.groups)
  persist()
  return { ok: true, group: safe }
}

function setGroup(appPath, group) {
  const a = find(appPath)
  if (!a) return { ok: false, error: '库里没有这个应用' }
  const target = String(group || '').trim() || ROOT_GROUP
  if (target !== ROOT_GROUP && !ensure().groups.includes(target)) {
    return { ok: false, error: '目标分类不存在' }
  }
  a.group = target
  persist()
  return { ok: true, group: target }
}

function removeGroup(name) {
  const lib2 = ensure()
  const idx = lib2.groups.indexOf(name)
  if (idx === -1) return { ok: false, error: '分类不存在' }
  lib2.groups.splice(idx, 1)
  // 分类里的应用不删，退回「未分类」，免得误删一堆条目
  let moved = 0
  for (const a of lib2.apps) {
    if (a.group === name) {
      a.group = ROOT_GROUP
      moved++
    }
  }
  persist()
  clearGroupMeta(name)
  return { ok: true, movedToRoot: moved }
}

// 手动重新导入：只加库里没有的，已存在的不动（不覆盖用户改过的名字/分类/排序）
// 只列清单不落库：把文件夹里「会新增」的快捷方式列出来，交给界面勾选
function planImportFolder(dir) {
  const target = String(dir || LEGACY_DIR)
  if (!fs.existsSync(target)) return { ok: false, error: '文件夹不存在', files: [] }
  const lib2 = ensure()
  const exists = new Set(lib2.apps.map((a) => a.path.toLowerCase()))
  const seenName = new Set(lib2.apps.map((a) => (a.origName || '').toLowerCase()))
  const files = scanDir(target, target, [], 0)
  const out = []
  for (const f of files) {
    const orig = baseName(f.path)
    if (!orig || exists.has(f.path.toLowerCase())) continue
    const key = orig.toLowerCase()
    if (seenName.has(key)) continue // 同名仍只保留一个，避免 Dock 上出现两个一样的
    seenName.add(key)
    out.push({ path: f.path, name: orig, group: f.group || ROOT_GROUP })
  }
  return { ok: true, files: out, scanned: files.length }
}

// 把用户勾选的清单加进库（分组沿用扫描时的相对子目录）
function importPicked(list) {
  const arr = Array.isArray(list) ? list : []
  const lib2 = ensure()
  let added = 0
  for (const f of arr) {
    if (!f || !f.path) continue
    const orig = f.name || baseName(f.path)
    if (!orig) continue
    if (f.group && f.group !== ROOT_GROUP && !lib2.groups.includes(f.group)) lib2.groups.push(f.group)
    lib2.apps.push({
      path: f.path,
      origName: orig,
      name: orig,
      group: f.group || ROOT_GROUP,
      order: lib2.apps.length,
    })
    added++
  }
  if (added) {
    lib2.groups = sortGroups(lib2.groups)
    persist()
  }
  return { ok: true, added }
}

function importFolder(dir) {
  const plan = planImportFolder(dir)
  if (!plan.ok) return plan
  const res = importPicked(plan.files)
  return Object.assign({ skipped: 0, scanned: plan.scanned }, res)
}

// 只列清单不落库：拖入的文件夹里「会新增」哪些快捷方式（分组固定为文件夹名）
function planFolderAsGroup(dir) {
  const src = String(dir || '').trim()
  if (!src) return { ok: false, error: '路径为空', files: [] }
  let st = null
  try {
    st = fs.statSync(src)
  } catch (e) {
    return { ok: false, error: '文件夹不存在', files: [] }
  }
  if (!st.isDirectory()) return { ok: false, error: '不是一个文件夹', files: [] }
  const name = path.basename(src).trim()
  if (!name || name === ROOT_GROUP) return { ok: false, error: '文件夹名不可用', files: [] }

  const lib2 = ensure()
  const seenPath = new Set(lib2.apps.map((a) => a.path.toLowerCase()))
  const seenName = new Set(lib2.apps.map((a) => a.origName.toLowerCase()))
  const files = scanDir(src, src, [], 0)
  const out = []
  for (const f of files) {
    if (seenPath.has(f.path.toLowerCase())) continue
    const orig = baseName(f.path)
    if (!orig || seenName.has(orig.toLowerCase())) continue
    seenName.add(orig.toLowerCase())
    out.push({ path: f.path, name: orig, group: name })
  }
  return { ok: true, group: name, files: out }
}

// 拖一个文件夹进来：用文件夹名建分类，里面的快捷方式整批导进这个分类。
// 分类已存在就并进去，不会覆盖已有的名字/排序。
function addFolderAsGroup(dir, only) {
  const src = String(dir || '').trim()
  if (!src) return { ok: false, error: '路径为空' }

  let st = null
  try {
    st = fs.statSync(src)
  } catch (e) {
    return { ok: false, error: '文件夹不存在' }
  }
  if (!st.isDirectory()) return { ok: false, error: '不是一个文件夹' }

  const name = path.basename(src).trim()
  if (!name || name === ROOT_GROUP) return { ok: false, error: '文件夹名不可用' }

  const lib2 = ensure()
  const isNewGroup = !lib2.groups.includes(name)
  if (isNewGroup) {
    lib2.groups.push(name)
    lib2.groups = sortGroups(lib2.groups)
  }

  const seenPath = new Set(lib2.apps.map((a) => a.path.toLowerCase()))
  const seenName = new Set(lib2.apps.map((a) => a.origName.toLowerCase()))
  const files = scanDir(src, src, [], 0)
  // only（可选）：Set<path>，只导入这些；批量添加的确认勾选靠它过滤
  const want = only && only.size ? only : null
  let added = 0
  let skipped = 0

  for (const f of files) {
    if (want && !want.has(f.path)) continue
    if (seenPath.has(f.path.toLowerCase())) {
      skipped++
      continue
    }
    const orig = baseName(f.path)
    if (!orig) {
      skipped++
      continue
    }
    // 同名应用不重复加，否则 Dock 上会出现两个一模一样的名字
    if (seenName.has(orig.toLowerCase())) {
      skipped++
      continue
    }
    lib2.apps.push({
      path: f.path,
      origName: orig,
      name: orig,
      group: name,
      order: lib2.apps.length,
    })
    seenPath.add(f.path.toLowerCase())
    seenName.add(orig.toLowerCase())
    added++
  }

  persist()
  return { ok: true, group: name, isNewGroup, added, skipped, scanned: files.length }
}

// ---- 分类锁与密码 ----
// 锁状态还是老的 locked-groups.json（数组），密码单独放 group-passwords.json（只存 sha256）
let lockedCache = null
let passCache = null

function lockedFile() {
  return userFile('locked-groups.json')
}

function passwordFile() {
  return userFile('group-passwords.json')
}

function loadLocked() {
  if (lockedCache) return lockedCache
  const raw = readJson(lockedFile(), [])
  lockedCache = Array.isArray(raw) ? raw : []
  return lockedCache
}

function persistLocked() {
  writeJson(lockedFile(), lockedCache)
}

function getLockedGroups() {
  return loadLocked().slice()
}

function setGroupLocked(group, locked) {
  const list = loadLocked()
  const i = list.indexOf(group)
  if (locked && i === -1) list.push(group)
  if (!locked && i !== -1) list.splice(i, 1)
  persistLocked()
  return { ok: true, locked: list.slice() }
}

function loadPasswords() {
  if (passCache) return passCache
  const raw = readJson(passwordFile(), {})
  passCache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return passCache
}

function persistPasswords() {
  writeJson(passwordFile(), passCache || {})
}

function hashPass(plain) {
  // 加固定前缀只是让它不长得像普通 sha256 摘要，别当加密用
  return crypto.createHash('sha256').update('dockpad::' + String(plain)).digest('hex')
}

// 传空字符串就是清除密码
function setGroupPassword(group, plain) {
  const map = loadPasswords()
  const name = String(group || '').trim()
  if (!name) return { ok: false, error: '分类为空' }
  const p = String(plain == null ? '' : plain)
  if (p) map[name] = hashPass(p)
  else delete map[name]
  persistPasswords()
  return { ok: true, hasPassword: !!p }
}

// 只告诉渲染进程哪些分类有密码，哈希本身不出主进程
function getPasswordGroups() {
  return Object.keys(loadPasswords())
}

function verifyGroupPassword(group, plain) {
  const map = loadPasswords()
  const h = map[group]
  if (!h) return true // 没设密码就等于不拦
  return hashPass(plain) === h
}

function clearGroupMeta(name) {
  const locked = loadLocked()
  const li = locked.indexOf(name)
  if (li !== -1) {
    locked.splice(li, 1)
    persistLocked()
  }
  const map = loadPasswords()
  if (map[name]) {
    delete map[name]
    persistPasswords()
  }
}

// 改名：分类名、应用归属、锁、密码都要跟着搬
function renameGroup(oldName, newName) {
  const lib2 = ensure()
  const from = String(oldName || '').trim()
  const to = String(newName || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
  if (!from) return { ok: false, error: '分类为空' }
  if (!to) return { ok: false, error: '名字不能为空' }
  if (from === to) return { ok: true, group: to }
  if (to === ROOT_GROUP) return { ok: false, error: '这个名字被保留了' }
  const idx = lib2.groups.indexOf(from)
  if (idx === -1) return { ok: false, error: '分类不存在' }
  if (lib2.groups.includes(to)) return { ok: false, error: '同名分类已存在' }

  lib2.groups[idx] = to
  lib2.groups = sortGroups(lib2.groups)
  let moved = 0
  for (const a of lib2.apps) {
    if (a.group === from) {
      a.group = to
      moved++
    }
  }
  persist()

  const locked = loadLocked()
  const li = locked.indexOf(from)
  if (li !== -1) {
    locked[li] = to
    persistLocked()
  }
  const map = loadPasswords()
  if (map[from]) {
    map[to] = map[from]
    delete map[from]
    persistPasswords()
  }

  return { ok: true, group: to, moved }
}

// ---- 扫描文件夹里的主程序 ----
// 安装目录里通常混着一堆辅助 exe（卸载器、更新器、崩溃上报、VC 运行库、双架构变体），
// 只按扩展名扫会把它们全捞进来，所以靠「名字黑名单 + 每目录只留一个」两层过滤。
const EXE_SKIP_NAME = [
  /unins|uninstal|卸载/i,
  /setup|install|安装/i,
  /^update|update$|upgrad|checkupdate|更新/i,
  /crashpad|crash[-_.]?handler|crashreporter|crashrpt/i,
  /^helper$|[-_. ]helper$/i,
  /^service$|[-_. ]service$/i,
  /^repair|修复/i,
  /^elevate/i,
  /vc_?redist|dxsetup|dotnet|microsoft\.net|oalinst/i,
  /^aria2c$|^ffmpeg$|^ffplay$|^curl$|^wget$/i,
]

const DIR_SKIP = [
  /^uninstall/i,
  /^\$pluginsdir$/i,
  /^\$recycle\.bin$/i,
  /^redist$/i,
  /^vcredist/i,
  /^directx$/i,
  /^dotnet/i,
  /^windows$/i,
  /^system32$/i,
  /^syswow64$/i,
  /^winsxs$/i,
  /^temp$/i,
  /^cache$/i,
]

// 小于这个体积的基本是图标占位或启动壳，不是真程序
const MIN_EXE_SIZE = 16 * 1024
const MAX_SCAN_DEPTH = 8

async function walkForExe(dir, root, out, depth) {
  if (depth > MAX_SCAN_DEPTH) return
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (DIR_SKIP.some((r) => r.test(ent.name))) continue
      await walkForExe(full, root, out, depth + 1)
      continue
    }
    if (!/\.exe$/i.test(ent.name)) continue

    const base = path.basename(ent.name, path.extname(ent.name))
    if (EXE_SKIP_NAME.some((r) => r.test(base))) continue

    let size = 0
    try {
      size = (await fs.promises.stat(full)).size
    } catch (e) {
      continue
    }
    if (size < MIN_EXE_SIZE) continue
    out.push({ path: full, name: base, size, depth })
  }
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s._\-]+/g, '')
    .replace(/v?\d+(\.\d+)*/g, '')
}

// 同一组里挑最可能是主程序的那个：名字贴合目录名 > 体积大 > 层级浅
function pickMain(list, dirName) {
  const dn = normName(dirName)
  let best = null
  let bestScore = -Infinity
  for (const e of list) {
    const bn = normName(e.name)
    let score = 0
    if (dn && bn === dn) score += 120
    else if (dn && bn && (bn.includes(dn) || dn.includes(bn))) score += 60
    // 体积按对数给分，避免「谁大谁赢」压过名字匹配
    score += Math.min(40, Math.log10(Math.max(1, e.size / 1024)) * 12)
    score -= (e.depth || 0) * 6
    if (score > bestScore) {
      bestScore = score
      best = e
    }
  }
  return best
}

// 扫一个文件夹，把像「主程序」的 exe 加进库（归到未分类）。
// 按扫描根的第一层子目录分组，每组只取一个 —— 一个程序目录通常只有一个是给人点的。
async function addAppsFromFolder(dir) {
  const target = String(dir || '').trim()
  if (!target) return { ok: false, error: '路径为空' }
  let st = null
  try {
    st = await fs.promises.stat(target)
  } catch (e) {
    return { ok: false, error: '文件夹不存在' }
  }
  if (!st.isDirectory()) return { ok: false, error: '不是一个文件夹' }

  const all = []
  await walkForExe(target, target, all, 0)

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
    const one = pickMain(groups.get('__root__'), path.basename(target))
    if (one) picked.push(one)
  } else {
    for (const [key, arr] of groups) {
      const one = pickMain(arr, key === '__root__' ? path.basename(target) : key)
      if (one) picked.push(one)
    }
  }

  const lib2 = ensure()
  const seenPath = new Set(lib2.apps.map((a) => a.path.toLowerCase()))
  const seenName = new Set(lib2.apps.map((a) => a.origName.toLowerCase()))
  let added = 0
  let duplicate = 0

  for (const e of picked) {
    if (seenPath.has(e.path.toLowerCase()) || seenName.has(e.name.toLowerCase())) {
      duplicate++
      continue
    }
    lib2.apps.push({
      path: e.path,
      origName: e.name,
      name: e.name,
      group: ROOT_GROUP,
      order: lib2.apps.length,
    })
    seenPath.add(e.path.toLowerCase())
    seenName.add(e.name.toLowerCase())
    added++
  }

  if (added) persist()
  return { ok: true, scanned: all.length, groups: groups.size, added, duplicate }
}

function invalidateLibrary() {
  lib = null
}

module.exports = {
  LEGACY_DIR,
  ROOT_GROUP,
  getLibrary,
  getApps,
  getGroups,
  addApp,
  removeApp,
  updateAppPath,
  touchApp,
  rename,
  setOrder,
  createGroup,
  setGroup,
  removeGroup,
  renameGroup,
  getLockedGroups,
  setGroupLocked,
  setGroupPassword,
  getPasswordGroups,
  verifyGroupPassword,
  addFolderAsGroup,
  planFolderAsGroup,
  walkForExe,
  pickMain,
  addAppsFromFolder,
  planImportFolder,
  importPicked,
  importFolder,
  invalidateLibrary,
  persistLibrary: persist,
  libraryFile,
}
