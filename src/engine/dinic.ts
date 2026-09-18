/**
 * Dinic 最大流。
 *
 * 用于硬约束（冲突 / 容量 / 人数 / 机构去重）可行性检验与不可行原因定位：
 *  - maxflow.ts：无机构名额的基础二部网络；
 *  - slots.ts：在二部网络中插入“（稿件，机构）容量 1 名额节点”的机构去重网络。
 */

export interface DinicEdge {
  to: number
  rev: number
  cap: number
  /** 初始容量（用于反推边上流量 = 初始容量 − 残量） */
  initialCap: number
}

export class Dinic {
  private g: DinicEdge[][]
  private level: Int32Array
  private iter: Int32Array

  constructor(n: number) {
    this.g = Array.from({ length: n }, () => [])
    this.level = new Int32Array(n).fill(-1)
    this.iter = new Int32Array(n)
  }

  addEdge(from: number, to: number, cap: number): void {
    this.g[from].push({ to, rev: this.g[to].length, cap, initialCap: cap })
    this.g[to].push({ to: from, rev: this.g[from].length - 1, cap: 0, initialCap: 0 })
  }

  private bfs(s: number, t: number): boolean {
    this.level.fill(-1)
    this.level[s] = 0
    const queue: number[] = [s]
    let head = 0
    while (head < queue.length) {
      const v = queue[head++]
      for (const e of this.g[v]) {
        if (e.cap > 0 && this.level[e.to] < 0) {
          this.level[e.to] = this.level[v] + 1
          queue.push(e.to)
        }
      }
    }
    return this.level[t] >= 0
  }

  private dfs(v: number, t: number, f: number): number {
    if (v === t) return f
    for (let i = this.iter[v]; i < this.g[v].length; i++) {
      this.iter[v] = i
      const e = this.g[v][i]
      if (e.cap > 0 && this.level[v] < this.level[e.to]) {
        const d = this.dfs(e.to, t, Math.min(f, e.cap))
        if (d > 0) {
          e.cap -= d
          this.g[e.to][e.rev].cap += d
          return d
        }
      }
    }
    return 0
  }

  maxFlow(s: number, t: number): number {
    let flow = 0
    const INF = Number.MAX_SAFE_INTEGER
    while (this.bfs(s, t)) {
      this.iter.fill(0)
      let f: number
      while ((f = this.dfs(s, t, INF)) > 0) flow += f
    }
    return flow
  }

  /** 最大流跑完后，从 s 沿残量 > 0 的边可达的节点集合（用于最小割诊断） */
  reachableFrom(s: number): Set<number> {
    const seen = new Set<number>([s])
    const stack = [s]
    while (stack.length) {
      const v = stack.pop()!
      for (const e of this.g[v]) {
        if (e.cap > 0 && !seen.has(e.to)) {
          seen.add(e.to)
          stack.push(e.to)
        }
      }
    }
    return seen
  }

  /** 从 from 指向 to 的正向边上当前流量（初始容量 − 残量）；无边时为 0 */
  edgeFlow(from: number, to: number): number {
    for (const e of this.g[from]) {
      if (e.to === to && e.initialCap > 0) return e.initialCap - e.cap
    }
    return 0
  }
}
