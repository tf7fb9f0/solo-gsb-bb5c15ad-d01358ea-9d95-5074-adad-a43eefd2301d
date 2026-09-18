/**
 * Dinic 最大流 —— 用于硬约束（冲突 / 容量 / 人数）可行性检验与不可行原因定位。
 *
 * 网络结构:
 *   source -> 论文节点  (容量 = 该稿件需要的评审数)
 *   论文节点 -> 评审人节点 (容量 1, 仅在无利益冲突时连边)
 *   评审人节点 -> sink (容量 = 该评审人容量)
 *
 * 最大流 = 总需求 当且仅当存在满足全部硬约束的分配方案。
 */

interface DinicEdge {
  to: number
  rev: number
  cap: number
}

class Dinic {
  private g: DinicEdge[][]
  private level: Int32Array
  private iter: Int32Array

  constructor(n: number) {
    this.g = Array.from({ length: n }, () => [])
    this.level = new Int32Array(n).fill(-1)
    this.iter = new Int32Array(n)
  }

  addEdge(from: number, to: number, cap: number): void {
    this.g[from].push({ to, rev: this.g[to].length, cap })
    this.g[to].push({ to: from, rev: this.g[from].length - 1, cap: 0 })
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
}

export interface FeasibilityInput {
  /** 每篇稿件需求 */
  demands: number[]
  /** 每位评审人容量 */
  capacities: number[]
  /** eligible[i][j] = true 表示稿件 i 与评审人 j 无冲突，可分配 */
  eligible: boolean[][]
}

export interface FeasibilityResult {
  feasible: boolean
  totalRequired: number
  /** 最大流跑完后源点在残量网中可达的论文（局部索引）—— 不可行时即 Hall 缺陷稿件集合的核心 */
  sourceReachablePapers: number[]
}

export function checkFeasibility(input: FeasibilityInput): FeasibilityResult {
  const { demands, capacities, eligible } = input
  const P = demands.length
  const R = capacities.length
  const S = 0
  const paperNode = (i: number) => 1 + i
  const reviewerNode = (j: number) => 1 + P + j
  const T = 1 + P + R
  const dinic = new Dinic(T + 1)

  for (let i = 0; i < P; i++) dinic.addEdge(S, paperNode(i), demands[i])
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (eligible[i][j]) dinic.addEdge(paperNode(i), reviewerNode(j), 1)
    }
  }
  for (let j = 0; j < R; j++) dinic.addEdge(reviewerNode(j), T, capacities[j])

  const totalRequired = demands.reduce((a, b) => a + b, 0)
  const flow = dinic.maxFlow(S, T)
  const reachable = dinic.reachableFrom(S)

  const sourceReachablePapers: number[] = []
  for (const v of reachable) {
    if (v >= 1 && v < 1 + P) sourceReachablePapers.push(v - 1)
  }

  return {
    feasible: flow >= totalRequired,
    totalRequired,
    sourceReachablePapers
  }
}
