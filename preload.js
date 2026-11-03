const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('dockpad', {
  getApps: () => ipcRenderer.invoke('get-apps'),
  getPinned: () => ipcRenderer.invoke('get-pinned'),
  getGroups: () => ipcRenderer.invoke('get-groups'),
  renameApp: (targetPath, newName) => ipcRenderer.invoke('rename-app', targetPath, newName),
  removeApp: (appPath) => ipcRenderer.invoke('remove-app', appPath),
  setAppPath: (oldPath, newPath) => ipcRenderer.invoke('set-app-path', oldPath, newPath),
  desktopIcons: (action) => ipcRenderer.invoke('desktop-icons', action),
  openThisPc: () => ipcRenderer.send('open-this-pc'),
  saveOrder: (paths) => ipcRenderer.invoke('save-order', paths),
  windowThumb: (targetPath) => ipcRenderer.invoke('window-thumb', targetPath),
  pickIcon: (targetPath) => ipcRenderer.invoke('pick-icon', targetPath),
  resetIcon: (targetPath) => ipcRenderer.invoke('reset-icon', targetPath),
  createGroup: (name) => ipcRenderer.invoke('create-group', name),
  moveToGroup: (targetPath, group) => ipcRenderer.invoke('move-to-group', targetPath, group),
  getLockedGroups: () => ipcRenderer.invoke('get-locked-groups'),
  setGroupLocked: (group, locked) => ipcRenderer.invoke('set-group-locked', group, locked),
  getPasswordGroups: () => ipcRenderer.invoke('get-password-groups'),
  setGroupPassword: (group, plain) => ipcRenderer.invoke('set-group-password', group, plain),
  verifyGroupPassword: (group, plain) => ipcRenderer.invoke('verify-group-password', group, plain),
  renameGroup: (oldName, newName) => ipcRenderer.invoke('rename-group', oldName, newName),
  removeGroup: (name) => ipcRenderer.invoke('remove-group', name),
  getDockPaths: () => ipcRenderer.invoke('get-dock-paths'),
  addToDock: (targetPath) => ipcRenderer.invoke('add-to-dock', targetPath),
  removeFromDock: (targetPath) => ipcRenderer.invoke('remove-from-dock', targetPath),
  saveDockOrder: (paths) => ipcRenderer.invoke('save-dock-order', paths),
  showPreview: (targetPath, appName, anchorX, anchorY) => ipcRenderer.invoke('show-preview', targetPath, appName, anchorX, anchorY),
  hidePreview: () => ipcRenderer.send('hide-preview'),
  onPreviewSrc: (cb) => ipcRenderer.on('preview-src', (e, payload) => cb(payload || {})),
  launch: (target) => ipcRenderer.invoke('launch', target),
  showGrid: (pt) => ipcRenderer.send('show-grid', pt),
  toggleGrid: (pt) => ipcRenderer.send('toggle-grid', pt),
  hideGrid: () => ipcRenderer.send('hide-grid'),
  // Dock 上「全部应用」按钮的屏幕位置：托盘/快捷键开面板时也得知道从哪儿展开
  reportGridAnchor: (rect) => ipcRenderer.send('grid-anchor', rect),
  // 开关动画：主进程会把 Dock 按钮的屏幕坐标一起发过来
  onGridOpen: (cb) => ipcRenderer.on('grid-opening', (_e, anchor) => cb(anchor)),
  onGridClose: (cb) => ipcRenderer.on('grid-closing', (_e, anchor) => cb(anchor)),
  gridClosed: () => ipcRenderer.send('grid-closed'),
  // 展开动画播完：让主进程把动画期间临时扩出来的透明边收掉
  gridOpened: () => ipcRenderer.send('grid-opened'),
  quit: () => ipcRenderer.send('quit-app'),
  reloadApps: () => ipcRenderer.send('reload-apps'),
  onAppsReset: (cb) => ipcRenderer.on('apps-reset', () => cb()),
  // 贴边吸附：主进程 → 渲染进程，通知切换横排/竖排
  onDockOrient: (cb) => ipcRenderer.on('dock-orient', (e, orient) => cb(orient)),
  // Dock 被拖动 / 自动隐藏后位置变了，按钮坐标要重新报一次
  onDockMoved: (cb) => ipcRenderer.on('dock-moved', () => cb()),
  // 渲染进程 → 主进程，竖排时把实际内容高度报给主进程，让窗口贴合内容
  dockResize: (h, w) => ipcRenderer.send('dock-resize', h, w),
  getRunningProcs: () => ipcRenderer.invoke('running-procs'),
  activateApp: (appPath) => ipcRenderer.invoke('activate-app', appPath),
  // 设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  suspendShortcuts: () => ipcRenderer.invoke('suspend-shortcuts'),
  resumeShortcuts: () => ipcRenderer.invoke('resume-shortcuts'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (e, s) => cb(s)),
  getAutoStart: () => ipcRenderer.invoke('get-autostart'),
  setAutoStart: (on) => ipcRenderer.invoke('set-autostart', on),
  openSettings: () => ipcRenderer.send('open-settings'),
  toggleSettings: () => ipcRenderer.send('toggle-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),
  dockMenu: () => ipcRenderer.send('dock-menu'),
  resetDockPos: () => ipcRenderer.invoke('reset-dock-pos'),
  clearIconCache: () => ipcRenderer.invoke('clear-icon-cache'),
  // 应用库
  getLibraryInfo: () => ipcRenderer.invoke('library-info'),
  importFolder: () => ipcRenderer.invoke('library-import'),
  pickApp: () => ipcRenderer.invoke('library-add'),
  scanApps: () => ipcRenderer.invoke('scan-apps'),
  // 拖放：File 对象只有渲染进程认得，路径要在这里换出来（Electron 32+ 移除了 file.path）
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch (e) {
      return ''
    }
  },
  importDrop: (paths) => ipcRenderer.invoke('import-drop', paths),
})
