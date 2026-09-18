/**
 * 机构名额（slot）网络 —— 机构去重硬约束的可行性检验与不可行原因定位。
 *
 * 硬约束：同一稿件至多选择每个机构的一位评审人。机构值去除首尾空白后完全相同者
 * 视为同一机构；空机构仅代表该评审人本人，不与其他空值合并（每位空机构评审人
 * 各自占据一个独立名额）。
 *
 * 在“稿件—评审人”二部网络之外，为每个“（稿件，机构）对”插入一个容量 1 的名额节点：
 *
 *   source → 稿件 i                (容量 = 该稿件名额需求)
 *   稿件 i → 名额(i, org)          (容量 1，每位无冲突评审人归入其机构的名额；
 *                                   空机构评审人各自一个独立名额)
 *   名额(i, org) → 评审人 j        (容量 1，仅该名额归属机构内、与该稿件无冲突的评审人)
 *   评审人 j → sink                (容量 = 该评审人容量)
 *
 * 名额节点容量 1 天然保证“同一稿件每个机构至多一人”；评审人→汇容量保证单人容量；
 * 源→稿件容量保证每篇人数。最大流满流当且仅当以上全部硬约束（在给定的残量需求/
 * 容量与可分配关系上）可同时满足。
 *
 * 不可行时利用最小割源侧可达集合给出紧见证：
 *   缺口 deficit = 需求(Z) − 流量(Z)
 *   其中 Z 为源侧可达稿件；流量(Z) 在最小割上精确分解为
 *     Σ 可达评审人容量 + Σ 不可达但被 Z 的稿件饱和占用的名额数（跨割名额）。
 */
import { Dinic } from './dinic'

export interface SlotFeasibilityInput {
  /** 每篇稿件（残量）需求 */
  demands: number[]
  /** 每位评审人（残量）容量 */
  capacities: number[]
  /** eligible[i][j] = true 表示稿件 i 与评审人 j 可分配（无冲突且未被预指派占用） */
  eligible: boolean[][]
  /**
   * 评审人 j 的归一化机构键：
   * '' 表示空机构（该评审人独占一个名额），非空字符串即去除首尾空白后的机构名。
   */
  reviewerOrgs: string[]
}

export interface BottleneckReviewerWitness {
  reviewerIndex: number
  /**
   * 该评审人对瓶颈稿件组 Z 的紧上界贡献：
   *  - 源侧可达评审人：其全部（残量）容量（其承接的全部流量都来自 Z）；
   *  - 不可达评审人：Z 的稿件经其所属名额跨割送过去的流量数（至多 |Z 中可评稿件数|）。
   * capForGroup 之和 + 被机构名额卡断的流量 = 需求(Z) − 缺口。
   */
  capForGroup: number
  /** Z 中与该评审人可分配（无冲突）的稿件数 */
  eligiblePaperCount: number
  /** 最小割源侧是否可达（true = 与瓶颈稿件组同处割的一侧） */
  reachable: boolean
}

export interface BlockedOrgSlot {
  /** 瓶颈稿件在 papers 中的局部下标 */
  paperIndex: number
  /** 机构名（空机构不会被卡：每个空机构名额独立） */
  org: string
  /** 被该名额卡住（需求侧最多只能送出 1 人）的可分配评审人下标 */
  reviewerIndices: number[]
}

export interface SlotFeasibilityResult {
  feasible: boolean
  totalRequired: number
  /** 最小割源侧可达的稿件（局部下标）—— 不可行时即 Hall 缺陷稿件集合 */
  sourceReachablePapers: number[]
  /** 紧见证瓶颈评审人 */
  bottleneckReviewers: BottleneckReviewerWitness[]
  /** Z 的稿件需求合计 */
  demandZ: number
  /** Z 在最小割上实际送出的流量（需求(Z) − 缺口） */
  flowZ: number
  /** 名额缺口（≥ 1 时不可行） */
  deficit: number
  /** Z 中容量 1 的机构名额（机构去重约束本身卡断的名额），按稿件×机构列出 */
  blockedSlots: BlockedOrgSlot[]
}

interface SlotNode {
  /** 名额归属稿件 */
  paperIndex: number
  /** 机构键 */
  org: string
  /** 归入该名额的评审人局部下标（非空机构按机构聚合；空机构每人独立一个名额） */
  reviewers: number[]
}

export function checkSlotFeasibility(input: SlotFeasibilityInput): SlotFeasibilityResult {
  const { demands, capacities, eligible, reviewerOrgs } = input
  const P = demands.length
  const R = capacities.length

  // ---- 为每个 (稿件 i, 机构) 建立名额节点 ----
  // 非空机构：同稿同机构的评审人共享一个容量 1 名额；
  // 空机构 ''：每位评审人各自一个独立名额（空值不合并）。
  const slots: SlotNode[] = []
  for (let i = 0; i < P; i++) {
    const byOrg = new Map<string, number[]>()
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue
      const org = reviewerOrgs[j] ?? ''
      const list = byOrg.get(org)
      if (list) list.push(j)
      else byOrg.set(org, [j])
    }
    for (const [org, list] of byOrg) {
      if (org === '') {
        for (const j of list) slots.push({ paperIndex: i, org, reviewers: [j] })
      } else {
        slots.push({ paperIndex: i, org, reviewers: list.slice().sort((a, b) => a - b) })
      }
    }
  }
  const S = slots.length

  const Src = 0
  const paperNode = (i: number) => 1 + i
  const slotNode = (s: number) => 1 + P + s
  const reviewerNode = (j: number) => 1 + P + S + j
  const Sink = 1 + P + S + R
  const dinic = new Dinic(Sink + 1)

  for (let i = 0; i < P; i++) dinic.addEdge(Src, paperNode(i), demands[i])
  slots.forEach((slot, s) => {
    dinic.addEdge(paperNode(slot.paperIndex), slotNode(s), 1) // 机构名额容量 1 —— 去重硬约束
    for (const j of slot.reviewers) dinic.addEdge(slotNode(s), reviewerNode(j), 1)
  })
  for (let j = 0; j < R; j++) dinic.addEdge(reviewerNode(j), Sink, capacities[j])

  const totalRequired = demands.reduce((a, b) => a + b, 0)
  const flow = dinic.maxFlow(Src, Sink)
  const reachable = dinic.reachableFrom(Src)

  const reachablePaperIdx: number[] = []
  for (let i = 0; i < P; i++) if (reachable.has(paperNode(i))) reachablePaperIdx.push(i)
  const reachableReviewer = (j: number) => reachable.has(reviewerNode(j))
  const zSet = new Set(reachablePaperIdx)

  const empty: Omit<SlotFeasibilityResult, 'feasible' | 'totalRequired' | 'sourceReachablePapers'> = {
    bottleneckReviewers: [],
    demandZ: 0,
    flowZ: 0,
    deficit: 0,
    blockedSlots: []
  }
  if (flow >= totalRequired) {
    return {
      feasible: true,
      totalRequired,
      sourceReachablePapers: reachablePaperIdx,
      ...empty
    }
  }

  // ---- 最小割分解：Z（源侧可达稿件）在割上实际送出的流量 ----
  // 割由三类边构成（名额容量 1 边也计入，因此机构去重与容量统一反映在 flowZ 中）：
  //  (a) 可达评审人 → sink：必饱和，贡献 = 该评审人（残量）容量；
  //  (b) 可达名额 → 不可达评审人：饱和跨割边，贡献 1；
  //  (c) 可达稿件 → 不可达名额：饱和机构名额边（机构卡断点），贡献 1。
  // 类型 (c) 名额内部送给评审人的流量不重复累加——它已由 (a)（可达评审人）或
  // 同一边在割上的容量计数覆盖；blockedSlots 仅用于展示“机构卡断”明细。
  const demandZ = reachablePaperIdx.reduce((a, i) => a + demands[i], 0)
  const contribution = new Map<number, number>()
  const addContribution = (j: number, n: number) =>
    contribution.set(j, (contribution.get(j) ?? 0) + n)
  const blockedSlots: BlockedOrgSlot[] = []
  let blockedCutCount = 0

  slots.forEach((slot, s) => {
    if (!zSet.has(slot.paperIndex)) return
    const sNode = slotNode(s)
    if (reachable.has(sNode)) {
      // (b) 可达名额送给不可达评审人的饱和跨割流量
      for (const j of slot.reviewers) {
        if (!reachableReviewer(j) && dinic.edgeFlow(sNode, reviewerNode(j)) > 0) addContribution(j, 1)
      }
    } else {
      // (c) 可达稿件 → 不可达名额：饱和机构名额边（机构去重本身卡断的名额）
      if (dinic.edgeFlow(paperNode(slot.paperIndex), sNode) > 0) {
        blockedCutCount++
        if (slot.org !== '') {
          blockedSlots.push({ paperIndex: slot.paperIndex, org: slot.org, reviewerIndices: slot.reviewers.slice() })
        }
      }
    }
  })

  // (a) 可达评审人：其→汇边必饱和（否则汇可达），对 Z 的承接量 = 其（残量）容量
  for (let j = 0; j < R; j++) {
    if (reachableReviewer(j)) addContribution(j, capacities[j])
  }

  const flowZ = [...contribution.values()].reduce((a, b) => a + b, 0) + blockedCutCount
  const deficit = Math.max(0, demandZ - flowZ)

  const bottleneckReviewers: BottleneckReviewerWitness[] = [...contribution.entries()]
    .map(([j, capForGroup]) => ({
      reviewerIndex: j,
      capForGroup,
      eligiblePaperCount: reachablePaperIdx.reduce((n, i) => n + (eligible[i][j] ? 1 : 0), 0),
      reachable: reachableReviewer(j)
    }))
    .sort((a, b) => a.capForGroup - b.capForGroup || a.reviewerIndex - b.reviewerIndex)

  return {
    feasible: false,
    totalRequired,
    sourceReachablePapers: reachablePaperIdx,
    bottleneckReviewers,
    demandZ,
    flowZ,
    deficit,
    blockedSlots
  }
}

/**
 * 单篇稿件视角：在“每机构至多一人 + 已被预指派占用者除外”下，
 * 还能从多少个互不同机构的名额中选择评审人（= 去重后的可分配机构名额数）。
 *
 * @param forcedOrgs 该稿件已被预指派占住名额的机构键集合（这些机构不得再选他人）
 */
export function countAvailableSlotsForPaper(
  eligibleRow: boolean[],
  reviewerOrgs: string[],
  reviewerCapacityResidual: number[],
  forcedOrgs: Set<string>
): number {
  let count = 0
  const seen = new Set<string>()
  for (let j = 0; j < eligibleRow.length; j++) {
    if (!eligibleRow[j]) continue
    if (reviewerCapacityResidual[j] <= 0) continue
    const org = reviewerOrgs[j] ?? ''
    if (org !== '') {
      if (forcedOrgs.has(org) || seen.has(org)) continue
      seen.add(org)
    }
    count++
  }
  return count
}

/**
 * 可读瓶颈见证评审人集合：与稿件组 Z 中任一稿件可分配（无冲突）、且仍有（残量）容量的评审人。
 *
 * 这是诊断信息中展示给用户的“可选评审人范围”（与旧版无机构网络口径一致）：
 * 每位评审人对 Z 的名义上界为 min(剩余容量, Z 中可评稿件数)。
 * 注意：存在机构名额节点时，这些上界之和可能大于最小割紧见证给出的真实总上界——
 * 真实总上界（flowZ）与缺口（deficit）以 {@link checkSlotFeasibility} 的最小割分解为准。
 */
export function adjacentWitnessReviewers(
  paperIndices: number[],
  eligible: boolean[][],
  capacities: number[]
): BottleneckReviewerWitness[] {
  const out: BottleneckReviewerWitness[] = []
  for (let j = 0; j < capacities.length; j++) {
    if (capacities[j] <= 0) continue
    const degree = paperIndices.reduce((n, i) => n + (eligible[i][j] ? 1 : 0), 0)
    if (degree === 0) continue
    out.push({
      reviewerIndex: j,
      capForGroup: Math.min(capacities[j], degree),
      eligiblePaperCount: degree,
      reachable: false
    })
  }
  return out.sort((a, b) => a.capForGroup - b.capForGroup || a.reviewerIndex - b.reviewerIndex)
}
