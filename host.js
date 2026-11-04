/**
 * dsh-workspace-deletetool — Host half.
 *
 * DSH 本身只能「归档」工作区以外的操作：workspaceRegistry.delete(id) 的注释写明
 * "Delete one workspace registration while retaining its directory and every member
 * session." —— 只掉登记，目录与成员会话都留着。这个插件补上「连目录一起删」。
 *
 * 路由（都是 ctx.webServer 上的 exact 路由，不需要鉴权）：
 *   GET  /dsh-workspace-deletetool/catalog  列出所有工作区 + 目录大小与文件数
 *   POST /dsh-workspace-deletetool/delete   { workspaceId, deleteDirectory? }
 *
 * 护栏：只删 workspaceRegistry 里登记过的路径；盘符根、层级过浅、用户主目录、
 * DSH 数据目录、AppData、桌面、文档、下载，以及它们的上级目录，一律拒绝。
 */
import { mkdir as mkdirAsync, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer']

const BASE = '/dsh-workspace-deletetool'
const CATALOG_PATH = BASE + '/catalog'
const DELETE_PATH = BASE + '/delete'
const RENAME_PATH = BASE + '/rename'
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const MAX_BODY_BYTES = 8192
const MAX_WALK_FILES = 20000

class ToolRefusal extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ToolRefusal'
    this.status = status
    this.code = code
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function send(response, status, body) {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

function sameOrigin(request) {
  const origin = request.headers && request.headers.origin
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ToolRefusal(413, 'body-too-large', '请求体超过 ' + MAX_BODY_BYTES + ' 字节'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function fold(path) {
  return String(path).replace(/[\\/]+$/, '').toLowerCase()
}

function inside(child, parent) {
  const c = fold(child)
  const p = fold(parent)
  if (c === p) return true
  return c.startsWith(p + '\\') || c.startsWith(p + '/')
}

function protectedRoots() {
  const home = homedir()
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')
  return [
    { label: '用户主目录', path: home },
    { label: 'DSH 数据目录', path: dshHome },
    { label: 'AppData', path: join(home, 'AppData') },
    { label: '桌面', path: join(home, 'Desktop') },
    { label: '文档', path: join(home, 'Documents') },
    { label: '下载', path: join(home, 'Downloads') },
  ]
}

async function measure(directory) {
  const summary = { exists: false, files: 0, bytes: 0, truncated: false }
  let info
  try {
    info = await stat(directory)
  } catch {
    return summary
  }
  summary.exists = true
  if (!info.isDirectory()) {
    summary.files = 1
    summary.bytes = info.size
    return summary
  }
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      summary.files += 1
      if (summary.files >= MAX_WALK_FILES) {
        summary.truncated = true
        return summary
      }
      try {
        summary.bytes += (await stat(full)).size
      } catch {
        // 统计不到的文件只跳过，不影响删除判断
      }
    }
  }
  return summary
}

// 尽力删除：Windows 上被进程占用的文件既不能删也不能改名（实测 Rename-Item 直接拒绝访问），
// 所以一次性 rm -r 会整体失败。这里降级为自底向上逐个删，把删不掉的项如实收集起来，绝不谎报成功。
async function removeTreeBestEffort(root) {
  const skipped = new Map()
  let removed = 0
  const note = (path, reason) => {
    if (!skipped.has(path)) skipped.set(path, reason)
  }
  const walk = async (path) => {
    let info
    try {
      info = await stat(path)
    } catch (error) {
      note(path, messageOf(error))
      return
    }
    if (!info.isDirectory()) {
      try {
        await rm(path, { force: true })
        removed += 1
      } catch (error) {
        note(path, messageOf(error))
      }
      return
    }
    let entries = []
    try {
      entries = await readdir(path)
    } catch (error) {
      note(path, messageOf(error))
      return
    }
    for (const name of entries) await walk(join(path, name))
    try {
      await rm(path, { recursive: false, force: true })
      removed += 1
    } catch (error) {
      let rest = []
      try {
        rest = await readdir(path)
      } catch {
        rest = []
      }
      note(path, rest.length > 0 ? '目录内仍有 ' + rest.length + ' 项被占用' : messageOf(error))
    }
  }
  await walk(root)
  const exists = (await measure(root)).exists
  return { removed, skipped: [...skipped].map(([path, reason]) => ({ path, reason })), exists }
}

function assertDeletable(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) throw new ToolRefusal(400, 'no-path', '缺少目录路径')
  if (!/^[A-Za-z]:[\\/]/.test(trimmed)) throw new ToolRefusal(400, 'not-absolute', '只接受绝对路径：' + trimmed)
  const folded = fold(trimmed)
  if (/^[a-z]:$/.test(folded)) throw new ToolRefusal(403, 'refuse-root', '拒绝删除盘符根：' + trimmed)
  const segments = folded.split(/[\\/]+/).filter(Boolean)
  if (segments.length < 2) throw new ToolRefusal(403, 'refuse-shallow', '目录层级过浅，拒绝删除：' + trimmed)
  for (const root of protectedRoots()) {
    if (fold(root.path) === folded) throw new ToolRefusal(403, 'refuse-protected', '拒绝删除' + root.label + '：' + trimmed)
    if (inside(root.path, trimmed)) throw new ToolRefusal(403, 'refuse-ancestor', '该目录是' + root.label + '的上级，拒绝删除：' + trimmed)
  }
  return trimmed
}

async function describeCatalog(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const workspaces = await registry.list()
  const items = []
  for (const workspace of workspaces) {
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    const record = workspace.record
    const rawSessionIds = record && Array.isArray(record.sessionIds) ? record.sessionIds : sessionIds
    let status
    try {
      status = typeof workspace.status === 'function' ? workspace.status() : undefined
    } catch {
      status = undefined
    }
    items.push({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      status,
      sessionCount: sessionIds.length,
      rawSessionCount: rawSessionIds.length,
      sessionIds,
      directory: await measure(workspace.path),
    })
  }
  return { ok: true, workspaces: items }
}

async function serveCatalog(ctx, request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: '只接受 GET' })
    return
  }
  send(response, 200, await describeCatalog(ctx))
}

async function serveDelete(ctx, request, response) {
  if (request.method !== 'POST') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: '只接受 POST' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: '请求不是来自本机页面' })
    return
  }
  let body
  try {
    const text = await readBody(request)
    body = text ? JSON.parse(text) : {}
  } catch (error) {
    send(response, 400, { ok: false, code: 'bad-request', message: messageOf(error) })
    return
  }
  if (!body || typeof body !== 'object') {
    send(response, 400, { ok: false, code: 'bad-request', message: '请求体必须是对象' })
    return
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
  if (!workspaceId) {
    send(response, 400, { ok: false, code: 'no-workspace', message: '缺少 workspaceId' })
    return
  }
  const registry = ctx.get('workspaceRegistry')
  const workspace = registry.get(workspaceId)
  if (!workspace) {
    send(response, 404, { ok: false, code: 'workspace-not-found', message: '工作区不存在：' + workspaceId })
    return
  }
  let target
  try {
    target = assertDeletable(workspace.path)
  } catch (error) {
    send(response, error.status || 400, { ok: false, code: error.code || 'refused', message: messageOf(error) })
    return
  }
  const before = await measure(target)
  const result = {
    ok: true,
    workspaceId,
    title: workspace.title,
    path: target,
    before,
    registrationRemoved: false,
    directoryRemoved: false,
  }
  await registry.delete(workspaceId)
  result.registrationRemoved = true
  if (body.deleteDirectory !== false) {
    let sweep
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
      sweep = { removed: 0, skipped: [], exists: false }
    } catch {
      // 整体删除失败（多半是 .dsh-meow 里的 memory.db 被 DSH 占着），降级逐个删并如实报告
      sweep = await removeTreeBestEffort(target)
    }
    result.directoryRemoved = !sweep.exists
    if (sweep.skipped.length > 0) {
      result.remaining = sweep.skipped
      result.hint = '有文件正被其他进程占用（常见于 .dsh-meow 下的 memory.db），已从工作区列表移除登记，但目录删不干净；重启 DSH 释放句柄后该目录可手动删除。'
    }
  }
  const after = await measure(target)
  result.after = after
  result.directoryRemoved = !after.exists
  // 关键：必须真的把结果写回响应。早前这里只 return，onDelete 又把返回值丢掉，
  // 于是删除虽然做完了（注册表已删、目录已尽力删），HTTP 响应却永远不返回，
  // 调用方（圆桌）只能干等到超时，界面上表现为「删除卡住」。
  send(response, 200, result)
}

/**
 * Rename one Workspace registration without touching its directory.
 *
 * 这是「两侧同名」的正规通道：DSH 新建工作区时 workspaceRegistry.create(path) 用目录名当标题，
 * 而 Codex 项目名来自用户填的名称，两者在「填了名字、但路径指向已有目录」时就会分叉。
 * 走 workspace.setTitle()（WorkspaceEntity.setTitle → mutate → 落盘）而不是直接改 workspace.json：
 * 运行中的注册表是内存态、保存时整体覆盖写盘，外部改文件会被冲掉。
 */
async function serveRename(ctx, request, response) {
  if (request.method !== 'POST') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: '只接受 POST' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: '请求不是来自本机页面' })
    return
  }
  let body
  try {
    const text = await readBody(request)
    body = text ? JSON.parse(text) : {}
  } catch (error) {
    send(response, 400, { ok: false, code: 'bad-request', message: messageOf(error) })
    return
  }
  if (!body || typeof body !== 'object') {
    send(response, 400, { ok: false, code: 'bad-request', message: '请求体必须是对象' })
    return
  }
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) {
    send(response, 400, { ok: false, code: 'no-title', message: '缺少 title' })
    return
  }
  if (title.length > 200) {
    send(response, 400, { ok: false, code: 'title-too-long', message: 'title 过长（上限 200 字）' })
    return
  }
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.get !== 'function') {
    send(response, 503, { ok: false, code: 'registry-unavailable', message: 'workspaceRegistry 未挂载' })
    return
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
  let workspace = workspaceId ? registry.get(workspaceId) : undefined
  if (!workspace && typeof body.path === 'string' && body.path.trim() !== '') {
    const folded = fold(body.path.trim())
    const all = await registry.list()
    workspace = all.find((item) => fold(item.path) === folded)
  }
  if (!workspace) {
    send(response, 404, { ok: false, code: 'workspace-not-found', message: '找不到要改名的工作区：' + (workspaceId || body.path || '') })
    return
  }
  const before = workspace.title
  if (before !== title) {
    if (typeof workspace.setTitle !== 'function') {
      send(response, 501, { ok: false, code: 'no-set-title', message: '这个 DSH 版本的工作区实体没有 setTitle 方法' })
      return
    }
    await workspace.setTitle(title)
  }
  send(response, 200, { ok: true, id: workspace.id, path: workspace.path, before, title, changed: before !== title })
}

export function apply(ctx) {
  const onCatalog = (request, response) => {
    void serveCatalog(ctx, request, response).catch((error) => {
      ctx.logger?.warn?.('[dsh-workspace-deletetool] catalog 失败：' + messageOf(error))
      send(response, 500, { ok: false, code: 'internal', message: messageOf(error) })
    })
  }
  const onDelete = (request, response) => {
    void serveDelete(ctx, request, response).catch((error) => {
      ctx.logger?.warn?.('[dsh-workspace-deletetool] delete 失败：' + messageOf(error))
      send(response, 500, { ok: false, code: 'internal', message: messageOf(error) })
    })
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: CATALOG_PATH, handler: onCatalog }),
    'dsh-workspace-deletetool: catalog route',
  )
  const onRename = (request, response) => {
    void serveRename(ctx, request, response).catch((error) => {
      ctx.logger?.warn?.('[dsh-workspace-deletetool] rename 失败：' + messageOf(error))
      send(response, 500, { ok: false, code: 'internal', message: messageOf(error) })
    })
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: DELETE_PATH, handler: onDelete }),
    'dsh-workspace-deletetool: delete route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: RENAME_PATH, handler: onRename }),
    'dsh-workspace-deletetool: rename route',
  )
  ctx.logger?.info?.('[dsh-workspace-deletetool] 路由已挂载：' + CATALOG_PATH + '、' + DELETE_PATH + ' 与 ' + RENAME_PATH)
  void publishPort(ctx)
}

// 把宿主 Web 端口写到 DSH 数据目录，外部程序（圆桌）据此找到本插件的路由。
// DSH 每次启动的端口可能变，写文件比猜端口可靠。
async function publishPort(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const target = join(home, 'storages')
  const file = join(target, 'dsh-workspace-deletetool.port')
  // apply 的时候 webServer 可能还没 bind，port 是 undefined。轮询等待（最多 30 秒）再落盘。
  for (let i = 0; i < 60; i += 1) {
    let port = 0
    try {
      const server = ctx.get('webServer')
      port = Number(server && server.port) || 0
    } catch {
      port = 0
    }
    if (port > 0) {
      try {
        await mkdirAsync(target, { recursive: true })
        await writeFile(file, String(port), 'utf8')
        ctx.logger?.info?.('[dsh-workspace-deletetool] 端口已写入：' + port)
      } catch (error) {
        ctx.logger?.warn?.('[dsh-workspace-deletetool] 端口落盘失败：' + messageOf(error))
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  ctx.logger?.warn?.('[dsh-workspace-deletetool] 等了 30 秒还没拿到 Web 端口，未落盘')
}
