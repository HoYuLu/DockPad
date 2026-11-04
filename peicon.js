// 从 exe / dll 的 PE 资源里直接抠图标。
//
// 起因：Electron 的 app.getFileIcon 只按 32×32 向系统要图标，而很多现代程序
// （尤其是 Electron 应用）只内嵌一张 256×256 的 PNG 图标，系统缩不出来，
// 就返回「通用程序」图标 —— 表现是面板里没图标、一片灰。
//
// 实现要点：
// - 不整读文件（Electron 的 exe 动辄 200MB+），只按偏移分块读：头部 → 节表 → 资源段 → 图标数据
// - PE 资源树是三层：类型(14=图标组) → 名字/ID → 语言 → 数据项；数据项里才是 RVA + 大小
// - PNG 直接交给 nativeImage；老式 DIB 拼成 ico 再试

const fs = require('fs')
const { nativeImage } = require('electron')

const RT_ICON = 3
const RT_GROUP_ICON = 14
const MAX_RSRC = 16 * 1024 * 1024 // 资源段上限，防止个别病态文件把内存吃光

const u16 = (b, o) => b.readUInt16LE(o)
const u32 = (b, o) => b.readUInt32LE(o)

function readAt(fd, offset, length) {
  if (length <= 0) return Buffer.alloc(0)
  const buf = Buffer.alloc(length)
  const n = fs.readSync(fd, buf, 0, length, offset)
  return n === length ? buf : buf.subarray(0, n)
}

function parseHeaders(fd, size) {
  const head = readAt(fd, 0, Math.min(0x1000, size))
  if (head.length < 0x40 || u16(head, 0) !== 0x5a4d) return null // 'MZ'
  const peOff = u32(head, 0x3c)
  if (peOff + 24 > size) return null
  if (u32(head, peOff) !== 0x00004550) return null // 'PE\0\0'

  const coff = peOff + 4
  const numSections = u16(head, coff + 2)
  const optSize = u16(head, coff + 16)
  const opt = coff + 20

  // 节表可能落在首块之外，单独读一次
  const need = opt + optSize + numSections * 40
  const hdr = need <= head.length ? head : readAt(fd, 0, Math.min(need, size))
  if (hdr.length < opt + 2) return null

  const pe32plus = u16(hdr, opt) === 0x20b
  const ddOff = opt + (pe32plus ? 112 : 96)
  if (ddOff + 24 > hdr.length) return null
  const resRva = u32(hdr, ddOff + 16) // 数据目录索引 2 = 资源表
  const resSize = u32(hdr, ddOff + 20)
  if (!resRva || !resSize) return null

  const secOff = opt + optSize
  const sections = []
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40
    if (s + 40 > hdr.length) break
    sections.push({
      va: u32(hdr, s + 12),
      vsize: u32(hdr, s + 8),
      raw: u32(hdr, s + 20),
      rawSize: u32(hdr, s + 16),
    })
  }
  return { resRva, resSize, sections }
}

function rvaToOffset(sections, rva) {
  for (const s of sections) {
    const size = Math.max(s.vsize, s.rawSize)
    if (rva >= s.va && rva < s.va + size) return s.raw + (rva - s.va)
  }
  return -1
}

// 一层资源目录：[{ id, isDir, offset }]，offset 相对资源段起点
function readDir(buf, off) {
  if (off + 16 > buf.length) return []
  const named = u16(buf, off + 12)
  const ids = u16(buf, off + 14)
  const out = []
  for (let i = 0; i < named + ids; i++) {
    const e = off + 16 + i * 8
    if (e + 8 > buf.length) break
    const nameField = u32(buf, e)
    const dataField = u32(buf, e + 4)
    out.push({
      id: (nameField & 0x80000000) ? -1 : nameField,
      isDir: (dataField & 0x80000000) !== 0,
      offset: dataField & 0x7fffffff,
    })
  }
  return out
}

// 叶子节点是 IMAGE_RESOURCE_DATA_ENTRY，不是数据本身
function readDataEntry(buf, off) {
  if (off + 16 > buf.length) return null
  return { rva: u32(buf, off), size: u32(buf, off + 4) }
}

function resourceEntry(rsrc, typeId, id) {
  const type = readDir(rsrc, 0).find((d) => d.id === typeId && d.isDir)
  if (!type) return null
  const level2 = readDir(rsrc, type.offset)
  if (!level2.length) return null
  const item = id === undefined ? level2[0] : level2.find((d) => d.id === id)
  if (!item) return null
  const leaf = item.isDir ? readDir(rsrc, item.offset).find((x) => !x.isDir) : item
  if (!leaf) return null
  return readDataEntry(rsrc, leaf.offset)
}

function parseGroup(groupBuf) {
  if (!groupBuf || groupBuf.length < 6) return []
  const count = u16(groupBuf, 4)
  const list = []
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 14
    if (e + 14 > groupBuf.length) break
    list.push({
      w: groupBuf[e] || 256,
      h: groupBuf[e + 1] || 256,
      bitCount: u16(groupBuf, e + 6),
      id: u16(groupBuf, e + 12),
    })
  }
  return list
}

function buildIco(dib, entry) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(1, 4)
  const dir = Buffer.alloc(16)
  dir[0] = entry.w >= 256 ? 0 : entry.w
  dir[1] = entry.h >= 256 ? 0 : entry.h
  dir.writeUInt16LE(1, 4)
  dir.writeUInt16LE(entry.bitCount || 32, 6)
  dir.writeUInt32LE(dib.length, 8)
  dir.writeUInt32LE(22, 12)
  return Buffer.concat([header, dir, dib])
}

// 返回 NativeImage，失败返回 null
function iconImageFromExe(exePath) {
  let fd = -1
  try {
    fd = fs.openSync(exePath, 'r')
    const size = fs.fstatSync(fd).size
    if (size < 0x200) return null

    const pe = parseHeaders(fd, size)
    if (!pe) return null

    const resFileOff = rvaToOffset(pe.sections, pe.resRva)
    if (resFileOff < 0) return null

    const rsrcLen = Math.min(pe.resSize, MAX_RSRC, size - resFileOff)
    if (rsrcLen < 64) return null
    const rsrc = readAt(fd, resFileOff, rsrcLen)

    // 可能有多个图标组（主图标 + 文档类型图标），逐个比，取面积最大的
    const groupType = readDir(rsrc, 0).find((d) => d.id === RT_GROUP_ICON && d.isDir)
    if (!groupType) return null

    let best = null
    for (const g of readDir(rsrc, groupType.offset)) {
      const entry = resourceEntry(rsrc, RT_GROUP_ICON, g.id)
      if (!entry) continue
      const gData = rsrc.subarray(entry.rva - pe.resRva, entry.rva - pe.resRva + entry.size)
      for (const e of parseGroup(gData)) {
        const area = e.w * e.h
        if (!best || area > best.e.w * best.e.h) best = { e }
      }
    }
    if (!best) return null

    const iconEntry = resourceEntry(rsrc, RT_ICON, best.e.id)
    if (!iconEntry || iconEntry.size < 8) return null
    const iconBuf = readAt(fd, resFileOff + (iconEntry.rva - pe.resRva), iconEntry.size)
    if (iconBuf.length < 8) return null

    // 1) PNG（现代程序常见，256×256）直接解码
    if (iconBuf[0] === 0x89 && iconBuf[1] === 0x50) {
      const img = nativeImage.createFromBuffer(iconBuf)
      if (img && !img.isEmpty()) return img
    }

    // 2) 老式 DIB：拼成 ico 再交给 nativeImage
    const img2 = nativeImage.createFromBuffer(buildIco(iconBuf, best.e))
    if (img2 && !img2.isEmpty()) return img2
  } catch (e) {
    /* 解析失败就交给调用方的兜底 */
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd) } catch (e) { /* ignore */ }
    }
  }
  return null
}

module.exports = { iconImageFromExe }
