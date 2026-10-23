// Web UI for ddj200-decks.pd. No dependencies: `node ddj-web/server.mjs`, then open http://localhost:9011
// Starts Pd without a window (--gui keeps the window, --no-pd connects to a Pd you started yourself).
// Talks to [ddj-web] over TCP (FUDI) on port 9010, and to the page over SSE + POST.
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFile, readdir, writeFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PD_PORT = +process.env.PD_PORT || 9010
const WEB_PORT = +process.env.WEB_PORT || 9011
const PD_BIN = process.env.PD_BIN || '/usr/local/bin/pd'
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const page = join(repo, 'ddj-web', 'index.html')
const folderFile = join(homedir(), '.ddj-web-folder')

let pdProc = null
if (!process.argv.includes('--no-pd')) {
  const args = process.argv.includes('--gui') ? ['ddj200-decks.pd'] : ['-nogui', 'ddj200-decks.pd']
  pdProc = spawn(PD_BIN, args, { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] })
  pdProc.on('exit', (code) => { console.log(`Pd exited (${code})`); pdProc = null })
}
const quit = () => { pdProc?.kill(); process.exit() }
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

// state: everything [ddj-web] reports, as key -> values (e.g. 'd1-pos' -> [0.42]); songs come separately
let pd = null
let songs = []
let state = {}
let seen = {}
const clients = new Set()
const event = (msg) => `data: ${JSON.stringify(msg)}\n\n`
const broadcast = (msg) => { for (const c of clients) c.write(event(msg)) }
const num = (a) => (a !== '' && !isNaN(a) ? +a : a)

function setKey(key, values) {
  const json = JSON.stringify(values)
  if (seen[key] === json) return
  seen[key] = json
  state[key] = values
  broadcast({ k: key, v: values })
}

function handle([key, ...v]) {
  if (key === 'clear') songs = []
  else if (key === 'song') songs[+v[0]] = v[1] ?? ''
  else if (key === 'done') broadcast({ songs })
  else if (key) setKey(key, v.map(num))
}

// FUDI: messages end with an unescaped ';', atoms split on unescaped whitespace, '\' escapes the next char
let buf = ''
function takeMessages() {
  const out = []
  let atoms = [], cur = '', esc = false, start = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (esc) { cur += c; esc = false }
    else if (c === '\\') esc = true
    else if (c === ';') { if (cur) atoms.push(cur); out.push(atoms); atoms = []; cur = ''; start = i + 1 }
    else if (/\s/.test(c)) { if (cur) atoms.push(cur); cur = '' }
    else cur += c
  }
  buf = buf.slice(start)
  return out
}
const escape = (s) => s.replace(/[\\;,$\s]/g, (m) => '\\' + m)
const toPd = (msg) => pd?.write(msg + ';\n')

function connectPd() {
  const s = net.connect(PD_PORT, '127.0.0.1')
  s.setEncoding('utf8')
  s.on('connect', async () => {
    pd = s
    console.log('Pd connected')
    setKey('pd', [1])
    const folder = await readFile(folderFile, 'utf8').catch(() => '')
    if (folder) toPd(`web-browser folder ${escape(folder)}`)
    toPd('web-browser hello')
  })
  s.on('data', (d) => { buf += d; takeMessages().forEach(handle) })
  s.on('error', () => {})
  s.on('close', () => {
    if (pd === s) {
      pd = null
      songs = []; state = {}; seen = {}
      broadcast({ songs })
      setKey('pd', [0])
      console.log('Pd disconnected, retrying')
    }
    buf = ''
    setTimeout(connectPd, 300)
  })
}
connectPd()

// the page may only send what the controller could send
const allowed = [
  /^d[12]-(play|cue|sync|eject|hotcue-on|hotcue-off|pad-up|padmode|seek-to|pfl)( -?[\d.]+)?$/,
  /^(master-crossfader|master-trfx|master-headmix|lights-mode)( -?[\d.]+)$/,
  /^ddj-calibrate$/,
  /^web-browser (select \d+|load [12] \d+)$/,
]

async function readBody(req) {
  let body = ''
  for await (const c of req) body += c
  return body
}

// the folder browser stays inside your home folder
const home = homedir()
async function inHome(path) {
  const real = await realpath(path)
  if (real !== home && !real.startsWith(home + sep)) throw new Error('outside home')
  return real
}

async function listDirs(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  const audio = entries.filter((e) => e.isFile() && /\.(wav|aiff?)$/i.test(e.name)).length
  return { path, parent: path === home ? path : dirname(path), dirs: dirs.sort((a, b) => a.localeCompare(b)), audio }
}

// only this Mac or a device on the Wi-Fi using its address: refuse other websites (cross-site requests, DNS rebinding)
const hostOk = (host = '') => /^(localhost|127\.0\.0\.1|\[::1\]|\d+\.\d+\.\d+\.\d+|[\w-]+\.local)(:\d+)?$/.test(host)
const originOk = (req) => {
  const o = req.headers.origin
  if (!o) return true
  try { return new URL(o).host === req.headers.host } catch { return false }  // e.g. "Origin: null" from a sandboxed page
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const json = (code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data))
  if (!hostOk(req.headers.host) || (req.method === 'POST' && !originOk(req))) return res.writeHead(403).end()
  try {
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(event({ songs }) + event({ state: { ...state, pd: [pd ? 1 : 0] } }))
      clients.add(res)
      req.on('close', () => clients.delete(res))
    } else if (req.method === 'POST' && url.pathname === '/cmd') {
      const body = (await readBody(req)).trim()
      const ok = pd && allowed.some((re) => re.test(body))
      if (ok) toPd(body)
      res.writeHead(ok ? 204 : 400).end()
    } else if (req.method === 'POST' && url.pathname === '/folder') {
      const path = await inHome((await readBody(req)).trim())
      if (!pd) return json(400, { error: 'Pd not connected' })
      toPd(`web-browser folder ${escape(path)}`)
      await writeFile(folderFile, path)
      json(200, { ok: true })
    } else if (url.pathname === '/dirs') {
      const saved = await readFile(folderFile, 'utf8').catch(() => '')
      json(200, await listDirs(await inHome(url.searchParams.get('path') || saved || join(home, 'Music'))))
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(page))
    }
  } catch (err) {
    json(404, { error: 'not found' })
  }
}).listen(WEB_PORT, () => console.log(`DJ page on http://localhost:${WEB_PORT}`))
