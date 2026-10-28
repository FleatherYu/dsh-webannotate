/**
 * dsh-webannotate — Host half.
 *
 * The desktop app runs this Cordis host in a plain Node child process, so a
 * plugin cannot reach Electron or the `<webview>` guests from here. The Client
 * half (same page as the browser panel) does the injecting. This half owns what
 * only the HTTP server can do:
 *
 *   GET  /dsh-webannotate/overlay.js   the in-page overlay source, re-read from
 *                                      disk on every request so the overlay can
 *                                      be edited without restarting DSH;
 *   POST /dsh-webannotate/report       diagnostics sent by the Client half, kept
 *                                      in a small in-memory ring;
 *   GET  /dsh-webannotate/reports      the ring as JSON (dev loop, no tool call);
 *   POST /dsh-webannotate/batch        the last submitted annotation batch, so a
 *                                      send that fails to reach the chat is still
 *                                      readable by the agent;
 *   tool  webannotate_status           returns the ring + overlay metadata.
 *
 * Everything is read-only for the user's project: no build step, no dependency.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const name = 'dsh-webannotate'
export const inject = ['webServer', 'tools']

const here = dirname(fileURLToPath(import.meta.url))
const OVERLAY_PATH = resolve(here, 'web/overlay.js')
const RING_LIMIT = 80
const BODY_LIMIT = 512 * 1024

/** Shared across plugin reloads so HMR does not drop collected evidence. */
const HUB = Symbol.for('dsh-webannotate.hub')

function hub() {
  if (!globalThis[HUB]) {
    globalThis[HUB] = { reports: [], batches: [], listeners: new Set(), routes: [], installed: false }
  }
  // The singleton outlives an edit that adds a field; tolerate an older shape.
  const state = globalThis[HUB]
  if (!Array.isArray(state.routes)) state.routes = []
  if (!Array.isArray(state.reports)) state.reports = []
  if (!Array.isArray(state.batches)) state.batches = []
  if (!(state.listeners instanceof Set)) state.listeners = new Set()
  return state
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        rejectBody(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function remember(entry) {
  const state = hub()
  entry.at = entry.at || Date.now()
  state.reports.push(entry)
  if (state.reports.length > RING_LIMIT) state.reports.splice(0, state.reports.length - RING_LIMIT)
  for (const listener of Array.from(state.listeners)) {
    try {
      listener(entry)
    } catch {
      /* one broken listener must not stop the sink */
    }
  }
}

export function apply(ctx) {
  const state = hub()
  const webServer = ctx.get('webServer')
  if (!webServer) return

  // Routes are replaced on every activation: dropping the previous batch keeps
  // this file editable, and the Client half simply retries a failed poll.
  const dropRoutes = () => {
    for (const dispose of state.routes.splice(0)) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
  }
  dropRoutes()
  ctx.effect(() => dropRoutes)

  const route = (definition) => {
    try {
      const dispose = webServer.register(definition)
      state.routes.push(dispose)
    } catch (error) {
      // A route left behind by an earlier activation (registered before routes
      // were tracked) keeps serving the file from disk, so a duplicate is not
      // fatal: record it and keep the rest of the plugin alive.
      remember({ kind: 'route', payload: { path: definition.path, error: error && error.message ? error.message : String(error) } })
    }
  }
  state.installed = true

  route({
    kind: 'exact',
    path: '/dsh-webannotate/overlay.js',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        plain(res, 405, 'method not allowed')
        return
      }
      try {
        const source = await readFile(OVERLAY_PATH, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store, must-revalidate',
          'content-length': Buffer.byteLength(source),
        })
        res.end(req.method === 'HEAD' ? undefined : source)
      } catch (error) {
        plain(res, 500, `overlay unavailable: ${error && error.message ? error.message : error}`)
      }
    },
  })

  route({
    kind: 'exact',
    path: '/dsh-webannotate/graph',
    handler: (req, res) => {
      try {
        const clientModules = ctx.get('clientModules')
        const graph = clientModules && typeof clientModules.graph === 'function' ? clientModules.graph() : null
        const ids = []
        const visit = (node) => {
          if (!node) return
          if (typeof node === 'string') {
            ids.push(node)
            return
          }
          if (Array.isArray(node)) {
            for (const item of node) visit(item)
            return
          }
          if (typeof node === 'object') {
            if (typeof node.id === 'string' || typeof node.name === 'string') ids.push(node.id || node.name)
            for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value)
          }
        }
        visit(graph)
        let injections = null
        try {
          injections = typeof webServer.collectIndexInjections === 'function' ? webServer.collectIndexInjections() : null
        } catch (error) {
          injections = { error: error && error.message ? error.message : String(error) }
        }
        sendJson(res, 200, {
          hasClientModules: Boolean(clientModules),
          composedKeys: clientModules && clientModules.composed ? Object.keys(clientModules.composed).slice(0, 40) : null,
          sources: Object.keys((clientModules && clientModules.sources) || {}),
          injections,
          mentionsSelf: ids.filter((id) => /webannotate|notify/u.test(id)),
          ids: Array.from(new Set(ids)).slice(0, 60),
        })
      } catch (error) {
        sendJson(res, 200, { error: error && error.message ? error.message : String(error) })
      }
    },
  })

  route({
    kind: 'exact',
    path: '/dsh-webannotate/report',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        plain(res, 405, 'method not allowed')
        return
      }
      try {
        const raw = await readBody(req)
        let payload = null
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = { raw: raw.slice(0, 2000) }
        }
        remember({ kind: 'report', payload })
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  })

  route({
    kind: 'exact',
    path: '/dsh-webannotate/status',
    handler: (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), RING_LIMIT)
      sendJson(res, 200, { installed: state.installed, reports: state.reports.slice(-limit) })
    },
  })

  route({
    kind: 'exact',
    path: '/dsh-webannotate/batch',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        plain(res, 405, 'method not allowed')
        return
      }
      try {
        const raw = await readBody(req)
        const payload = JSON.parse(raw)
        state.batches.push({ at: Date.now(), batch: payload })
        if (state.batches.length > 20) state.batches.splice(0, state.batches.length - 20)
        remember({
          kind: 'batch',
          payload: { url: payload && payload.url, items: payload && payload.items && payload.items.length },
        })
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  })

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'webannotate_status',
        description:
          'Read what dsh-webannotate is doing inside the GUI: overlay metadata, the latest diagnostics reported by the Client half, and the most recent annotation batch sent from a page. Use it when annotations do not arrive in the chat.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'How many recent reports to return (default 20, max 80).' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async (args) => {
          const limit = Math.min(Math.max(Number(args && args.limit) || 20, 1), RING_LIMIT)
          let overlay = null
          try {
            const source = await readFile(OVERLAY_PATH, 'utf8')
            overlay = { path: OVERLAY_PATH, bytes: Buffer.byteLength(source) }
          } catch (error) {
            overlay = { path: OVERLAY_PATH, error: error && error.message ? error.message : String(error) }
          }
          return { overlay, reports: state.reports.slice(-limit), batches: state.batches.slice(-3), installed: state.installed }
        },
      }),
    'dsh-webannotate: status tool',
  )

  remember({ kind: 'host', payload: { event: 'applied', pid: process.pid } })
}
