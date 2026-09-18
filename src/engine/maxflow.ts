/**
 * Dinic 最大流 —— 用于硬约束（冲突 / 容量 / 人数）可行性检验与不可行原因定位。
 *
 * 网络结构:
 *   source -> 论文节点  (容量 = 该稿件需要的评审数)
 *   论文节点 -> 评审人节点 (容量 1, 仅在无利益冲突时连边)
 *   评审人节点 -> sink (容量 = 该评审人容量)
 *
 * 最大流 = 总需求 当且仅当存在满足全部硬约束的分配方案。
 *
 * 注意：本网络不含机构名额节点，仅供不考虑机构去重的既有调用使用；
 * 机构去重硬约束的可行性检验见 slots.ts 的 checkSlotFeasibility。
 */

import { Dinic } from './dinic'

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
