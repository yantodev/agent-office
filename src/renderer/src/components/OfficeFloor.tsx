import { useEffect, useRef, useState } from 'react'
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import workstationUrl from '../assets/office-workstation.svg?url'

type OfficeFloorProps = {
  agents: Agent[]
  projectId?: string
  onSelect: (id: string) => void
}

type Point = { x: number; y: number }
type OfficeStatus = Agent['status'] | 'blocked' | 'reviewing' | 'done' | 'failed'

type Actor = {
  node: Container
  body: Graphics
  leftArm: Graphics
  rightArm: Graphics
  leftLeg: Graphics
  rightLeg: Graphics
  eyes: Graphics
  light: Graphics
  start: Point
  destination: Point
  status: OfficeStatus
  phase: number
}

type Envelope = { node: Container; from: Point; to: Point; phase: number; speed: number }

const colors = {
  floorA: 0x0b1728,
  floorB: 0x102238,
  line: 0x1b3551,
  panel: 0x0b1627,
  desk: 0x152943,
  deskEdge: 0x28425e,
  text: 0xdbeafe,
  muted: 0x7890aa,
  cyan: 0x38bdf8,
  green: 0x4ade80,
  yellow: 0xfacc15,
  red: 0xf87171,
  purple: 0xc084fc,
  skin: 0xf2b28d,
  hair: 0x263449,
}

function pixel(parent: Container, x: number, y: number, width: number, height: number, color: number, alpha = 1) {
  const shape = new Graphics().rect(x, y, width, height).fill({ color, alpha })
  parent.addChild(shape)
  return shape
}

function colorForStatus(status: OfficeStatus) {
  if (status === 'working') return colors.green
  if (status === 'error' || status === 'failed') return colors.red
  if (status === 'paused' || status === 'blocked') return colors.yellow
  if (status === 'reviewing') return colors.purple
  if (status === 'done') return colors.cyan
  if (status === 'offline') return 0x475569
  return colors.muted
}

function statusForAgent(agent: Agent, tasks: Task[]) {
  const activeTask = tasks.find(task => task.agentId === agent.id && ['running', 'blocked', 'review'].includes(task.status))
  if (activeTask?.status === 'running') return 'working' as OfficeStatus
  if (activeTask?.status === 'blocked') return 'blocked' as OfficeStatus
  if (activeTask?.status === 'review') return 'reviewing' as OfficeStatus
  return agent.status as OfficeStatus
}

function label(parent: Container, text: string, x: number, y: number, color = colors.muted, fontSize = 10, weight: 'normal' | 'bold' = 'normal') {
  const value = new Text({ text, style: { fill: color, fontSize, fontFamily: 'Inter, sans-serif', fontWeight: weight } })
  value.position.set(x, y)
  parent.addChild(value)
  return value
}

function drawCharacter(parent: Container, accent: number, status: OfficeStatus, start: Point, destination: Point, phase: number): Actor {
  const node = new Container()
  node.eventMode = 'static'
  node.cursor = 'pointer'
  parent.addChild(node)

  // Karakter tersusun dari kotak-kotak kecil supaya tetap terlihat seperti pixel-art.
  pixel(node, -13, 25, 26, 4, 0x050b14, 0.7)
  const leftLeg = pixel(node, -9, 13, 6, 13, colors.deskEdge)
  const rightLeg = pixel(node, 3, 13, 6, 13, colors.deskEdge)
  const body = pixel(node, -11, -5, 22, 20, accent)
  pixel(node, -5, -8, 10, 4, colors.skin)
  pixel(node, -10, -22, 20, 15, colors.skin)
  pixel(node, -11, -24, 22, 5, colors.hair)
  pixel(node, -13, -21, 4, 9, colors.hair)
  pixel(node, 5, -21, 4, 7, colors.hair)
  const eyes = pixel(node, -6, -15, 3, 3, 0x07111f)
  pixel(node, 3, -15, 3, 3, 0x07111f)
  const leftArm = pixel(node, -17, -2, 6, 15, colors.skin)
  const rightArm = pixel(node, 11, -2, 6, 15, colors.skin)
  pixel(node, -3, 0, 6, 4, colors.text, 0.45)
  const light = pixel(node, 13, -25, 5, 5, accent)

  return { node, body, leftArm, rightArm, leftLeg, rightLeg, eyes, light, start, destination, status, phase }
}

function drawEnvelope(parent: Container) {
  const envelope = new Container()
  envelope.addChild(new Graphics().rect(-10, -7, 20, 14).fill(colors.cyan).stroke({ color: 0x082f49, width: 2 }))
  envelope.addChild(new Graphics().moveTo(-8, -5).lineTo(0, 1).lineTo(8, -5).stroke({ color: 0x082f49, width: 2 }))
  parent.addChild(envelope)
  return envelope
}

function drawPlant(parent: Container, x: number, y: number) {
  pixel(parent, x, y + 14, 18, 10, 0x854d0e)
  pixel(parent, x + 3, y + 10, 12, 5, 0xa16207)
  pixel(parent, x + 7, y, 5, 13, 0x16a34a)
  pixel(parent, x + 1, y + 3, 7, 5, 0x22c55e)
  pixel(parent, x + 11, y + 5, 7, 5, 0x15803d)
}

function drawCoffee(parent: Container, x: number, y: number) {
  pixel(parent, x, y, 24, 25, 0x475569)
  pixel(parent, x + 4, y + 4, 16, 8, 0x0f172a)
  pixel(parent, x + 8, y + 13, 8, 5, colors.cyan)
  pixel(parent, x + 9, y + 22, 6, 4, 0x92400e)
}

function drawVectorFurniture(parent: Container, x: number, y: number, width: number, accent: number) {
  // Fallback deterministik jika browser gagal mendekode sprite SVG.
  pixel(parent, x + 3, y + 22, width - 6, 4, 0x8b5e3c)
  pixel(parent, x + 8, y + 26, 4, 10, 0x5b3a29)
  pixel(parent, x + width - 12, y + 26, 4, 10, 0x5b3a29)
  pixel(parent, x + width - 48, y + 1, 27, 18, 0x334155)
  pixel(parent, x + width - 44, y + 5, 19, 10, 0x0b1728)
  pixel(parent, x + width - 40, y + 8, 8, 2, accent)
  pixel(parent, x + width - 41, y + 22, 7, 4, 0x475569)
  pixel(parent, x + width - 50, y + 26, 25, 3, 0x64748b)
  pixel(parent, x + width - 78, y + 28, 22, 6, 0x64748b)
  pixel(parent, x + width - 73, y + 30, 13, 2, colors.text)
  pixel(parent, x + width - 18, y + 17, 11, 17, 0x475569)
  pixel(parent, x + width - 15, y + 20, 5, 2, colors.green)
  pixel(parent, x + 8, y + 2, 4, 21, colors.yellow)
  pixel(parent, x + 3, y, 15, 5, 0xfde68a)
}

function addWorkstationSprite(parent: Container, texture: Texture | undefined, x: number, y: number, scale = 1) {
  if (!texture) return
  const sprite = new Sprite({ texture })
  sprite.position.set(x, y)
  sprite.scale.set(scale)
  sprite.roundPixels = true
  parent.addChild(sprite)
}

export function OfficeFloor({ agents, projectId, onSelect }: OfficeFloorProps) {
  const host = useRef<HTMLDivElement>(null)
  const onSelectRef = useRef(onSelect)
  const [fallback, setFallback] = useState(false)
  onSelectRef.current = onSelect

  useEffect(() => {
    let cancelled = false
    let initialized = false
    let application: Application | undefined
    let resizeObserver: ResizeObserver | undefined
    let animation: ((ticker: { deltaMS: number }) => void) | undefined

    const boot = async () => {
      let messages: Message[] = []
      let tasks: Task[] = []
      try {
        if (projectId) [messages, tasks] = await Promise.all([window.office.listMessages(projectId), window.office.listTasks(projectId)])
      } catch {
        // Data API yang gagal tidak boleh mengaktifkan fallback Pixi.
        // Lantai tetap dapat digambar dengan status agent terakhir yang tersedia.
      }
      if (cancelled || !host.current) return

      let nextApplication: Application | undefined
      try {
        nextApplication = new Application()
        await nextApplication.init({
          antialias: false,
          backgroundColor: colors.floorA,
          preference: 'webgl',
          resizeTo: host.current,
        })
        if (cancelled || !host.current) {
          nextApplication.destroy({ removeView: true }, { children: true, texture: true, textureSource: true })
          return
        }

        application = nextApplication
        initialized = true
        let workstationTexture: Texture | undefined
        try {
          workstationTexture = await Assets.load(workstationUrl) as Texture
        } catch {
          // Bentuk Graphics di bawah tetap menjaga furniture terlihat tanpa asset.
        }
        setFallback(false)
        host.current.replaceChildren(nextApplication.canvas)

        const root = new Container()
        const office = new Container()
        const actorsLayer = new Container()
        const messagesLayer = new Container()
        root.addChild(office, actorsLayer, messagesLayer)
        nextApplication.stage.addChild(root)

        const actors: Actor[] = []
        const envelopes: Envelope[] = []
        const positions = new Map<string, Point>()
        let clock: Text | undefined
        let lastSecond = -1

        const render = () => {
          if (!application || !host.current) return
          const width = Math.max(host.current.clientWidth, 560)
          const height = Math.max(host.current.clientHeight, 380)
          if (application.renderer.width !== width || application.renderer.height !== height) application.renderer.resize(width, height)
          office.removeChildren().forEach(child => child.destroy({ children: true }))
          actorsLayer.removeChildren().forEach(child => child.destroy({ children: true }))
          messagesLayer.removeChildren().forEach(child => child.destroy({ children: true }))
          actors.length = 0
          envelopes.length = 0
          positions.clear()

          const background = new Graphics().rect(0, 0, width, height).fill(colors.floorA)
          office.addChild(background)
          for (let y = 0; y < height; y += 24) {
            for (let x = 0; x < width; x += 24) {
              office.addChild(new Graphics().rect(x, y, 23, 23).fill({ color: (x / 24 + y / 24) % 2 === 0 ? colors.floorA : colors.floorB, alpha: 0.72 }).stroke({ color: colors.line, width: 1 }))
            }
          }

          label(office, `LIVE OFFICE  //  ${agents.length} WORKER${agents.length === 1 ? '' : 'S'} ONLINE`, 16, 10, colors.text, 11, 'bold')
          clock = label(office, '', width - 74, 10, colors.cyan, 9, 'bold')
          pixel(office, 16, 27, width - 32, 2, colors.cyan, 0.4)
          pixel(office, width - 34, 25, 18, 6, colors.green)

          const reviewHub = { x: width * 0.5, y: 31 }
          pixel(office, reviewHub.x - 52, 28, 104, 8, 0x281b46)
          pixel(office, reviewHub.x - 35, 30, 9, 4, colors.purple)
          pixel(office, reviewHub.x - 18, 30, 9, 4, colors.purple)
          pixel(office, reviewHub.x - 1, 30, 9, 4, colors.purple)
          label(office, 'REVIEW HUB', reviewHub.x - 35, 18, colors.purple, 8, 'bold')
          drawPlant(office, width - 38, height - 42)
          drawCoffee(office, 26, height - 57)

          const columns = width >= 720 ? 3 : 2
          const rows = Math.max(1, Math.ceil(Math.max(agents.length, 1) / columns))
          const stationY = height - 70
          const gap = 10
          const cardWidth = Math.max(180, (width - 32 - gap * (columns - 1)) / columns)
          const cardHeight = Math.max(88, Math.min(126, (stationY - 34 - gap * (rows - 1)) / rows))
          const stations = ['TERMINAL', 'MAILBOX', 'REVIEW', 'GIT WORKFLOW', 'FILE SHELF', 'MISSION CONTROL']

          agents.forEach((agent, index) => {
            const column = index % columns
            const row = Math.floor(index / columns)
            const x = 16 + column * (cardWidth + gap)
            const y = 34 + row * (cardHeight + gap)
            const status = statusForAgent(agent, tasks)
            const accent = colorForStatus(status)
            const card = new Container()
            card.position.set(x, y)
            card.eventMode = 'static'
            card.cursor = 'pointer'
            const shell = new Graphics().rect(0, 0, cardWidth, cardHeight).fill({ color: colors.panel, alpha: 0.96 }).stroke({ color: colors.line, width: 1 })
            card.addChild(shell)
            card.on('pointertap', () => onSelectRef.current(agent.id))
            card.on('pointerover', () => { shell.tint = colors.cyan })
            card.on('pointerout', () => { shell.tint = 0xffffff })
            label(card, agent.name, 12, 10, colors.text, 11, 'bold')
            label(card, `${status.toUpperCase()}${agent.dirty ? ' · CHANGES' : ''}`, 12, 26, accent, 8, 'bold')
            label(card, agent.role || stations[index], 12, cardHeight - 18, colors.muted, 8)
            card.addChild(new Graphics().rect(9, 42, cardWidth - 18, cardHeight - 55).fill({ color: colors.desk, alpha: 0.92 }).stroke({ color: colors.deskEdge, width: 1 }))
            const furnitureY = cardHeight - 48
            const furnitureGroup = new Container()
            furnitureGroup.label = 'furniture-group'
            furnitureGroup.position.set(0, 0)
            card.addChild(furnitureGroup)
            if (workstationTexture) {
              // Satu texture composite menjaga semua furniture menyatu secara visual.
              addWorkstationSprite(furnitureGroup, workstationTexture, 8, furnitureY - 9, 0.82)
            } else {
              drawVectorFurniture(furnitureGroup, 9, furnitureY, cardWidth - 18, accent)
            }
            office.addChild(card)

            const start = { x: x + cardWidth * 0.36, y: y + cardHeight * 0.67 }
            const destination = status === 'reviewing' ? reviewHub : start
            positions.set(agent.id, start)
            const actor = drawCharacter(actorsLayer, accent, status, start, destination, index * 0.85)
            actor.node.on('pointertap', () => onSelectRef.current(agent.id))
            actors.push(actor)
          })

          const stationWidth = Math.min(160, Math.max(120, (width - 64) / 4))
          ;['TERMINAL', 'MAILBOX', 'REVIEW', 'GIT WORKFLOW'].forEach((station, index) => {
            const x = 16 + index * (stationWidth + gap)
            const stationPanel = new Graphics().rect(x, stationY, stationWidth, 44).fill({ color: colors.panel, alpha: 0.98 }).stroke({ color: colors.line, width: 1 })
            office.addChild(stationPanel)
            label(office, station, x + 10, stationY + 16, index === 2 ? colors.purple : colors.cyan, 9, 'bold')
          })

          messages.filter(message => ['pending', 'delivered', 'read'].includes(message.status)).slice(0, 6).forEach((message, index) => {
            const from = positions.get(message.fromAgent)
            const to = positions.get(message.toAgent)
            if (!from || !to || message.fromAgent === message.toAgent) return
            messagesLayer.addChild(new Graphics().moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ color: colors.cyan, width: 1, alpha: 0.28 }))
            envelopes.push({ node: drawEnvelope(messagesLayer), from, to, phase: index / 6, speed: 0.0003 + index * 0.00004 })
          })
        }

        render()
        animation = ticker => {
          const now = performance.now()
          const second = Math.floor(now / 1000)
          if (second !== lastSecond) {
            lastSecond = second
            if (clock) clock.text = new Date().toLocaleTimeString([], { hour12: false })
          }
          actors.forEach(actor => {
            const walking = actor.status === 'reviewing'
            const walk = walking ? (Math.sin(now * 0.0011 + actor.phase) + 1) / 2 : 0
            actor.node.x = actor.start.x + (actor.destination.x - actor.start.x) * walk
            actor.node.y = actor.start.y + (actor.destination.y - actor.start.y) * walk + Math.sin(now * 0.002 + actor.phase) * (walking ? 1 : 0.6)
            actor.node.scale.y = 1 + Math.sin(now * 0.003 + actor.phase) * 0.025
            actor.leftLeg.y = walking ? Math.sin(now * 0.012 + actor.phase) * 3 : 13
            actor.rightLeg.y = walking ? Math.sin(now * 0.012 + actor.phase + Math.PI) * 3 : 13
            actor.leftArm.y = actor.status === 'working' ? -2 + Math.sin(now * 0.016 + actor.phase) * 2 : -2
            actor.rightArm.y = actor.status === 'working' ? -2 + Math.sin(now * 0.016 + actor.phase + Math.PI) * 2 : -2
            actor.eyes.visible = Math.sin(now * 0.001 + actor.phase) > -0.96
            actor.light.alpha = actor.status === 'blocked' || actor.status === 'error' ? 0.55 + Math.sin(now * 0.006) * 0.45 : 1
            actor.light.scale.set(actor.status === 'blocked' || actor.status === 'reviewing' ? 1 + Math.sin(now * 0.004) * 0.25 : 1)
            actor.body.alpha = actor.status === 'paused' || actor.status === 'offline' ? 0.55 : 1
          })
          envelopes.forEach(envelope => {
            const progress = (now * envelope.speed + envelope.phase) % 1
            const arc = Math.sin(progress * Math.PI) * 8
            envelope.node.position.set(
              envelope.from.x + (envelope.to.x - envelope.from.x) * progress,
              envelope.from.y + (envelope.to.y - envelope.from.y) * progress - arc,
            )
            envelope.node.alpha = progress < 0.08 || progress > 0.92 ? Math.min(1, progress * 8, (1 - progress) * 8) : 1
          })
          void ticker
        }
        nextApplication.ticker.add(animation)
        resizeObserver = new ResizeObserver(render)
        resizeObserver.observe(host.current)
      } catch {
        if (!cancelled) {
          nextApplication?.destroy({ removeView: true }, { children: true, texture: true, textureSource: true })
          if (initialized) application?.destroy({ removeView: true }, { children: true, texture: true, textureSource: true })
          setFallback(true)
        }
      }
    }

    void boot()
    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      if (application && animation) application.ticker.remove(animation)
      if (initialized) application?.destroy({ removeView: true }, { children: true, texture: true, textureSource: true })
    }
  }, [agents, projectId])

  if (fallback) {
    return <div className="floor-fallback"><p>Pixi renderer tidak tersedia; mode aksesibel aktif.</p>{agents.map(agent => <button key={agent.id} onClick={() => onSelectRef.current(agent.id)}><b>{agent.name}</b><span>{agent.role} · {agent.status}</span></button>)}</div>
  }
  return <div className="pixi-floor-host" ref={host} aria-label="Interactive office floor" />
}
