/**
 * 评审人缺席压力测试。
 *
 * 仅在当前录入数据本身满足全部硬约束（可生成方案）时运行：
 * 对每一位容量 > 0 的评审人，分别模拟其“完全缺席”（容量临时置 0，不修改录入数据），
 * 再调用 {@link evaluateHardConstraints} —— 与“生成分派”完全相同的硬约束可行性逻辑
 * （利益冲突 / 容量 / 人数 / 机构去重，机构名额网络最大流 + 最小割瓶颈定位）—— 重新判定。
 *
 * 不可行的场景不止报告“总容量不足”，还给出：
 *  - 缺席者；
 *  - 受影响稿件（广义 Hall 缺陷稿件组，逐稿列出需求、剩余可选评审人数、单篇缺口）；
 *  - 名额缺口（Hall 紧见证缺口 + 全局剩余容量缺口两个口径）；
 *  - 可选评审人瓶颈（Hall 见证评审人集合及其对该稿件组至多能承担的名额）。
 */
import { adjacentWitnessReviewers, checkSlotFeasibility, countAvailableSlotsForPaper } from './slots'
import { evaluateHardConstraints, type HardConstraintEvaluation } from './solver'
import type {
  AppData,
  Reviewer,
  StressAffectedPaper,
  StressBottleneckReviewer,
  StressScenario,
  StressTestReport
} from '../types'

/**
 * 录入数据指纹：只纳入与硬约束相关的有效字段（标题/需求/标签/冲突；姓名/容量/机构）。
 * 压力测试报告保存运行时指纹，App 用它与当前指纹比对以立即标记“结果已过期”。
 * 可传入已算好的硬约束评估以复用归一化结果（避免每次按键重复跑最大流）。
 */
export function stressFingerprint(data: AppData, precomputed?: HardConstraintEvaluation): string {
  const hc = precomputed ?? evaluateHardConstraints(data)
  const papers = hc.papers
    .map((p) => `${p.id}|${p.title}|${p.reviewsRequired}|${[...p.tags].sort().join(',')}`)
    .sort()
  const reviewers = hc.reviewers
    .map(
      (r) =>
        `${r.id}|${r.name}|${r.capacity}|${r.organization}|${[...r.tags].sort().join(',')}|${[...r.conflictPaperIds].sort().join(',')}`
    )
    .sort()
  // 预指派也是硬约束：增删关系后压力测试报告同样立即过期
  const preAssignments = hc.preAssignments
    .map((pa) => `${pa.paperId}>${pa.reviewerId}`)
    .sort()
  return JSON.stringify({ papers, reviewers, preAssignments })
}

export type StressTestOutcome =
  | { runnable: true; report: StressTestReport }
  | { runnable: false; reasons: string[] }

/**
 * 运行缺席压力测试。
 *
 * 当前数据不可生成方案时不模拟（runnable: false）——缺席只会更差，
 * 此时应先按“生成分派”给出的不可行原因调整录入数据。
 */
export function runStressTest(data: AppData): StressTestOutcome {
  const baseline = evaluateHardConstraints(data)
  if (!baseline.feasible) {
    return { runnable: false, reasons: baseline.reasons.map((r) => r.message) }
  }

  const { reviewers } = baseline
  const totalRequired = baseline.totalRequired
  const totalCapacity = baseline.capacities.reduce((a, b) => a + b, 0)

  // 只对容量 > 0 的评审人模拟缺席；容量本就为 0 的评审人缺席与否没有区别
  const targets = reviewers
    .map((r, j) => ({ r, j }))
    .filter(({ r }) => r.capacity > 0)
    .sort((a, b) =>
      a.r.name.localeCompare(b.r.name, 'zh-Hans-CN') || a.r.id.localeCompare(b.r.id)
    )

  const scenarios: StressScenario[] = targets.map(({ r, j }) =>
    simulateAbsence(data, reviewers, r.id, j, totalRequired)
  )

  const infeasibleCount = scenarios.filter((s) => !s.feasible).length
  const report: StressTestReport = {
    fingerprint: stressFingerprint(data, baseline),
    runAt: new Date().toISOString(),
    testedReviewerCount: targets.length,
    totalRequired,
    totalCapacity,
    feasibleCount: scenarios.length - infeasibleCount,
    infeasibleCount,
    // 不可行的场景排在前面，便于优先查看单点风险
    scenarios: scenarios.sort((a, b) => Number(a.feasible) - Number(b.feasible))
  }
  return { runnable: true, report }
}

/** 模拟指定评审人完全缺席（容量置 0），并用既有硬约束逻辑重新判定。 */
function simulateAbsence(
  rawData: AppData,
  reviewers: Reviewer[],
  absentId: string,
  absentIndex: number,
  totalRequired: number
): StressScenario {
  const absent = reviewers[absentIndex]

  // 不修改录入数据：构造容量置 0 的临时副本（预指派关系保持不变，仍是硬约束）
  const tempData: AppData = {
    papers: rawData.papers,
    reviewers: rawData.reviewers.map((r) =>
      r.id === absentId ? { ...r, capacity: 0 } : r
    ),
    preAssignments: rawData.preAssignments ?? []
  }
  const hc = evaluateHardConstraints(tempData)
  const remainingCapacity = hc.capacities.reduce((a, b) => a + b, 0)
  const globalDeficit = Math.max(0, totalRequired - remainingCapacity)

  const base: StressScenario = {
    reviewerId: absentId,
    capacity: absent.capacity,
    feasible: hc.feasible,
    message: ''
  }

  if (hc.feasible) {
    const activeOthers = hc.reviewers.filter((_, j) => hc.capacities[j] > 0).length
    return {
      ...base,
      feasible: true,
      message:
        `若 ${absent.name} 完全缺席（其 ${absent.capacity} 个名额改由其他人承担），` +
        `其余 ${activeOthers} 位在役评审人仍可满足全部硬约束，方案仍可分配。`,
      remainingCapacity,
      globalDeficit: 0
    }
  }

  // ---- 不可行：构建结构化诊断（与“生成分派”同一套机构名额网络 + 最小割见证） ----
  // 残量视角：预指派边已固定，只看自由边；容量为 0 的缺席者（及基线本就 0 容量者）不承担名额。
  const residualEligible: boolean[][] = hc.papers.map((_, i) =>
    hc.reviewers.map((_, j) => hc.eligible[i][j] && !hc.forced.forcedByPaperIndex[i].has(j))
  )
  const slotFlow = checkSlotFeasibility({
    demands: hc.residualDemands,
    capacities: hc.residualCapacities,
    eligible: residualEligible,
    reviewerOrgs: hc.reviewerOrgs
  })

  // 1) 单篇稿件可分配的“互不同机构名额”不足的稿件
  const perPaperShort = new Map<number, number>()
  for (let i = 0; i < hc.papers.length; i++) {
    const avail = countAvailableSlotsForPaper(
      residualEligible[i],
      hc.reviewerOrgs,
      hc.residualCapacities,
      hc.forcedOrgsOfPaper[i]
    )
    if (avail < hc.residualDemands[i]) perPaperShort.set(i, hc.residualDemands[i] - avail)
  }

  // 2) 最大流（含机构名额节点）源侧可达稿件集合 Z（广义 Hall 缺陷集合）。
  const zIdx = slotFlow.sourceReachablePapers
    .slice()
    .sort(
      (a, b) =>
        (perPaperShort.has(b) ? 1 : 0) - (perPaperShort.has(a) ? 1 : 0) ||
        hc.papers[a].title.localeCompare(hc.papers[b].title, 'zh-Hans-CN')
    )

  // 3) 受影响稿件：逐稿给出需求 / 剩余可选的互不同机构名额数 / 缺口
  const affectedPapers: StressAffectedPaper[] = zIdx.map((i) => {
    const available = countAvailableSlotsForPaper(
      residualEligible[i],
      hc.reviewerOrgs,
      hc.residualCapacities,
      hc.forcedOrgsOfPaper[i]
    )
    return {
      paperId: hc.papers[i].id,
      required: hc.demands[i],
      available,
      shortfall: perPaperShort.get(i) ?? 0
    }
  })

  // 4) 名额缺口（Hall 紧见证）：最小割分解给出的 Z 实际可得自由名额 flowZ；
  //    展示用瓶颈评审人取“与 Z 无冲突且仍有容量”的相邻集合（旧口径，逐人给出名义上界）。
  const demandZ = slotFlow.demandZ
  const bottleneckReviewers: StressBottleneckReviewer[] = adjacentWitnessReviewers(
    zIdx,
    residualEligible,
    hc.residualCapacities
  )
    .map((b) => ({
      reviewerId: hc.reviewers[b.reviewerIndex].id,
      capacity: hc.reviewers[b.reviewerIndex].capacity,
      eligiblePaperCount: b.eligiblePaperCount,
      capacityForGroup: b.capForGroup
    }))
    .sort((a, b) => a.capacityForGroup - b.capacityForGroup || a.reviewerId.localeCompare(b.reviewerId))
  const flowZ = slotFlow.flowZ
  const deficit = Math.max(0, slotFlow.deficit)

  // 机构名额卡断明细（供可读结论引用）
  const blockedByOrg = new Map<string, string[]>()
  for (const slot of slotFlow.blockedSlots) {
    const paper = hc.papers[slot.paperIndex]
    const list = blockedByOrg.get(slot.org) ?? []
    if (!list.includes(paper.title)) list.push(paper.title)
    blockedByOrg.set(slot.org, list)
  }

  // ---- 组装可读结论（不能只报总容量不足） ----
  const paperLines = affectedPapers.map((p) => {
    const paper = hc.papers.find((x) => x.id === p.paperId)!
    const tail = p.shortfall > 0 ? `，单篇缺口 ${p.shortfall}` : '（单篇可选名额够，但整体名额调不开）'
    return `《${paper.title}》需 ${p.required} 人，剩余无冲突且互不同机构的可选名额 ${p.available} 个${tail}`
  })
  const bottleneckLines = bottleneckReviewers.map((b) => {
    const name = hc.reviewers.find((x) => x.id === b.reviewerId)?.name ?? b.reviewerId
    return `${name}（容量 ${b.capacity}，对该组可评 ${b.eligiblePaperCount} 篇，至多承担 ${b.capacityForGroup} 个名额）`
  })
  const blockedLines = [...blockedByOrg.entries()].map(
    ([org, titles]) => `机构“${org}”在 ${titles.length} 篇稿件上各至多出 1 人：${titles.slice(0, 6).map((t) => `《${t}》`).join('、')}${titles.length > 6 ? ' 等' : ''}`
  )

  const globalLine =
    globalDeficit > 0
      ? `缺席后剩余总容量 ${remainingCapacity} < 总需求 ${totalRequired}，全局名额缺口 ${globalDeficit}；`
      : `缺席后剩余总容量 ${remainingCapacity} 仍不少于总需求 ${totalRequired}（全局总容量够），但可选评审人范围/机构名额调不开：`

  const message =
    `若 ${absent.name} 完全缺席，则无法生成可行分配。\n` +
    `${globalLine}\n` +
    `受影响稿件共 ${affectedPapers.length} 篇、合计需求 ${demandZ} 个名额：\n` +
    paperLines.map((l) => `  · ${l}`).join('\n') +
    `\n可选评审人瓶颈：${
      bottleneckLines.length
        ? `${bottleneckReviewers.length} 位可选评审人在容量与机构去重（同一稿件每机构至多一人）限制下，对该组稿件至多承担 ${flowZ} 个名额，名额缺口 ${deficit}：\n` +
          bottleneckLines.map((l) => `  · ${l}`).join('\n')
        : `该组稿件在剩余评审人中无任何无冲突可分配者，名额缺口 ${deficit}`
    }。\n` +
    (blockedLines.length ? `机构名额卡断：\n${blockedLines.map((l) => `  · ${l}`).join('\n')}\n` : '') +
    `建议：为上述稿件补充评审人、解除部分利益冲突、提高相关评审人容量或分散评审人机构。`

  return {
    ...base,
    feasible: false,
    message,
    affectedPapers,
    deficit,
    globalDeficit,
    remainingCapacity,
    bottleneckReviewers
  }
}
