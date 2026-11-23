// dsh-codex-bridge — Host 侧
// 把本机 Codex 会话的能力暴露成 DSH 工具，供电脑与手机端统一调用。

import { readFile, readdir, mkdtemp, copyFile, rm } from 'node:fs/promises'
import { accessSync, constants, readFileSync, existsSync } from 'node:fs'
import { join, basename, delimiter } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

export const name = 'codex-bridge'
export const inject = ['tools']

const DEFAULT_MODEL = 'gpt-6.2-sol'
const DEFAULT_SANDBOX = 'workspace-write'

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function macApplications() {
  return ['/Applications', join(homedir(), 'Applications')].flatMap(directory =>
    ['Codex.app', 'ChatGPT.app'].map(app => join(directory, app)))
}

function executable(path) {
  if (!path) return false
  try {
    accessSync(path, constants.X_OK)
    return existsSync(path)
  } catch {
    return false
  }
}

async function findCodexExeAsync() {
  let configured
  try {
    const cfg = readFileSync(join(codexHome(), 'config.toml'), 'utf8')
    configured = cfg.match(/CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]/)?.[1]
  } catch {}
  const command = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const searchPaths = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const candidates = [process.env.CODEX_CLI_PATH, configured]
  if (process.platform === 'darwin') {
    searchPaths.push(join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
    candidates.push(...macApplications().map(app => join(app, 'Contents', 'Resources', command)))
  }
  candidates.push(...searchPaths.map(directory => join(directory, command)))
  const hit = candidates.find(executable)
  if (hit || process.platform !== 'win32') return hit

  const result = await run('powershell', [
    '-NoProfile', '-Command',
    '(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation',
  ], 45000)
  const location = result.stdout.trim()
  if (!location) return undefined
  return [join(location, 'app', 'resources', command), join(location, 'app', command)].find(executable)
}

// ---- 子进程 ----

function run(cmd, args, timeout = 120000, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env, PYTHONIOENCODING: 'utf-8' },
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try { child.kill('SIGKILL') } catch {}
        resolve({ code: -1, stdout, stderr: stderr + '\n(timeout)' })
      }
    }, timeout)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

// ---- 会话数据（读 sqlite 快照）----

let DatabaseSync
function loadSqlite() {
  if (DatabaseSync !== undefined) return DatabaseSync
  try {
    const mod = createRequire(import.meta.url)('node:sqlite')
    DatabaseSync = mod.DatabaseSync || null
    if (DatabaseSync) return DatabaseSync
  } catch {}
  DatabaseSync = null
  return null
}

async function snapshotDb() {
  const src = join(codexHome(), 'thread_history_1.sqlite')
  if (!existsSync(src)) return null
  const dir = await mkdtemp(join(tmpdir(), 'codexbridge-'))
  const dst = join(dir, 'th.sqlite')
  await copyFile(src, dst)
  const wal = src + '-wal'
  if (existsSync(wal)) {
    try { await copyFile(wal, dst + '-wal') } catch {}
  }
  return { dbPath: dst, dir }
}

async function cleanupSnapshot(snap) {
  if (!snap) return
  try { await rm(snap.dir, { recursive: true, force: true }) } catch {}
}

function listThreads(db, limit) {
  const rows = db.prepare(`
    SELECT thread_id, count(*) AS turns, max(started_at) AS last
    FROM thread_turns GROUP BY thread_id ORDER BY last DESC
    ${limit ? 'LIMIT ?' : ''}
  `).all(...(limit ? [limit] : []))

  const q = db.prepare(`
    SELECT item_json FROM thread_items
    WHERE thread_id = ? AND item_type = 'userMessage'
    ORDER BY rollout_ordinal ASC
  `)

  return rows.map((r) => {
    let title = ''
    try {
      for (const it of q.all(r.thread_id)) {
        const payload = JSON.parse(it.item_json)
        for (const chunk of payload.content || []) {
          if (chunk.type === 'text' || chunk.type === 'inputText') {
            title += chunk.text || ''
          }
        }
        if (title) break
      }
    } catch {}
    return {
      id: r.thread_id,
      turns: r.turns,
      last: r.last,
      firstMessage: normTitle(title),
    }
  })
}

function normTitle(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim()
  const idx = t.indexOf('</environment_context>')
  if (t.startsWith('<environment_context>') && idx >= 0) {
    t = t.slice(idx + '</environment_context>'.length).trim()
  }
  return t
}

// ---- rollout 元信息（cwd / 模型）----

async function rolloutMeta(threadId) {
  const base = join(codexHome(), 'sessions')
  if (!existsSync(base)) return {}
  const found = await findRollout(base, threadId)
  if (!found) return {}
  try {
    const fh = await readFile(found, 'utf8')
    const firstLine = fh.slice(0, fh.indexOf('\n'))
    const meta = JSON.parse(firstLine)
    const p = meta.payload || {}
    const roots = p.runtime_workspace_roots || []
    return {
      cwd: p.cwd || roots[0] || null,
      model: p.base_instructions?.provenance?.model || null,
      originator: p.originator || null,
    }
  } catch {
    return {}
  }
}

async function findRollout(dir, threadId) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      const hit = await findRollout(full, threadId)
      if (hit) return hit
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.includes(threadId)) {
      return full
    }
  }
  return null
}

// ---- 读取对话 ----

function readThread(db, threadId, limit = 200) {
  const rows = db.prepare(`
    SELECT item_type, item_json FROM thread_items
    WHERE thread_id = ? ORDER BY rollout_ordinal ASC
  `).all(threadId)

  const msgs = []
  for (const r of rows) {
    let p
    try { p = JSON.parse(r.item_json) } catch { continue }
    if (r.item_type === 'userMessage') {
      let text = ''
      for (const c of p.content || []) {
        if (c.type === 'text' || c.type === 'inputText') text += c.text || ''
      }
      text = normTitle(text)
      if (text) msgs.push({ role: 'user', text })
    } else if (r.item_type === 'agentMessage') {
      const text = (p.text || '').trim()
      if (text) msgs.push({ role: 'codex', text })
    } else if (r.item_type === 'commandExecution') {
      const cmd = p.command || p.script || ''
      if (cmd) msgs.push({ role: 'command', text: String(cmd).replace(/\s+/g, ' ').slice(0, 200) })
    }
  }
  return msgs.slice(-limit)
}

// ---- 对外操作 ----

async function threads({ limit = 50 } = {}) {
  const DatabaseSync2 = loadSqlite()
  if (!DatabaseSync2) {
    return { error: '当前 Node 运行时没有 node:sqlite，无法读取 Codex 会话库' }
  }
  const snap = await snapshotDb()
  if (!snap) return { error: '找不到 thread_history_1.sqlite，请确认已安装 Codex 桌面版' }
  try {
    const db = new DatabaseSync2(snap.dbPath, { readOnly: true })
    try {
      const base = listThreads(db, limit)
      const out = []
      for (const t of base) {
        const meta = await rolloutMeta(t.id)
        out.push({ ...t, cwd: meta.cwd, model: meta.model })
      }
      // 按项目分组
      const groups = new Map()
      for (const t of out) {
        const key = t.cwd || ''
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(t)
      }
      const grouped = [...groups.entries()]
        .sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || b[1].length - a[1].length)
        .map(([cwd, items]) => ({
          project: cwd ? basename(cwd) : '其他（无工作目录）',
          cwd: cwd || null,
          count: items.length,
          threads: items,
        }))
      return { total: out.length, groups: grouped }
    } finally {
      try { db.close() } catch {}
    }
  } finally {
    await cleanupSnapshot(snap)
  }
}

async function read({ thread, limit = 100 } = {}) {
  const DatabaseSync2 = loadSqlite()
  if (!DatabaseSync2) return { error: '当前 Node 运行时没有 node:sqlite' }
  const snap = await snapshotDb()
  if (!snap) return { error: '找不到 Codex 会话库' }
  try {
    const db = new DatabaseSync2(snap.dbPath, { readOnly: true })
    try {
      const tid = resolveThread(db, thread)
      if (!tid) return { error: `找不到会话：${thread}` }
      const meta = await rolloutMeta(tid)
      return {
        thread: tid,
        cwd: meta.cwd,
        model: meta.model,
        messages: readThread(db, tid, limit),
      }
    } finally {
      try { db.close() } catch {}
    }
  } finally {
    await cleanupSnapshot(snap)
  }
}

function resolveThread(db, token) {
  const t = String(token || '').trim()
  if (!t) return null
  const rows = db.prepare(`
    SELECT thread_id, count(*) AS turns, max(started_at) AS last
    FROM thread_turns GROUP BY thread_id ORDER BY last DESC
  `).all()
  if (/^\d+$/.test(t)) {
    const idx = Number(t)
    if (idx >= 1 && idx <= rows.length) return rows[idx - 1].thread_id
  }
  for (const r of rows) {
    if (r.thread_id === t || r.thread_id.startsWith(t)) return r.thread_id
  }
  return null
}

/**
 * macOS：从 `scutil --proxy` 读出系统代理，转成 HTTP_PROXY/HTTPS_PROXY 环境变量。
 * Codex CLI 的 Responses WebSocket 不读 macOS 系统代理设置，而桌面端（Electron）
 * 会读，所以不开代理时 CLI 会卡在 WebSocket 握手重试上（Reconnecting 1..5/5 约 100
 * 秒）才回落到 HTTPS。把代理显式传给子进程可省掉这段等待。
 */
async function macProxyAddress() {
  const result = await run('/usr/sbin/scutil', ['--proxy'], 5000)
  if (result.code !== 0) return ''
  const text = result.stdout
  const enabled = (key) => new RegExp(`^\\s*${key}Enable\\s*:\\s*1\\s*$`, 'm').test(text)
  const value = (key) => (text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm')) || [])[1] || ''
  for (const [flag, host, port] of [
    ['HTTPS', 'HTTPSProxy', 'HTTPSPort'],
    ['HTTP', 'HTTPProxy', 'HTTPPort'],
  ]) {
    if (!enabled(flag)) continue
    const h = value(host)
    const p = value(port)
    if (!h || !p) continue
    const scheme = /^socks/i.test(h) ? 'socks5' : 'http'
    return `${scheme}://${h}:${p}`
  }
  if (enabled('SOCKS')) {
    const h = value('SOCKSProxy')
    const p = value('SOCKSPort')
    if (h && p) return `socks5://${h}:${p}`
  }
  return ''
}

async function codexProxyEnvironment() {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) return {}

  if (process.platform === 'darwin') {
    const address = await macProxyAddress()
    if (!address) return {}
    return {
      HTTPS_PROXY: address,
      HTTP_PROXY: address,
      ALL_PROXY: address,
      NO_PROXY: process.env.NO_PROXY ?? 'localhost,127.0.0.1,::1',
    }
  }

  if (process.platform !== 'win32') return {}

  // Electron can use the Windows proxy settings, while this Codex subprocess
  // needs proxy environment variables for its Responses WebSocket connection.
  const script = String.raw`
$proxy = [System.Net.WebRequest]::GetSystemWebProxy()
$chat = [uri]'https://chatgpt.com/'
$api = [uri]'https://api.openai.com/'
if ($proxy.IsBypassed($chat) -or $proxy.IsBypassed($api)) { exit }
$address = $proxy.GetProxy($chat)
if ($address -eq $proxy.GetProxy($api) -and $address.IsLoopback -and !$address.UserInfo -and
    $address.Scheme -in @('http', 'https')) {
  [Console]::WriteLine($address.GetLeftPart([UriPartial]::Authority))
}
`
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 5000)
  const address = result.stdout.trim()
  if (result.code !== 0 || !address) return {}
  return {
    HTTPS_PROXY: address,
    NO_PROXY: process.env.NO_PROXY ?? 'localhost,127.0.0.1,::1',
  }
}

let activeAsks = 0

async function ask(args) {
  if (restartJob?.state === 'running') return { error: 'Codex 正在重启，请等重启完成后再发送任务' }
  activeAsks++
  try {
    return await executeAsk(args)
  } finally {
    activeAsks--
  }
}

async function executeAsk({ thread, message, model, sandbox } = {}) {
  if (typeof message !== 'string' || !message.trim()) return { error: '缺少 message' }
  const exe = await findCodexExeAsync()
  if (!exe) return { error: '找不到 Codex CLI，可通过 CODEX_CLI_PATH 指定可执行文件' }

  let tid = thread
  // 允许用序号：先解析
  if (tid && /^\d+$/.test(String(tid).trim())) {
    const DatabaseSync2 = loadSqlite()
    if (DatabaseSync2) {
      const snap = await snapshotDb()
      if (snap) {
        try {
          const db = new DatabaseSync2(snap.dbPath, { readOnly: true })
          try { tid = resolveThread(db, tid) || tid } finally { try { db.close() } catch {} }
        } finally { await cleanupSnapshot(snap) }
      }
    }
  }

  const meta = tid ? await rolloutMeta(tid) : {}
  const cwd = meta.cwd && existsSync(meta.cwd) ? meta.cwd : process.cwd()
  const mdl = model || DEFAULT_MODEL
  const sb = sandbox || DEFAULT_SANDBOX

  const env = await codexProxyEnvironment()
  const outputDir = await mkdtemp(join(tmpdir(), 'codexbridge-answer-'))
  const outputPath = join(outputDir, 'answer.txt')
  const common = ['--skip-git-repo-check', '-m', mdl, '-o', outputPath]
  const args = tid
    ? ['exec', 'resume', tid, ...common, '-c', `sandbox_mode="${sb}"`, '--', message]
    : ['exec', ...common, '-s', sb, '-C', cwd, '--', message]

  let res
  let answer
  try {
    res = await run(exe, args, 900000, { cwd, env })
    answer = (await readFile(outputPath, 'utf8').catch(() => '')).trim()
  } finally {
    await cleanupSnapshot({ dir: outputDir })
  }
  const blob = res.stderr + res.stdout

  if (blob.includes('already has an active writer')) {
    return {
      error: 'thread-busy',
      message: '这个会话正被 ChatGPT 桌面端占用，写锁未释放。',
      hint: '可以调用 codex_restart 重启 ChatGPT 释放占用，或换一个会话。',
    }
  }

  if (res.code !== 0) {
    return { error: 'Codex 执行失败', exitCode: res.code, detail: res.stderr.trim().split(/\r?\n/).slice(-6).join('\n') }
  }

  return {
    thread: tid || '(新会话)',
    cwd,
    model: mdl,
    answer: answer || '(没有解析到回答)',
    exitCode: res.code,
  }
}

let restartJob = null
let restartCompletion = null
let activePanelTasks = 0

function restartStatus() {
  return { job: restartJob, tasksBusy: activeAsks > 0 || activePanelTasks > 0 }
}

function startRestart(id) {
  if (restartJob?.id === id || restartJob?.state === 'running') return restartStatus()
  if (restartStatus().tasksBusy) return { error: '还有 Codex 桥接任务在执行，请等任务完成后再重启' }
  const job = { id, state: 'running' }
  restartJob = job
  restartCompletion = (async () => {
    let result
    try {
      if (process.platform === 'win32') result = await restartWindows()
      else if (process.platform === 'darwin') result = await restartMac()
      else result = { error: '当前平台不支持重启 Codex 桌面端' }
    } catch (error) {
      result = { error: '重启 Codex 失败', detail: error.message }
    }
    job.state = result.ok ? 'done' : 'failed'
    job.message = [result.message || result.error, result.detail].filter(Boolean).join('：')
    return result
  })()
  return restartStatus()
}

const WINDOWS_RESTART = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Fail-Restart($message) { [Console]::WriteLine($message); exit 1 }
$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (!$package) { Fail-Restart '未找到已安装的 Codex 桌面应用' }
$manifest = Get-AppxPackageManifest -Package $package.PackageFullName
$entry = $manifest.Package.Applications.Application | Where-Object Id -eq 'App' | Select-Object -First 1
if (!$entry.Executable) { Fail-Restart '未找到 Codex 桌面应用入口' }
$binary = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation $entry.Executable))
$processName = [IO.Path]::GetFileNameWithoutExtension($binary)
function Get-CodexDesktop {
  Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and [string]::Equals($_.Path, $binary, [StringComparison]::OrdinalIgnoreCase)
  }
}
$running = @(Get-CodexDesktop)
if ($running.Count -gt 0) {
  $windows = @($running | Where-Object MainWindowHandle -ne 0)
  if ($windows.Count -eq 0) { Fail-Restart 'Codex 桌面端在后台运行，请先从桌面应用菜单正常退出，再点重启' }
  foreach ($window in $windows) { [void]$window.CloseMainWindow() }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (@(Get-CodexDesktop).Count -gt 0) {
    if ([DateTime]::UtcNow -ge $deadline) { Fail-Restart 'Codex 尚未退出，请检查未保存内容或退出提示，然后重试' }
    Start-Sleep -Milliseconds 350
  }
}
$target = 'shell:AppsFolder\' + $package.PackageFamilyName + '!' + $entry.Id
Start-Process $target
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while (@(Get-CodexDesktop | Where-Object MainWindowHandle -ne 0).Count -eq 0) {
  if ([DateTime]::UtcNow -ge $deadline) { Fail-Restart '已请求启动 Codex，但尚未检测到桌面窗口' }
  Start-Sleep -Milliseconds 350
}
`

async function restartWindows() {
  const command = Buffer.from(WINDOWS_RESTART, 'utf16le').toString('base64')
  const result = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', command,
  ], 45000)
  if (result.code !== 0) {
    return { error: 'Codex 桌面端重启未完成', detail: result.stdout.trim().slice(0, 300) || undefined }
  }
  return { ok: true, message: 'Codex 桌面窗口已重新打开，可以重试任务' }
}

async function restartMac() {
  const candidates = macApplications().filter(existsSync)
  if (!candidates.length) return { error: '在 Applications 中找不到 Codex 或 ChatGPT' }
  const apps = await Promise.all(candidates.map(async path => {
    const plist = join(path, 'Contents', 'Info.plist')
    const info = await run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], 5000)
    const executable = info.code === 0 ? info.stdout.trim() : basename(path, '.app')
    return { path, executable: join(path, 'Contents', 'MacOS', executable) }
  }))
  async function commands() {
    const result = await run('/bin/ps', ['-axo', 'comm='], 3000)
    if (result.code !== 0) throw new Error('无法读取 macOS 进程状态')
    return new Set(result.stdout.split('\n').map(line => line.trim()))
  }
  const current = await commands()
  const running = apps.filter(app => current.has(app.executable))
  const app = running[0] || apps[0]
  if (running.length) {
    const quit = await run('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'tell application (item 1 of argv) to quit',
      '-e', 'end run', app.path,
    ], 30000)
    if (quit.code !== 0) return { error: '无法退出桌面端', detail: quit.stderr.trim() }
    const deadline = Date.now() + 15000
    while ((await commands()).has(app.executable)) {
      if (Date.now() >= deadline) return { error: 'Codex 尚未退出，请检查桌面端的退出提示' }
      await new Promise(resolve => setTimeout(resolve, 350))
    }
  }
  const opened = await run('/usr/bin/open', ['-a', app.path], 15000)
  if (opened.code !== 0) return { error: '无法重新打开桌面端', detail: opened.stderr.trim() }
  const deadline = Date.now() + 15000
  while (!(await commands()).has(app.executable)) {
    if (Date.now() >= deadline) return { error: '已请求启动 Codex，但尚未检测到桌面端进程' }
    await new Promise(resolve => setTimeout(resolve, 350))
  }
  return { ok: true, message: '已检测到 Codex 桌面端重新启动，可以重试任务' }
}

const PANEL_JOB_TTL = 60 * 60 * 1000
const FULL_THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function panelJobs() {
  const jobs = new Map()

  function find(thread) {
    const job = jobs.get(thread)
    if (job?.finishedAt && Date.now() - job.finishedAt > PANEL_JOB_TTL) {
      jobs.delete(thread)
      return undefined
    }
    return job
  }

  async function execute(job, thread, message) {
    activePanelTasks++
    try {
      const sqlite = loadSqlite()
      const snapshot = sqlite ? await snapshotDb() : null
      if (!snapshot) throw new Error('找不到 Codex 会话库')
      try {
        const db = new sqlite(snapshot.dbPath, { readOnly: true })
        try {
          if (!db.prepare('SELECT 1 FROM thread_turns WHERE thread_id = ? LIMIT 1').get(thread)) {
            throw new Error('找不到指定的 Codex 会话')
          }
        } finally {
          db.close()
        }
      } finally {
        await cleanupSnapshot(snapshot)
      }

      const result = await ask({ thread, message })
      if (result.error) throw new Error([result.message || result.error, result.detail].filter(Boolean).join('：'))
      job.answer = result.answer
      job.state = 'done'
    } catch (error) {
      job.state = 'failed'
      job.message = error.message
    } finally {
      activePanelTasks--
      job.finishedAt = Date.now()
    }
  }

  return {
    status(thread) {
      return { job: find(thread) || null }
    },
    start({ thread, jobId, message }) {
      if (typeof jobId !== 'string' || !FULL_THREAD_ID.test(jobId)
        || typeof message !== 'string' || !message.trim() || message.length > 16000) {
        return { error: '请输入 1 到 16000 个字符的任务内容' }
      }
      for (const id of jobs.keys()) find(id)
      const current = find(thread)
      if (current?.id === jobId) return { job: current }
      if (current?.state === 'running') return { error: '这个会话已有任务在执行' }
      if (restartJob?.state === 'running') return { error: 'Codex 正在重启，请等重启完成后再发送任务' }

      const job = { id: jobId, state: 'running', startedAt: Date.now() }
      jobs.set(thread, job)
      void execute(job, thread, message.trim())
      return { job }
    },
  }
}

function installPanel(ctx) {
  ctx.inject(['connection'], scope => {
    const endpoint = 'codex-bridge/history'
    const tasks = panelJobs()
    scope.connection.fetch.register({
      path: '/api/' + endpoint,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let envelope
        try {
          envelope = await request.json()
        } catch {
          return new Response(null, { status: 400 })
        }
        const { rpcId, payload } = envelope ?? {}
        if (envelope?.type !== 'client-request' || envelope.method !== endpoint
          || typeof rpcId !== 'string' || !payload || typeof payload !== 'object') {
          return new Response(null, { status: 400 })
        }
        const limit = Number.isInteger(payload.limit) ? Math.max(1, Math.min(payload.limit, 500)) : 50
        let value
        try {
          request.signal.throwIfAborted()
          if (payload.operation === 'restart-status') value = restartStatus()
          else if (payload.operation === 'restart' && typeof payload.jobId === 'string' && FULL_THREAD_ID.test(payload.jobId)) {
            value = startRestart(payload.jobId)
          } else if (payload.operation === 'list') value = await threads({ limit })
          else if (payload.operation === 'read' && typeof payload.thread === 'string') {
            value = await read({ thread: payload.thread, limit })
          } else if (typeof payload.thread === 'string' && FULL_THREAD_ID.test(payload.thread)
            && payload.operation === 'status') {
            value = tasks.status(payload.thread)
          } else if (typeof payload.thread === 'string' && FULL_THREAD_ID.test(payload.thread)
            && payload.operation === 'send') {
            value = tasks.start(payload)
          } else return new Response(null, { status: 400 })
        } catch (error) {
          console.error('codex-bridge/history:', error.message)
          value = { error: '处理 Codex 侧栏请求失败' }
        }
        return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } }, {
          headers: { 'cache-control': 'no-store' },
        })
      },
    })
  })
}

// ---- 注册工具 ----

// 每个工具都声明 output，render 负责把返回值变成模型可见的文本
function textRender(_args, value) {
  return [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }]
}

const JSONISH = {
  type: 'object',
  additionalProperties: true,
}

export function apply(ctx) {
  installPanel(ctx)
  ctx.tools.register({
    name: 'codex_threads',
    description: '列出本机 Codex 桌面版里的会话，按项目（工作目录）分组。'
      + '每项包含会话 id、轮数、最后活动时间、完整的首条消息和项目目录。'
      + '返回的会话可直接用于 codex_read 和 codex_ask。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '最多返回多少个会话，默认 50' },
      },
    },
    output: { schema: JSONISH, render: textRender },
    async execute(args) {
      return await threads({ limit: args?.limit ?? 50 })
    },
  })

  ctx.tools.register({
    name: 'codex_read',
    description: '读取本机某个 Codex 会话的完整对话记录，含你的提问、Codex 的回答和它执行过的命令。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['thread'],
      properties: {
        thread: { type: 'string', description: '会话 id，或 codex_threads 列表里的序号' },
        limit: { type: 'integer', description: '最多显示多少条消息，默认 100' },
      },
    },
    output: { schema: JSONISH, render: textRender },
    async execute(args) {
      return await read({ thread: args?.thread, limit: args?.limit ?? 100 })
    },
  })

  ctx.tools.register({
    name: 'codex_ask',
    description: '在本机已有的 Codex 会话上继续提问，或在没有指定会话时开一个新会话。'
      + '上下文会延续。单次往返可能需要 20 到 60 秒。'
      + '如果目标会话正被 ChatGPT 桌面端占用，会返回 error=thread-busy，此时可用 codex_restart。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        thread: { type: 'string', description: '会话 id 或序号；省略则开新会话' },
        message: { type: 'string', description: '要发送给 Codex 的内容' },
        model: { type: 'string', description: `模型，默认 ${DEFAULT_MODEL}` },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: '权限模式，默认 workspace-write',
        },
      },
    },
    output: { schema: JSONISH, render: textRender },
    async execute(args) {
      return await ask(args || {})
    },
  })

  ctx.tools.register({
    name: 'codex_restart',
    description: '重启 ChatGPT / Codex 桌面端，释放它占用的会话写锁。'
      + '只有确认桌面端任务已经结束并保存草稿后才可调用。'
      + '仅在 codex_ask 返回 thread-busy 且确实需要写入那个会话时使用。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: JSONISH, render: textRender },
    async execute() {
      const result = startRestart(randomUUID())
      return result.error ? result : await restartCompletion
    },
  })
}
