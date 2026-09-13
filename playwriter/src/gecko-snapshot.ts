import type { Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage, type ICDPSession } from './cdp-session.js'

type AxLine = { role: string; name: string; ref?: string; value?: string; indent: number }
type RawAxNode = { id: number; role: string; name: string; ref?: string; parent?: number; children: number[] }
type RefInfo = { attributes: string[]; box: { x: number; y: number; width: number; height: number } | null; scope: string | null }

const STABLE_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-pw', 'data-qa', 'data-e2e', 'data-automation-id', 'id', 'contenteditable']
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'])
const LINE_RE = /^([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/

const unquote = (text: string) => {
  return text.startsWith('"') ? (JSON.parse(text) as string) : text
}

export function parseAiSnapshot(raw: string): RawAxNode[] {
  const lines = raw.split('\n').flatMap((line): AxLine[] => {
    const match = line.match(/^(\s*)- (.*)$/)
    if (!match || match[2].startsWith('/')) {
      return []
    }
    const indent = match[1].length / 2
    const body = match[2]
    if (body.startsWith('text: ')) {
      return [{ role: 'statictext', name: unquote(body.slice(6)), indent }]
    }
    const parts = body.match(LINE_RE)
    if (!parts) {
      return []
    }
    const ref = parts[3]?.match(/\[ref=([^\]]+)\]/)?.[1]
    return [{ role: parts[1], name: parts[2] ? unquote(parts[2]) : '', ref, value: parts[4] ? unquote(parts[4]) : undefined, indent }]
  })

  const nodes: RawAxNode[] = [{ id: 0, role: 'rootwebarea', name: '', children: [] }]
  const stack: Array<{ id: number; indent: number }> = [{ id: 0, indent: -1 }]
  const add = (node: Omit<RawAxNode, 'id' | 'children'>) => {
    const id = nodes.length
    nodes.push({ ...node, id, children: [] })
    nodes[node.parent!].children.push(id)
    return id
  }
  for (const line of lines) {
    while (stack[stack.length - 1].indent >= line.indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1].id
    const id = add({ role: line.role, name: line.name, ref: line.ref, parent })
    if (line.value && !VALUE_ROLES.has(line.role)) {
      add({ role: 'statictext', name: line.value, parent: id })
    }
    stack.push({ id, indent: line.indent })
  }
  const topLevel = nodes[0].children
  const onlyChild = topLevel.length === 1 ? nodes[topLevel[0]] : null
  if (onlyChild?.role === 'generic' && !onlyChild.name) {
    nodes[0].children = onlyChild.children
    onlyChild.children.forEach((child) => {
      nodes[child].parent = 0
    })
    onlyChild.children = []
    onlyChild.parent = undefined
  }
  return nodes
}

export function isGeckoPage(page: Page): boolean {
  return page.context().browser()?.browserType().name() === 'firefox'
}

class GeckoSnapshotSession {
  private nodes: RawAxNode[] = []
  private infos = new Map<number, RefInfo>()
  private scopeNodeId: number | null = null
  private scopeValue: string | null = null

  constructor(private page: Page) {}

  private async load() {
    this.nodes = parseAiSnapshot((await (this.page as Page & { _snapshotForAI(): Promise<{ full: string }> })._snapshotForAI()).full)
    const withRefs = this.nodes.filter((node) => {
      return node.ref
    })
    const infos = await Promise.all(
      withRefs.map((node) => {
        return this.page
          .locator(`aria-ref=${node.ref}`)
          .evaluate((element, attrNames) => {
            const rect = element.getBoundingClientRect()
            const view = element.ownerDocument.defaultView
            return {
              attributes: attrNames.flatMap((attr) => {
                const value = element.getAttribute(attr)
                return value === null ? [] : [attr, value]
              }),
              box: { x: rect.x + (view?.scrollX ?? 0), y: rect.y + (view?.scrollY ?? 0), width: rect.width, height: rect.height },
              scope: element.closest('[data-pw-scope]')?.getAttribute('data-pw-scope') ?? null,
            }
          }, STABLE_ATTRS)
          .catch((): RefInfo => {
            return { attributes: [], box: null, scope: null }
          })
      }),
    )
    withRefs.forEach((node, index) => {
      this.infos.set(node.id, infos[index])
    })
    this.scopeValue = infos.find((info) => {
      return info.scope
    })?.scope ?? null
    const inScope = withRefs.filter((_, index) => {
      return infos[index].scope
    })
    this.scopeNodeId = inScope.length ? this.lowestCommonAncestor(inScope.map((node) => {
      return node.id
    })) : null
  }

  private lowestCommonAncestor(ids: number[]): number {
    const chain = (id: number) => {
      const result: number[] = []
      for (let current: number | undefined = id; current !== undefined; current = this.nodes[current].parent) {
        result.unshift(current)
      }
      return result
    }
    const chains = ids.map(chain)
    let depth = 0
    while (chains.every((c) => {
      return c[depth] !== undefined && c[depth] === chains[0][depth]
    })) {
      depth++
    }
    return chains[0][depth - 1]
  }

  private async frameRoot(frameId: string): Promise<number> {
    const iframes = this.nodes.filter((n) => {
      return n.role === 'iframe' && n.ref
    })
    for (const node of iframes) {
      const handle = await this.page.locator(`aria-ref=${node.ref}`).elementHandle().catch(() => {
        return null
      })
      const frame = await handle?.contentFrame()
      if (frame && (frame as typeof frame & { frameId(): string }).frameId() === frameId) {
        return node.id
      }
    }
    throw new Error(`Frame ${frameId} not found in snapshot`)
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'DOM.enable':
      case 'Accessibility.enable':
        return {}
      case 'Target.getTargets':
        return { targetInfos: [] }
      case 'DOM.getFlattenedDocument': {
        await this.load()
        const nodes = this.nodes.map((node) => {
          const attributes = [...(this.infos.get(node.id)?.attributes ?? [])]
          if (node.id === this.scopeNodeId && this.scopeValue) {
            attributes.push('data-pw-scope', this.scopeValue)
          }
          return { nodeId: node.id + 1, parentId: node.parent === undefined ? undefined : node.parent + 1, backendNodeId: node.id + 1, nodeName: node.role, attributes }
        })
        return { nodes }
      }
      case 'Accessibility.getFullAXTree': {
        if (!this.nodes.length) {
          await this.load()
        }
        const frameId = params?.frameId as string | undefined
        const rootChildren = frameId ? this.nodes[await this.frameRoot(frameId)].children : this.nodes[0].children
        const nodes = this.nodes.map((node) => {
          return {
            nodeId: String(node.id + 1),
            ignored: false,
            role: { type: 'role', value: node.role },
            name: { type: 'computedString', value: node.name },
            childIds: (node.id === 0 ? rootChildren : node.role === 'iframe' ? [] : node.children).map((child) => {
              return String(child + 1)
            }),
            backendDOMNodeId: node.id + 1,
          }
        })
        return { nodes }
      }
      case 'DOM.getBoxModel': {
        const box = this.infos.get((params?.backendNodeId as number) - 1)?.box
        if (!box) {
          throw new Error('No box for node')
        }
        const { x, y, width, height } = box
        const quad = [x, y, x + width, y, x + width, y + height, x, y + height]
        return { model: { border: quad, content: quad, padding: quad, margin: quad, width, height } }
      }
      default:
        throw new Error(`${method} is not available in Firefox mode (CDP only)`)
    }
  }

  on() {
    return this
  }

  off() {
    return this
  }

  async detach() {}
}

export async function getSnapshotSession({ page }: { page: Page }): Promise<ICDPSession> {
  if (isGeckoPage(page)) {
    return new GeckoSnapshotSession(page) as unknown as ICDPSession
  }
  return getCDPSessionForPage({ page })
}
