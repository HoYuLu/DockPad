// 设置存取：%APPDATA%\dockpad\settings.json
const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const DEFAULTS = {
  dockOpacity: 0.6, // Dock 条背景不透明度 0.15 - 1
  dockColor: '#1c1c1e', // Dock 条底色（和 dockOpacity 叠加）
  dockBtnColor: '#ffffff', // Dock 右侧圆按钮的底色（图标固定白色）
  iconSize: 50, // Dock 图标边长（px）
  gridIconSize: 54, // 应用面板里的图标边长（px）
  snapEdge: 30, // 贴边吸附触发距离（px），0 = 关闭吸附
  hoverPreview: true, // 悬停是否弹窗口缩略图
  dockOnTop: false, // Dock 是否始终置顶；关闭时让位给其他窗口（最下层）
  autoHide: false, // 鼠标离开后把 Dock 收到屏幕外，移到屏幕底边再滑出
  autoHideDelay: 700, // 收起的等待时间（ms）
  panelOpacity: 0.92, // 应用面板（网格）的背景不透明度
  closeOnBlur: true, // 点面板外面（窗口失焦）时自动关闭面板
  sortMode: 'manual', // 面板图标排序：manual 手动 / recent 最近使用 / name 名称
  panelColor: '#fafafc', // 应用面板底色
  appNameColor: '#1c1c1e', // 图标下方文字颜色
  lowGpu: false, // 省内存模式：关闭 GPU 加速（省整个 GPU 进程 ~120MB，重启生效）
  hotkeyPanel: '', // 打开应用面板的快捷键（Electron accelerator 格式，空 = 用内置默认）
  hotkeySettings: '', // 打开设置的快捷键
  hotkeyScan: '', // 扫描添加应用的快捷键
}

// 快捷键：只允许 Electron accelerator 里的字符，且不能太长
// 空字符串 = 用内置默认组合；特殊的 'none' = 用户明确要求不绑定（不注册任何键）
const HOTKEY_RE = /^[A-Za-z0-9+\-]{0,40}$/
const HOTKEYS = ['hotkeyPanel', 'hotkeySettings', 'hotkeyScan']

// #rrggbb，写错就退回默认值
const COLOR_RE = /^#[0-9a-f]{6}$/i
const COLORS = ['panelColor', 'appNameColor', 'dockColor', 'dockBtnColor']

// 字符串型配置的合法取值，写错了就退回默认，别让界面上出现奇怪状态
const ENUMS = {
  sortMode: ['manual', 'recent', 'name'],
}

// 只在允许范围内的数值才接受，避免界面上拖出天文数字写坏配置
const RANGES = {
  dockOpacity: [0, 1],
  iconSize: [36, 64],
  gridIconSize: [36, 96],
  snapEdge: [0, 120],
  autoHideDelay: [200, 3000],
  panelOpacity: [0, 1],
}

const BOOLS = ['hoverPreview', 'dockOnTop', 'autoHide', 'closeOnBlur', 'lowGpu']

let cache = null

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function clamp(key, value) {
  const range = RANGES[key]
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULTS[key]
  if (!range) return n
  return Math.min(range[1], Math.max(range[0], n))
}

// 数值走 clamp，布尔走 !!，枚举走白名单
function coerce(key, value) {
  if (HOTKEYS.includes(key)) return HOTKEY_RE.test(String(value || '')) ? String(value || '') : ''
  if (BOOLS.includes(key)) return !!value
  if (COLORS.includes(key)) return COLOR_RE.test(String(value || '')) ? String(value).toLowerCase() : DEFAULTS[key]
  const allowed = ENUMS[key]
  if (allowed) return allowed.includes(value) ? value : DEFAULTS[key]
  return clamp(key, value)
}

function load() {
  if (cache) return cache
  const out = Object.assign({}, DEFAULTS)
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, ''))
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        if (raw[k] === undefined) continue
        out[k] = coerce(k, raw[k])
      }
    }
  } catch (e) {
    /* 没配置就用默认值 */
  }
  cache = out
  return cache
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(cache, null, 2))
    return true
  } catch (e) {
    return false
  }
}

function get() {
  return Object.assign({}, load())
}

function set(patch) {
  const cur = load()
  for (const k of Object.keys(DEFAULTS)) {
    if (!patch || patch[k] === undefined) continue
    cur[k] = coerce(k, patch[k])
  }
  persist()
  return get()
}

function reset() {
  cache = Object.assign({}, DEFAULTS)
  persist()
  return get()
}

module.exports = { DEFAULTS, get, set, reset, settingsFile }
