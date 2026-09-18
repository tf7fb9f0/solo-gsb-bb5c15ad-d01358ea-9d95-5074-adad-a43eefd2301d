import solver from 'javascript-lp-solver'
import { adjacentWitnessReviewers, checkSlotFeasibility, countAvailableSlotsForPaper } from './slots'
import { buildForcedMatrix, dedupePreAssignments, validatePreAssignments, type ForcedMatrix } from './preassign'
import type {
  AppData,
  AssignmentItem,
  AssignmentResult,
  AssignmentSuccess,
  InfeasibleReason,
  Paper,
  PreAssignment,
  Reviewer,
  ReviewerLoad
} from '../types'

/** 标签规范化：去空白、去重，大小写不敏感保留首次写法 */
function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const v = t.trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(v)
    }
  }
  return out
}

/** 机构归一化：仅去除首尾空白；空值（未填机构）仅代表评审人本人，不与其他空值合并 */
export function normalizeOrganization(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

interface Normalized {
  papers: Paper[]
  reviewers: Reviewer[]
  /** 去重后的预指派关系（失效引用不在此阶段剔除，由预检逐条报告） */
  preAssignments: PreAssignment[]
}

function normalize(data: AppData): Normalized {
  const papers: Paper[] = data.papers
    .map((p) => ({
      ...p,
      title: p.title.trim(),
      tags: normalizeTags(p.tags),
      reviewsRequired: Math.max(0, Math.floor(Number.isFinite(p.reviewsRequired) ? p.reviewsRequired : 0))
    }))
    .filter((p) => p.title.length > 0 && p.reviewsRequired > 0)

  const reviewers: Reviewer[] = data.reviewers
    .map((r) => ({
      ...r,
      name: r.name.trim(),
      tags: normalizeTags(r.tags),
      capacity: Math.max(0, Math.floor(Number.isFinite(r.capacity) ? r.capacity : 0)),
      organization: normalizeOrganization(r.organization),
      conflictPaperIds: Array.from(new Set(r.conflictPaperIds))
    }))
    .filter((r) => r.name.length > 0)

  return { papers, reviewers, preAssignments: dedupePreAssignments(data.preAssignments ?? []) }
}

function hasConflict(paper: Paper, reviewer: Reviewer): boolean {
  return reviewer.conflictPaperIds.includes(paper.id)
}

function tagKey(t: string): string {
  return t.toLowerCase()
}

/** 稿件 i 与评审人 j 命中的共同主题标签 */
function matchedTagsOf(paper: Paper, reviewer: Reviewer): string[] {
  const rSet = new Set(reviewer.tags.map(tagKey))
  return paper.tags.filter((t) => rSet.has(tagKey(t)))
}

/**
 * 计算一份（可能未经归一化的）稿件与评审人命中的共同主题标签。
 * 复用求解器同一套标签归一化（去空白、大小写不敏感、保留稿件侧首次写法），
 * 供「分派互换」在结果层重算交换后的匹配情况，保证与生成结果口径一致。
 */
export function computeMatchedTags(paper: Paper, reviewer: Reviewer): string[] {
  return matchedTagsOf(
    { ...paper, tags: normalizeTags(paper.tags) },
    { ...reviewer, tags: normalizeTags(reviewer.tags) }
  )
}

/**
 * 硬约束评估结果。
 * 可行性、不可行原因与归一化后的输入一并返回，供分配主流程与缺席压力测试复用。
 */
export interface HardConstraintEvaluation {
  feasible: boolean
  reasons: InfeasibleReason[]
  papers: Paper[]
  reviewers: Reviewer[]
  /** eligible[i][j] = true 表示稿件 i 与评审人 j 无冲突 */
  eligible: boolean[][]
  demands: number[]
  capacities: number[]
  /** 归一化后的评审人机构键（'' = 未填机构，仅代表本人，不与其他空值合并） */
  reviewerOrgs: string[]
  totalRequired: number
  /** 归一化（去重）后的预指派关系，顺序与存储一致 */
  preAssignments: PreAssignment[]
  /** 预指派问题（逐条）；非空时整体不可行，且不生成任何部分结果 */
  preAssignmentIssues: ReturnType<typeof validatePreAssignments>
  /** 有效预指派矩阵（仅在预检通过时有意义） */
  forced: ForcedMatrix
  /** 预指派占用后，评审人 j 对“自由名额”的剩余容量 = 容量 − 被预指派数 */
  residualCapacities: number[]
  /** 预指派占用后，稿件 i 仍需自由分配的名额 = 需求 − 预指派数 */
  residualDemands: number[]
  /** forcedOrgsOfPaper[i] = 稿件 i 已被预指派占住名额的机构键集合（这些机构不得再自由选他人） */
  forcedOrgsOfPaper: Set<string>[]
}

/**
 * 仅评估硬约束（冲突 / 容量 / 人数 / 预指派 / 机构去重），不做任何目标优化、不改变输入数据。
 * 缺席压力测试把某位评审人容量改为 0 后调用本函数，即“使用既有硬约束可行性逻辑重新判定”
 * （预指派同样是硬约束：容量置 0 后，被该评审人预占的名额会立刻显现为超限）。
 */
export function evaluateHardConstraints(rawData: AppData): HardConstraintEvaluation {
  const { papers, reviewers, preAssignments } = normalize(rawData)
  const P = papers.length
  const R = reviewers.length

  // ---- 冲突矩阵 ----
  const eligible: boolean[][] = papers.map((p) => reviewers.map((r) => !hasConflict(p, r)))
  const demands = papers.map((p) => p.reviewsRequired)
  const capacities = reviewers.map((r) => r.capacity)
  const reviewerOrgs = reviewers.map((r) => r.organization)
  const totalRequired = demands.reduce((a, b) => a + b, 0)

  // ---- 预指派预检（最高优先级）：引用缺失 / 利益冲突 / 同稿重复机构 / 同篇超额 / 单人超容量 ----
  const preAssignmentIssues = validatePreAssignments(papers, reviewers, preAssignments)
  const forced = buildForcedMatrix(papers, reviewers, preAssignments, eligible)
  const residualCapacities = reviewers.map((r, j) => {
    const reserved = papers.reduce((n, _, i) => n + (forced.forcedByPaperIndex[i].has(j) ? 1 : 0), 0)
    return r.capacity - reserved
  })
  const residualDemands = demands.map((d, i) => d - forced.forcedByPaperIndex[i].size)
  // 每篇稿件被预指派占住的机构：这些机构的其余评审人不得再被自由分派给该稿件
  const forcedOrgsOfPaper: Set<string>[] = forced.forcedByPaperIndex.map((set) => {
    const orgs = new Set<string>()
    for (const j of set) {
      const org = reviewerOrgs[j]
      if (org) orgs.add(org)
    }
    return orgs
  })

  const baseEval = (feasible: boolean, reasons: InfeasibleReason[]): HardConstraintEvaluation => ({
    feasible,
    reasons,
    papers,
    reviewers,
    preAssignments,
    eligible,
    demands,
    capacities,
    reviewerOrgs,
    totalRequired,
    preAssignmentIssues,
    forced,
    residualCapacities,
    residualDemands,
    forcedOrgsOfPaper
  })

  if (preAssignmentIssues.length > 0) {
    return baseEval(false, [
      {
        kind: 'preassignment',
        message:
          `预指派关系存在 ${preAssignmentIssues.length} 条无法满足的问题。预指派是生成分派时必须满足的硬约束，` +
          `任一问题存在时都不会生成部分结果；请逐条移除或修正后重新生成。`,
        issues: preAssignmentIssues
      }
    ])
  }

  const reasons: InfeasibleReason[] = []

  // ---- 退化情形 ----
  if (P === 0) {
    return baseEval(false, [
      { kind: 'paper-eligible', message: '没有需要分配的有效稿件（请至少录入一篇需要评审的稿件）。' }
    ])
  }
  if (R === 0) {
    reasons.push({
      kind: 'global-capacity',
      message: `尚未录入任何评审人，${papers.reduce((a, p) => a + p.reviewsRequired, 0)} 个评审名额无人承担。`
    })
    return baseEval(false, reasons)
  }

  // ---- 残量视角：预指派边视为已固定发送的流量，只保留“自由”边 ----
  const residualEligible: boolean[][] = papers.map((_, i) =>
    reviewers.map((_, j) => eligible[i][j] && !forced.forcedByPaperIndex[i].has(j))
  )

  // ---- 原因 1（最具体）：单篇稿件可分配的“互不同机构名额”不足 ----
  // 预指派已确定占住该篇名额（及其机构名额），单篇只需再从去重后的机构名额中选 需求−预指派数 个。
  const perPaperFailures: InfeasibleReason[] = []
  for (let i = 0; i < P; i++) {
    const reserved = forced.forcedByPaperIndex[i]
    const avail = countAvailableSlotsForPaper(residualEligible[i], reviewerOrgs, residualCapacities, forcedOrgsOfPaper[i])
    const need = residualDemands[i]
    if (avail < need) {
      const forcedNames = [...reserved].map((j) => reviewers[j].name)
      perPaperFailures.push({
        kind: 'paper-eligible',
        paperIds: [papers[i].id],
        message:
          `《${papers[i].title}》需要 ${demands[i]} 位评审人` +
          (reserved.size > 0
            ? `（其中 ${reserved.size} 位已由预指派确定：${forcedNames.join('、')}），还需 ${need} 位`
            : '') +
          `，但其余无利益冲突且互不同机构的可选名额仅 ${Math.max(0, avail)} 个（缺口 ${need - Math.max(0, avail)}；同一机构至多一人）。`
      })
    }
  }

  // ---- 全局容量：预指派已提前占住各评审人名额，自由名额总量不得少于剩余总需求 ----
  const totalResidualCapacity = residualCapacities.reduce((a, b) => a + b, 0)
  const totalResidualDemand = residualDemands.reduce((a, b) => a + b, 0)
  if (totalResidualCapacity < totalResidualDemand) {
    const totalForced = forced.forcedKeys.size
    reasons.push({
      kind: 'global-capacity',
      reviewerIds: reviewers.map((r) => r.id),
      message:
        totalForced > 0
          ? `全部稿件共需 ${totalRequired} 个名额，其中 ${totalForced} 个已由预指派提前占住；剩余 ${totalResidualDemand} 个自由名额，而评审人的剩余容量合计仅 ${totalResidualCapacity}（缺口 ${totalResidualDemand - totalResidualCapacity}）。请增加评审人、提高容量或减少预指派。`
          : `全部稿件共需 ${totalRequired} 个评审名额，而 ${R} 位评审人的容量合计仅 ${capacities.reduce((a, b) => a + b, 0)}（缺口 ${totalRequired - capacities.reduce((a, b) => a + b, 0)}）。请增加评审人或提高容量。`
    })
  }

  // ---- 机构名额网络可行性检验（残量；容量 1 的“(稿件,机构)”节点即机构去重硬约束）----
  const feas = checkSlotFeasibility({
    demands: residualDemands,
    capacities: residualCapacities,
    eligible: residualEligible,
    reviewerOrgs
  })

  if (!feas.feasible && reasons.length === 0 && perPaperFailures.length === 0) {
    // 组合性瓶颈（广义 Hall 条件违反）：取机构名额网最小割源侧可达稿件集合 Z，
    // 割分解精确给出 Z 在容量与机构名额双重限制下至多获得的自由名额 flowZ。
    const Zidx = feas.sourceReachablePapers
    const Zset = Zidx.map((i) => papers[i])
    // 展示用“可选评审人范围”：与 Z 任一稿件无冲突且仍有剩余容量者（口径与无机构时一致）；
    // 真实紧上界 flowZ / 缺口 deficit 由最小割分解给出（机构名额也参与割）。
    const yWitness = adjacentWitnessReviewers(Zidx, residualEligible, residualCapacities)
    const Yset = yWitness.map((b) => reviewers[b.reviewerIndex])
    const demandZ = feas.demandZ

    // 机构名额卡断明细：按机构聚合受影响稿件
    const blockedByOrg = new Map<string, number[]>()
    for (const slot of feas.blockedSlots) {
      const list = blockedByOrg.get(slot.org) ?? []
      if (!list.includes(slot.paperIndex)) list.push(slot.paperIndex)
      blockedByOrg.set(slot.org, list)
    }
    const blockedLines = [...blockedByOrg.entries()].map(
      ([org, idxs]) =>
        `机构“${org}”在 ${idxs.length} 篇瓶颈稿件上各至多出 1 人：${idxs
          .slice(0, 6)
          .map((i) => `《${papers[i].title}》`)
          .join('、')}${idxs.length > 6 ? ' 等' : ''}`
    )

    const totalForced = forced.forcedKeys.size
    reasons.push({
      kind: 'subset-bottleneck',
      paperIds: Zset.map((p) => p.id),
      reviewerIds: Yset.map((r) => r.id),
      deficit: feas.deficit,
      message:
        `存在一组 ${Zset.length} 篇稿件，其可选评审人范围相互重叠、形成容量/机构瓶颈：扣除预指派后它们共需 ${demandZ} 个自由名额，` +
        `而 ${Yset.length} 位无冲突且仍有剩余容量的评审人（每人对同一篇稿件至多评一次、同一机构至多一人）对这组稿件至多能承担 ${feas.flowZ} 个自由名额（缺口 ${feas.deficit}）。\n` +
        `瓶颈稿件：${Zset.map((p) => `《${p.title}》`).join('、')}；\n` +
        `可选评审人：${Yset.length ? Yset.map((r) => r.name).join('、') : '（无，全部存在利益冲突或容量已被预指派占满）'}。\n` +
        (blockedLines.length ? `机构名额卡断（同一稿件每机构至多一人）：\n${blockedLines.map((l) => `  · ${l}`).join('\n')}\n` : '') +
        (totalForced > 0 ? `预指派已提前占住 ${totalForced} 个名额；` : '') +
        `建议：为这些稿件补充评审人、解除部分冲突、提高相关评审人容量、分散评审人机构，或调整预指派。`
    })
  }

  return baseEval(feas.feasible, feas.feasible ? [] : [...perPaperFailures, ...reasons])
}

/**
 * 核心入口：执行盲审分配。
 *
 * 硬约束（全部必须满足，否则不可行）:
 *  1. 预指派：显式指定的（稿件，评审人）对必须出现在分派中；
 *  2. 利益冲突：声明冲突的稿件-评审人对绝不分配；
 *  3. 容量：每位评审人承担稿件数不超过 capacity（含被预指派预占的名额）；
 *  4. 人数：每篇稿件恰好得到 reviewsRequired 位互不相同的评审人；
 *  5. 机构去重：同一稿件至多选择每个机构一人（机构值去首尾空白后完全相同者视为同一机构；
 *     空机构仅代表评审人本人，不与其他空值合并）。
 *
 * 优化目标（硬约束满足后）:
 *  第一优先 最大化稿件主题标签与评审人擅长标签的匹配数；
 *  第二优先 最小化评审人最大负载（负载均衡）。
 */
export function solveAssignment(rawData: AppData): AssignmentResult {
  // ---- 硬约束可行性（与缺席压力测试共用同一套判定逻辑；预指派问题在此逐条报告） ----
  const hc = evaluateHardConstraints(rawData)
  if (!hc.feasible) {
    return { feasible: false, reasons: hc.reasons }
  }

  // ---- 硬约束可行：用整数规划做目标优化（预指派关系作为强制变量） ----
  return optimize(
    hc.papers,
    hc.reviewers,
    hc.eligible,
    hc.demands,
    hc.totalRequired,
    hc.forced,
    hc.reviewerOrgs
  )
}

/* ------------------------------ 整数规划优化 ------------------------------ */

interface PhaseSolution {
  feasible: boolean
  /** 最优主题匹配数 */
  matches: number
  /** 求解器原始结果，用于读取变量取值 */
  raw: Record<string, number>
}

/**
 * 阶段模型：在“每位评审人负载 ≤ capLimit（缺省取自身容量）”下最大化主题匹配数。
 *
 * 约束矩阵是带容量二部图（b-匹配 / 运输问题）的节点-关联阵，全幺模：
 * LP 松弛的顶点解天然为整数，javascript-lp-solver 无需真正分支即可快速求得 0/1 最优解。
 * 机构去重通过“（稿件，机构）Σx ≤ 1”的分组不等式加入——它们是变量的 0/1 行划分
 * （每个变量在其（稿件，机构）组中恰好出现一次），仍保持全幺模性。
 */
function runPhase(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  demands: number[],
  totalRequired: number,
  capLimit: number | null,
  forced: ForcedMatrix,
  reviewerOrgs: string[]
): PhaseSolution {
  const P = papers.length
  const R = reviewers.length

  const model: {
    optimize: string
    opType: 'max'
    constraints: Record<string, Record<string, number>>
    variables: Record<string, Record<string, number>>
    binaries: Record<string, 1>
  } = {
    optimize: 'objective',
    opType: 'max',
    constraints: {},
    variables: {},
    binaries: {}
  }

  papers.forEach((_, i) => {
    model.constraints[`paper_${i}`] = { equal: demands[i] }
  })
  reviewers.forEach((r, j) => {
    model.constraints[`reviewer_${j}`] = { max: capLimit === null ? r.capacity : Math.min(r.capacity, capLimit) }
  })
  // 预指派硬约束：对应二元变量必须取 1（与冲突/容量/人数/机构共同求解，不是事后补丁）
  for (const key of forced.forcedKeys) {
    model.constraints[`pre_${key}`] = { equal: 1 }
  }
  // 机构去重硬约束：每个（稿件 i，非空机构 org）组 Σ x[i][j] ≤ 1。
  // 预指派也参与该约束——预指派造成的同稿重复机构已在预检阶段整体拒绝。
  // 空机构 '' 不建组：每位空机构评审人各自独立，不与其他空值合并。
  const orgGroupVars = new Map<string, string[]>()
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      const org = reviewerOrgs[j]
      if (!org || !eligible[i][j]) continue
      const g = `org_${i}_${org}`
      orgGroupVars.set(g, [...(orgGroupVars.get(g) ?? []), `x_${i}_${j}`])
    }
  }
  for (const [g] of orgGroupVars) {
    model.constraints[g] = { max: 1 }
  }

  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue // 冲突对不生成变量 —— 硬约束：利益冲突
      const varName = `x_${i}_${j}`
      const matched = matchedTagsOf(papers[i], reviewers[j]).length > 0
      const col: Record<string, number> = {
        [`paper_${i}`]: 1,
        [`reviewer_${j}`]: 1,
        objective: matched ? 1 : 0
      }
      const org = reviewerOrgs[j]
      if (org) col[`org_${i}_${org}`] = 1
      if (forced.forcedKeys.has(`${i}_${j}`)) {
        col[`pre_${i}_${j}`] = 1
      }
      model.binaries[varName] = 1
      model.variables[varName] = col
    }
  }

  const res = solver.Solve(model as never) as Record<string, number | boolean>

  // 以实际取到 1 的变量数为准判定可行性（兼容求解器对 infeasible 返回 -0 的行为）
  let chosen = 0
  for (const v of Object.keys(model.variables)) {
    if (Math.round((res[v] as number) ?? 0) === 1) chosen++
  }
  const feasible = chosen === totalRequired && res.feasible !== false
  return { feasible, matches: feasible ? Math.round((res.result as number) ?? 0) : 0, raw: res as unknown as Record<string, number> }
}

function parseSolution(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  raw: Record<string, number>,
  forced: ForcedMatrix
): AssignmentItem[] {
  const P = papers.length
  const R = reviewers.length
  const assignments: AssignmentItem[] = []
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue
      if (Math.round(raw[`x_${i}_${j}`] ?? 0) !== 1) continue
      const matched = matchedTagsOf(papers[i], reviewers[j])
      const isForced = forced.forcedKeys.has(`${i}_${j}`)
      assignments.push({
        paperId: papers[i].id,
        reviewerId: reviewers[j].id,
        topicMatched: matched.length > 0,
        matchedTags: matched,
        preassigned: isForced || undefined
      })
    }
  }
  return assignments.sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId))
}

function buildSuccess(
  reviewers: Reviewer[],
  assignments: AssignmentItem[],
  totalRequired: number
): AssignmentSuccess {
  const counts = new Map<string, number>()
  for (const a of assignments) counts.set(a.reviewerId, (counts.get(a.reviewerId) ?? 0) + 1)
  const loads: ReviewerLoad[] = reviewers.map((r) => ({
    reviewerId: r.id,
    assigned: counts.get(r.id) ?? 0,
    capacity: r.capacity
  }))

  return {
    feasible: true,
    assignments: [...assignments].sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId)),
    loads,
    objective: {
      topicMatches: assignments.filter((a) => a.topicMatched).length,
      maxLoad: Math.max(0, ...loads.map((l) => l.assigned)),
      totalAssigned: assignments.length,
      totalRequired,
      preassignedCount: assignments.filter((a) => a.preassigned === true).length
    }
  }
}

function optimize(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  demands: number[],
  totalRequired: number,
  forced: ForcedMatrix,
  reviewerOrgs: string[]
): AssignmentSuccess {
  const R = reviewers.length

  // 阶段一：真实容量下最大化主题匹配数（预指派变量固定为 1），得到最优匹配数 M*
  const phase1 = runPhase(papers, reviewers, eligible, demands, totalRequired, null, forced, reviewerOrgs)

  // 理论上最大流已保证可行；求解器异常时退回贪心可行解
  if (!phase1.feasible) {
    return greedyFallback(papers, reviewers, eligible, demands, totalRequired, forced, reviewerOrgs)
  }
  const bestMatches = phase1.matches
  let bestRaw = phase1.raw

  // 阶段二：在不损失任何主题匹配（匹配数仍为 M*）的前提下，二分最小化最大负载 L。
  // 上界直接取阶段一解的最大负载，下界取总名额按人均摊的向上取整。
  const phase1Items = parseSolution(papers, reviewers, eligible, phase1.raw, forced)
  const phase1Counts = new Map<string, number>()
  for (const a of phase1Items) phase1Counts.set(a.reviewerId, (phase1Counts.get(a.reviewerId) ?? 0) + 1)
  const upperL = Math.max(1, ...reviewers.map((r) => phase1Counts.get(r.id) ?? 0))
  let lo = Math.max(1, Math.ceil(totalRequired / R))
  let hi = upperL

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = runPhase(papers, reviewers, eligible, demands, totalRequired, mid, forced, reviewerOrgs)
    if (r.feasible && r.matches === bestMatches) {
      hi = mid
      bestRaw = r.raw
    } else {
      lo = mid + 1
    }
  }

  const assignments = parseSolution(papers, reviewers, eligible, bestRaw, forced)
  if (assignments.length !== totalRequired) {
    return greedyFallback(papers, reviewers, eligible, demands, totalRequired, forced, reviewerOrgs)
  }
  // 防御性校验：求解结果必须完整包含全部预指派
  for (const key of forced.forcedKeys) {
    const [i, j] = key.split('_').map(Number)
    if (!assignments.some((a) => a.paperId === papers[i].id && a.reviewerId === reviewers[j].id)) {
      return greedyFallback(papers, reviewers, eligible, demands, totalRequired, forced, reviewerOrgs)
    }
  }
  return buildSuccess(reviewers, assignments, totalRequired)
}

/** 求解器异常时的兜底：先放入全部预指派，再按主题匹配优先、当前负载最低贪心选取（最大流已保证存在可行解） */
function greedyFallback(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  demands: number[],
  totalRequired: number,
  forced: ForcedMatrix,
  reviewerOrgs: string[]
): AssignmentSuccess {
  const assigned = new Map<string, number>(reviewers.map((r) => [r.id, 0]))
  const assignments: AssignmentItem[] = []
  const placed = new Set<string>()
  /** 每篇稿件已占用的非空机构（含预指派与已贪心放入的分派） */
  const usedOrgsByPaper = papers.map((_, i) => new Set<string>([...forced.forcedByPaperIndex[i]].map((j) => reviewerOrgs[j]).filter(Boolean) as string[]))

  // 预指派先无条件占位（预检已保证其不冲突、不超额、同稿机构不重复）
  for (let i = 0; i < papers.length; i++) {
    for (const j of forced.forcedByPaperIndex[i]) {
      const matched = matchedTagsOf(papers[i], reviewers[j])
      assignments.push({
        paperId: papers[i].id,
        reviewerId: reviewers[j].id,
        topicMatched: matched.length > 0,
        matchedTags: matched,
        preassigned: true
      })
      assigned.set(reviewers[j].id, (assigned.get(reviewers[j].id) ?? 0) + 1)
      placed.add(`${i}_${j}`)
    }
  }

  const ordered = [...papers].sort((a, b) => b.reviewsRequired - a.reviewsRequired)
  for (const paper of ordered) {
    const i = papers.indexOf(paper)
    const choices = reviewers
      .map((r, j) => ({ r, j, matched: matchedTagsOf(paper, r) }))
      .filter(({ j }) => eligible[i][j] && !placed.has(`${i}_${j}`))
      .sort((a, b) => {
        if ((a.matched.length > 0 ? 1 : 0) !== (b.matched.length > 0 ? 1 : 0)) return b.matched.length - a.matched.length
        return (assigned.get(a.r.id) ?? 0) - (assigned.get(b.r.id) ?? 0)
      })
    for (const { r, j, matched } of choices) {
      if (assignments.filter((a) => a.paperId === paper.id).length >= demands[i]) break
      // 机构去重硬约束：空机构不与任何值合并；非空机构同稿至多一人
      const org = reviewerOrgs[j]
      if (org && usedOrgsByPaper[i].has(org)) continue
      if ((assigned.get(r.id) ?? 0) >= r.capacity) continue
      assigned.set(r.id, (assigned.get(r.id) ?? 0) + 1)
      if (org) usedOrgsByPaper[i].add(org)
      placed.add(`${i}_${j}`)
      assignments.push({
        paperId: paper.id,
        reviewerId: r.id,
        topicMatched: matched.length > 0,
        matchedTags: matched
      })
    }
  }

  return buildSuccess(reviewers, assignments, totalRequired)
}
