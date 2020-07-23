/* eslint-disable camelcase,no-continue */
import { cloneDeep, set } from 'lodash'

import type { AuspiceJsonV2, AuspiceTreeNode, AuspiceTreeNodeAttrs } from 'auspice'

import { formatMutation } from 'src/helpers/formatMutation'
import { parseMutation } from 'src/helpers/parseMutation'

import type {
  Nucleotide,
  NucleotideDeletion,
  NucleotideInsertion,
  NucleotideMissing,
  NucleotideRange,
  SubstitutionsWithAminoacids,
} from 'src/algorithms/types'

export interface AuspiceTreeNodeAttrsExtended extends AuspiceTreeNodeAttrs {
  new_node?: { value?: string }
  QCStatus?: { value?: string }
}

export type MutationMap = Map<number, Nucleotide>

export interface AuspiceTreeNodeExtended extends AuspiceTreeNode<AuspiceTreeNodeAttrsExtended> {
  mutations?: MutationMap
}

export interface SequenceAnalysisDatum {
  seqName: string
  clade: string
  alignmentStart: number
  alignmentEnd: number
  alignmentScore: number
  mutations: SubstitutionsWithAminoacids[]
  totalMutations: number
  aminoacidChanges: string
  totalAminoacidChanges: number
  deletions: NucleotideDeletion[]
  totalGaps: number
  insertions: NucleotideInsertion[]
  totalInsertions: number
  missing: NucleotideMissing[]
  totalMissing: number
  nonACGTNs: NucleotideRange[]
  totalNonACGTNs: number
  QCStatus: string
  QCFlags: string[]
  errors?: string[]
}

export function parseMutationOrThrow(mut: string) {
  const parsedMut = parseMutation(mut)
  if (!parsedMut) {
    throw new Error(`Mutation cannot be parsed: "${mut}"`)
  }

  const { refNuc, pos, queryNuc } = parsedMut
  if (!refNuc || pos === undefined || !queryNuc) {
    throw new Error(`Mutation cannot be parsed: "${mut}"`)
  }

  return { anc: refNuc, pos, der: queryNuc }
}

export function get_node_struct(seq: SequenceAnalysisDatum): AuspiceTreeNodeExtended {
  return {
    branch_attrs: { mutations: {} },
    name: `${seq.seqName}_clades`,
    node_attrs: {
      clade_membership: { value: seq.clade },
      new_node: { value: 'Yes' },
      QCStatus: { value: seq.QCStatus },
    },
    mutations: new Map(),
  }
}

export function mutations_on_tree(node: AuspiceTreeNodeExtended, mutations: MutationMap) {
  const tmp_muts = cloneDeep(mutations)

  const nucleotideMutations = node?.branch_attrs?.mutations?.nuc
  if (nucleotideMutations) {
    for (const mut of nucleotideMutations) {
      const { anc, pos, der } = parseMutationOrThrow(mut)
      const previousNuc = mutations.get(pos)
      if (previousNuc && previousNuc !== anc) {
        throw new Error(
          `Mutation is inconsistent: "${mut}": current nucleotide: "${anc}", previously seen: "${previousNuc}"`,
        )
      }
      tmp_muts.set(pos, der)
    }
  }

  node.mutations = tmp_muts
  const { children } = node
  if (children) {
    for (const c of children) {
      mutations_on_tree(c, tmp_muts)
    }
  }
}

export function calculate_distance(node: AuspiceTreeNodeExtended, seq: SequenceAnalysisDatum) {
  let shared_differences = 0
  let shared_sites = 0
  for (const qmut of seq.mutations) {
    const der = node.mutations?.get(qmut.pos)
    if (der) {
      if (qmut.queryNuc === der) {
        shared_differences += 1
      } else {
        shared_sites += 1
      }
    }
  }

  const numMut = node.mutations?.size ?? 0
  return numMut + seq.mutations.length - 2 * shared_differences - shared_sites
}

export function get_differences(node: AuspiceTreeNodeExtended, seq: SequenceAnalysisDatum, root_seq: string) {
  const mutations: string[] = []

  for (const qmut of seq.mutations) {
    const { pos, queryNuc } = qmut
    const der = node.mutations?.get(pos)
    if (der) {
      if (queryNuc !== der) {
        const refNuc = der
        const mut = formatMutation({ refNuc, pos, queryNuc })
        mutations.push(mut)
      }
    } else {
      const refNuc = root_seq[pos] as Nucleotide
      const mut = formatMutation({ refNuc, pos, queryNuc })
      mutations.push(mut)
    }
  }

  return mutations
}

export function closest_match(node: AuspiceTreeNodeExtended, seq: SequenceAnalysisDatum) {
  let best = calculate_distance(node, seq)
  let best_node = node
  const children = node?.children ?? []
  for (const child of children) {
    const { best: tmp_best, best_node: tmp_best_node } = closest_match(child, seq)
    if (tmp_best < best) {
      best = tmp_best
      best_node = tmp_best_node
    }
  }

  return { best, best_node }
}

export function attach_to_tree(base_node: AuspiceTreeNodeExtended, seq: SequenceAnalysisDatum, rootSeq: string) {
  if (!base_node?.children) {
    base_node.children = []
  }

  const mutations = get_differences(base_node, seq, rootSeq)

  const baseDiv = base_node?.node_attrs?.div ?? 0
  const div = baseDiv + mutations.length

  const new_node = get_node_struct(seq)
  set(new_node, 'branch_attrs.mutations.nuc', mutations)
  set(new_node, 'node_attrs.div', div)
  set(new_node, 'mutations', cloneDeep(base_node.mutations))

  for (const mut of mutations) {
    const { pos, der } = parseMutationOrThrow(mut)
    new_node.mutations?.set(pos, der)
  }

  base_node.children.push(new_node)
}

export function remove_mutations(node: AuspiceTreeNodeExtended) {
  if (node?.mutations) {
    node.mutations = undefined
  }

  const children = node?.children ?? []
  for (const c of children) {
    remove_mutations(c)
  }
}

export function locateInTree(
  result: SequenceAnalysisDatum[],
  auspiceDataRaw: Record<string, unknown>,
  rootSeq: string,
) {
  const data = cloneDeep(result)
  const auspiceData = (cloneDeep(auspiceDataRaw) as unknown) as AuspiceJsonV2 // TODO: validate and sanitize

  const auspiceTreeVersionExpected = 'v2'
  const auspiceTreeVersion = (auspiceDataRaw?.version as string | undefined) ?? 'undefined'
  if (auspiceTreeVersion !== auspiceTreeVersionExpected) {
    throw new Error(
      `Tree format not recognized. Expected version "${auspiceTreeVersionExpected}", got "${auspiceTreeVersion}"`,
    )
  }

  const focal_node = auspiceData?.tree
  if (!focal_node) {
    throw new Error(`Tree format not recognized: ".tree" is undefined`)
  }

  const mutations = new Map()
  mutations_on_tree(focal_node, mutations)

  for (const seq of data) {
    if (seq?.errors && seq?.errors.length > 0) {
      continue
    }

    const { best_node } = closest_match(focal_node, seq)
    attach_to_tree(best_node, seq, rootSeq)
  }

  remove_mutations(focal_node)

  auspiceData.meta.colorings.push({ key: 'QCStatus', title: 'QC Status', type: 'categorical' })
  auspiceData.meta.colorings.push({ key: 'new_node', title: 'New Node', type: 'categorical' })

  auspiceData.meta.display_defaults = {
    branch_label: 'clade',
    color_by: 'new_node',
    distance_measure: 'div',
    geo_resolution: 'country',
    map_triplicate: true,
    transmission_lines: false,
  }

  return auspiceData
}
