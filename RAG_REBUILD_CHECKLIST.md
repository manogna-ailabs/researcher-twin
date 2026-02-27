# RAG Rebuild Checklist

This checklist captures the agreed rebuild strategy for publications + thesis RAG.

## Phase 1: Data Model + Ingestion (Step 1)
- [x] Add source-role model (`publication`, `thesis`, `web`, `other`) to documents/chunks.
- [x] Add document metadata fields:
  - `title`, `year`, `venue`, `chapter`, `section`, `subsection`, `topics`, `canonicalCitation`.
- [x] Add chunk metadata placeholders:
  - `chunkIndex`, `paperKey`, `headingPath`, `pageStart`, `pageEnd`, `redundantOf`, `redundancyScore`, `isRedundant`.
- [x] Add role-aware chunking defaults:
  - publication: `900/140`
  - thesis: `1200/180`
- [x] Extend `/api/rag` upload ingestion to accept `sourceRole` + metadata fields.

## Phase 2: Thesis-vs-Publication Dedup
- [x] Compare thesis chunks against publication chunks only.
- [x] Mark exact duplicates via normalized hash.
- [x] Mark near-duplicates via similarity thresholds.
- [x] Keep thesis chunks but set redundancy metadata and ranking penalty.

## Phase 3: Intent Router + Retrieval Policy
- [x] Add intent classes:
  - `paper_specific`, `paper_compare`, `technical_cross_paper`, `research_overview`, `future_directions`.
- [x] Add paper-specific hard filtering to target paper only.
- [x] Add retrieval source-mix by intent.
- [x] Apply diversity cap (max chunks per document).
- [x] Enforce "no key claim from redundant thesis chunk only".

## Phase 4: Citation Contract in Answers
- [x] Use source labels (`PAPER`, `THESIS`, `THESIS-REDUNDANT`).
- [x] Enforce claim-to-source rules:
  - quantitative claims must cite publication evidence.
- [x] Implement minimum-evidence policy:
  - for single paper questions, evidence stays paper-local.
- [x] Add conflict resolution: publication is canonical for factual detail.

## Phase 5: Rebuild + Validation Runbook
- [x] Re-ingest all publication PDFs with publication metadata.
- [x] Ingest thesis PDF with thesis metadata.
- [x] Run dedup pass and verify redundancy flags.
- [x] Run query checks:
  - paper-specific results, cross-paper compare, overview, future directions.
- [x] Verify citation quality and non-confusing evidence boundaries.
