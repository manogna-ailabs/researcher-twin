/**
 * Canonical publication metadata shared across ingestion and runtime citation rendering.
 * This module is intentionally framework-agnostic so both API routes and server runtime
 * code can use the same source of truth.
 */

export type CanonicalPublication = {
  title: string
  venue: string
  year: string
  aliases: string[]
}

export type DocumentMetadataLike = {
  title?: string
  year?: string
  venue?: string
  chapter?: string
  section?: string
  subsection?: string
  topics?: string[]
  canonicalCitation?: string
}

export const CANONICAL_PUBLICATIONS: CanonicalPublication[] = [
  {
    title: 'Improved Cross-Dataset Facial Expression Recognition by Handling Data Imbalance and Feature Confusion',
    venue: 'ECCVW',
    year: '2022',
    aliases: ['difc', 'DIFC_ECCVW_2022.pdf'],
  },
  {
    title: 'A Simple Signal for Domain Shift',
    venue: 'ICCVW',
    year: '2023',
    aliases: ['dss', 'DSS_ICCVW_2023.pdf'],
  },
  {
    title: 'PhISH-Net: Physics Inspired System for High Resolution Underwater Image Enhancement',
    venue: 'WACV',
    year: '2024',
    aliases: ['phishnet', 'PhishNet_WACV_2024.pdf', 'phish-net'],
  },
  {
    title: 'Effectiveness of Vision Language Models for Open-world Single Image Test Time Adaptation',
    venue: 'TMLR',
    year: '2025',
    aliases: ['rosita', 'ROSITA_TMLR_2025.pdf'],
  },
  {
    title: 'SANTA: Source Anchoring Network and Target Alignment for Continual Test Time Adaptation',
    venue: 'TMLR',
    year: '2023',
    aliases: ['santa', 'SANTA_TMLR_2023.pdf'],
  },
  {
    title: 'Similar Class Style Augmentation for Efficient Cross-Domain Few-Shot Learning',
    venue: 'CVPRW',
    year: '2023',
    aliases: ['ssabns', 'SSABNS_CVPRW_2023.pdf'],
  },
  {
    title: 'Segmentation Assisted Incremental Test Time Adaptation in an Open World',
    venue: 'BMVC',
    year: '2025',
    aliases: ['segassist', 'SegAssist_BMVC_2025.pdf'],
  },
  {
    title: 'pSTarC: Pseudo Source Guided Target Clustering for Fully Test-Time Adaptation',
    venue: 'WACV',
    year: '2024',
    aliases: ['pstarc', 'pSTarC_WACV_2024.pdf'],
  },
  {
    title: 'JumpStyle: A Framework for Data-Efficient Online Adaptation',
    venue: 'ICLRW',
    year: '2023',
    aliases: ['jumpstyle'],
  },
]

export function normalizeCatalogText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function publicationAliases(pub: CanonicalPublication): string[] {
  return [pub.title, ...pub.aliases].map(item => normalizeCatalogText(item)).filter(Boolean)
}

export function resolveCanonicalPublicationByFileName(fileName: string): CanonicalPublication | undefined {
  const normalizedFileName = normalizeCatalogText(fileName)
  const stem = normalizeCatalogText(fileName.replace(/\.[a-z0-9]{2,6}$/i, '').replace(/[_-]+/g, ' '))

  for (const publication of CANONICAL_PUBLICATIONS) {
    const aliases = publicationAliases(publication)
    for (const alias of aliases) {
      if (!alias) continue
      if (alias === normalizedFileName || alias === stem) return publication
      if (alias.length >= 6 && (normalizedFileName.includes(alias) || stem.includes(alias))) return publication
    }
  }

  return undefined
}

export function resolveCanonicalPublicationFromCandidates(candidates: string[]): CanonicalPublication | undefined {
  const normalizedCandidates = candidates.map(item => normalizeCatalogText(item)).filter(Boolean)
  if (!normalizedCandidates.length) return undefined

  for (const candidate of normalizedCandidates) {
    for (const publication of CANONICAL_PUBLICATIONS) {
      const aliases = publicationAliases(publication)
      for (const alias of aliases) {
        if (!alias) continue
        if (candidate === alias) return publication
        if (alias.length >= 6 && candidate.includes(alias)) return publication
        if (candidate.length >= 6 && alias.includes(candidate)) return publication
      }
    }
  }

  return undefined
}

export function withCanonicalMetadata(
  fileName: string,
  metadata?: DocumentMetadataLike
): DocumentMetadataLike | undefined {
  const canonical = resolveCanonicalPublicationByFileName(fileName)
  if (!canonical && !metadata) return undefined
  if (!canonical) return metadata

  const merged: DocumentMetadataLike = {
    title: metadata?.title || canonical.title,
    year: metadata?.year || canonical.year,
    venue: metadata?.venue || canonical.venue,
    chapter: metadata?.chapter,
    section: metadata?.section,
    subsection: metadata?.subsection,
    topics: metadata?.topics,
    canonicalCitation: metadata?.canonicalCitation || `${canonical.title} (${canonical.venue} ${canonical.year})`,
  }

  if (
    !merged.title
    && !merged.year
    && !merged.venue
    && !merged.chapter
    && !merged.section
    && !merged.subsection
    && !merged.topics?.length
    && !merged.canonicalCitation
  ) {
    return undefined
  }

  return merged
}
