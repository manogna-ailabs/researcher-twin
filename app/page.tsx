'use client'

/**
 * Main Research Twin frontend page.
 * Responsibilities:
 * - Render profile, publication highlights, and chat workspace.
 * - Coordinate chat requests to the backend agent and render parsed responses.
 * - Provide RAG document management and benchmark controls.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { callAIAgent } from '@/lib/aiAgent'
import { DEFAULT_PUBLIC_AGENT_ID, DEFAULT_PUBLIC_RAG_ID } from '@/lib/config/env'
import fetchWrapper from '@/lib/fetchWrapper'
import {
  coerceAgentPayload,
  extractFollowups,
  sanitizeMetadataForDisplay,
  splitResponseAndMetadata,
  stripJsonCodeFence,
  stripThinkBlocks,
} from '@/lib/parsers/agentResponse'
import { useRAGKnowledgeBase } from '@/lib/ragKnowledgeBase'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { FiSend, FiExternalLink, FiUpload, FiChevronDown, FiChevronUp, FiTrash2, FiFile, FiMessageSquare, FiUser, FiClock, FiBookOpen, FiLayers, FiRefreshCw, FiAlertCircle, FiCheck, FiX } from 'react-icons/fi'
import { FaGithub, FaGraduationCap } from 'react-icons/fa'

// --- Constants ---
const AGENT_ID = DEFAULT_PUBLIC_AGENT_ID
const RAG_ID = DEFAULT_PUBLIC_RAG_ID

const THEME_VARS = {
  '--background': '0 0% 6%',
  '--foreground': '0 0% 92%',
  '--card': '0 0% 8%',
  '--card-foreground': '0 0% 92%',
  '--primary': '0 0% 92%',
  '--primary-foreground': '0 0% 6%',
  '--secondary': '0 0% 12%',
  '--secondary-foreground': '0 0% 85%',
  '--accent': '0 70% 55%',
  '--accent-foreground': '0 0% 98%',
  '--muted': '0 0% 15%',
  '--muted-foreground': '0 0% 55%',
  '--border': '0 0% 18%',
  '--input': '0 0% 22%',
  '--ring': '0 0% 92%',
  '--radius': '0rem',
} as React.CSSProperties

// --- Types ---
interface Citation {
  title: string
  venue: string
  year: string
}

interface ChatMessage {
  role: 'user' | 'twin'
  content: string
  metadata?: string
  citations?: Citation[]
  followups?: string[]
  timestamp: string
}

interface SamplePublication {
  title: string
  venue: string
  year: string
  abstract: string
}

interface BenchmarkQuality {
  overall: number
  relevance: number
  grounding: number
  citations: number
  completeness: number
}

interface BenchmarkResult {
  model: string
  status: 'ok' | 'error'
  latency_ms: number
  quality: BenchmarkQuality
  response_text: string
  citations: Citation[]
  suggested_followups: string[]
  error?: string
}

// --- Real Data from manogna-s.github.io ---
const ALL_PUBLICATIONS: SamplePublication[] = [
  {
    title: 'Segmentation Assisted Incremental Test Time Adaptation in an Open World',
    venue: 'BMVC',
    year: '2025',
    abstract: 'Addresses Incremental Test Time Adaptation of Vision-Language Models in dynamic environments with unfamiliar objects and distribution shifts. Proposes SegAssist, a training-free segmentation assisted active labeling module.',
  },
  {
    title: 'Effectiveness of Vision Language Models for Open-world Single Image Test Time Adaptation',
    venue: 'TMLR',
    year: '2025',
    abstract: 'Proposes ROSITA, a framework for Single Image Test Time Adaptation in open, dynamic environments using Vision Language Models like CLIP for real-time per-image adaptation without source data or ground truth labels.',
  },
  {
    title: 'pSTarC: Pseudo Source Guided Target Clustering for Fully Test-Time Adaptation',
    venue: 'WACV',
    year: '2024',
    abstract: 'Proposes pseudo Source guided Target Clustering for Test Time Adaptation under real-world domain shifts. Exploits the source classifier for generating pseudo-source samples and aligns test samples to facilitate clustering.',
  },
  {
    title: 'PhISH-Net: Physics Inspired System for High Resolution Underwater Image Enhancement',
    venue: 'WACV',
    year: '2024',
    abstract: 'Combines physics-based Underwater Image Formation Model with a deep image enhancement approach based on the retinex model. Achieves real-time processing of high-resolution underwater images using a lightweight neural network.',
  },
  {
    title: 'SANTA: Source Anchoring Network and Target Alignment for Continual Test Time Adaptation',
    venue: 'TMLR',
    year: '2023',
    abstract: 'Framework for online adaptation that modifies affine parameters of batch normalization layers using source anchoring based self-distillation. Proposes source-prototype driven contrastive alignment for target samples.',
  },
  {
    title: 'A Simple Signal for Domain Shift',
    venue: 'ICCVW',
    year: '2023',
    abstract: 'Explores continual domain test time adaptation by proposing a domain shift detection mechanism. Uses the source domain trained model to continually measure similarity between feature representations of consecutive batches.',
  },
  {
    title: 'Similar Class Style Augmentation for Efficient Cross-Domain Few-Shot Learning',
    venue: 'CVPRW',
    year: '2023',
    abstract: 'Addresses Cross-Domain Few-Shot Learning to recognize new classes from unseen domains with limited training samples. Proposes to augment the data of each class with the styles of semantically similar classes.',
  },
  {
    title: 'JumpStyle: A Framework for Data-Efficient Online Adaptation',
    venue: 'ICLRW',
    year: '2023',
    abstract: 'Presents approach for fine-tuning deep networks in Domain Generalization setting with an innovative initialization technique that jumpstarts the adaptation process, combined with style-aware augmentation and pseudo-labeling.',
  },
  {
    title: 'Improved Cross-Dataset Facial Expression Recognition by Handling Data Imbalance and Feature Confusion',
    venue: 'ECCVW',
    year: '2022',
    abstract: 'Addresses Facial Expression Recognition domain shift between datasets. Proposes DIFC module that handles source Data Imbalance and Feature Confusion of target data, integrated with UDA approach.',
  },
]

// Featured publications (first 4 for highlight grid)
const SAMPLE_PUBLICATIONS: SamplePublication[] = ALL_PUBLICATIONS.slice(0, 4)

const TIMELINE_ITEMS = [
  { year: '2022', label: 'Cross-dataset facial expression recognition' },
  { year: '2023', label: 'Test-time adaptation & cross-domain few-shot learning' },
  { year: '2024', label: 'Pseudo-source clustering & underwater image enhancement' },
  { year: '2025', label: 'Open-world VLM adaptation & segmentation-assisted TTA' },
]

const TIMELINE_DETAILS = [
  'Published work on handling data imbalance and feature confusion in Facial Expression Recognition across datasets at ECCV Workshop.',
  'Prolific year with 4 publications: SANTA (TMLR) for continual test-time adaptation, domain shift detection (ICCVW), cross-domain few-shot learning (CVPRW), and data-efficient online adaptation (ICLRW).',
  'Published pSTarC at WACV for pseudo source guided target clustering in test-time adaptation, and PhISH-Net at WACV for physics-inspired underwater image enhancement.',
  'Latest work on Vision-Language Models: SegAssist (BMVC) for incremental test-time adaptation in open worlds, and ROSITA (TMLR) for single image test-time adaptation.',
]

const RESEARCH_TOPICS = [
  { name: 'Test-Time Adaptation', size: 'large' },
  { name: 'Vision-Language Models', size: 'large' },
  { name: 'Domain Adaptation', size: 'large' },
  { name: 'Few-Shot Learning', size: 'medium' },
  { name: 'Open-World Recognition', size: 'medium' },
  { name: 'Continual Learning', size: 'medium' },
  { name: 'Image Enhancement', size: 'small' },
  { name: 'Domain Shift Detection', size: 'small' },
  { name: 'Contrastive Learning', size: 'small' },
  { name: 'Meta-Learning', size: 'small' },
]

const SUGGESTED_PROMPTS = [
  'What is test-time adaptation and why is it needed?',
  'What are the major variants of TTA in real-world deployment?',
  'How do closed-set, open-set, and incremental TTA differ?',
  'What is the overall evolution of your research themes?',
  'What future research directions are highlighted in your thesis?',
]

const DEFAULT_BENCHMARK_MODELS = [
  'meta/llama-3.3-70b-instruct',
  'google/gemma-2-27b-it',
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
]

const SAMPLE_MESSAGES: ChatMessage[] = [
  {
    role: 'user',
    content: 'What is your latest research about?',
    timestamp: '2025-01-15T10:30:00Z',
  },
  {
    role: 'twin',
    content: '## Current Research Focus\n\nMy most recent work focuses on **Test-Time Adaptation of Vision-Language Models** in open-world dynamic environments. Specifically:\n\n- **SegAssist (BMVC 2025)**: A training-free segmentation-assisted active labeling module for Incremental Test-Time Adaptation. It repurposes VLM segmentation capabilities to refine active sample selection in environments with continuously appearing unseen classes and domain shifts.\n- **ROSITA (TMLR 2025)**: A framework for Single Image Test-Time Adaptation that leverages CLIP for real-time per-image adaptation without source data or ground truth labels. It includes an OOD detection module and contrastive learning to distinguish weak and strong OOD samples.\n\nThe overarching goal is developing methods that can learn and adapt in dynamic real-world environments using less data and compute power.',
    citations: [
      { title: 'Segmentation Assisted Incremental Test Time Adaptation in an Open World', venue: 'BMVC', year: '2025' },
      { title: 'Effectiveness of Vision Language Models for Open-world Single Image Test Time Adaptation', venue: 'TMLR', year: '2025' },
    ],
    followups: [
      'What practical constraints make TTA necessary at deployment time?',
      'How do closed-set and open-set TTA assumptions differ?',
      'What is incremental TTA and when is it needed?',
    ],
    timestamp: '2025-01-15T10:30:05Z',
  },
]

// --- Markdown Renderer ---
function formatInline(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.*?)\*\*/g)
  if (parts.length === 1) {
    const codeParts = text.split(/`([^`]+)`/g)
    if (codeParts.length === 1) return text
    return codeParts.map((part, i) =>
      i % 2 === 1 ? (
        <code key={i} className="px-1.5 py-0.5 bg-muted text-sm font-mono">{part}</code>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      )
    )
  }
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold">{part}</strong>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  )
}

function renderMarkdown(text: string) {
  if (!text) return null
  return (
    <div className="space-y-2" style={{ lineHeight: '1.7', letterSpacing: '-0.02em' }}>
      {text.split('\n').map((line, i) => {
        if (line.startsWith('### '))
          return <h4 key={i} className="font-semibold text-sm mt-3 mb-1 text-foreground">{line.slice(4)}</h4>
        if (line.startsWith('## '))
          return <h3 key={i} className="font-semibold text-base mt-3 mb-1 text-foreground">{line.slice(3)}</h3>
        if (line.startsWith('# '))
          return <h2 key={i} className="font-bold text-lg mt-4 mb-2 text-foreground">{line.slice(2)}</h2>
        if (line.startsWith('- ') || line.startsWith('* '))
          return <li key={i} className="ml-4 list-disc text-sm text-foreground/90">{formatInline(line.slice(2))}</li>
        if (/^\d+\.\s/.test(line))
          return <li key={i} className="ml-4 list-decimal text-sm text-foreground/90">{formatInline(line.replace(/^\d+\.\s/, ''))}</li>
        if (!line.trim()) return <div key={i} className="h-1" />
        return <p key={i} className="text-sm text-foreground/90">{formatInline(line)}</p>
      })}
    </div>
  )
}

// --- ErrorBoundary ---
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: '' }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
          <div className="text-center p-8 max-w-md">
            <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
            <p className="text-muted-foreground mb-4 text-sm">{this.state.error}</p>
            <button onClick={() => this.setState({ hasError: false, error: '' })} className="px-4 py-2 bg-primary text-primary-foreground text-sm">
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// --- AnimatedCounter ---
function AnimatedCounter({ target, label, icon }: { target: number; label: string; icon: React.ReactNode }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let current = 0
    const increment = Math.max(1, Math.floor(target / 30))
    const timer = setInterval(() => {
      current += increment
      if (current >= target) {
        setCount(target)
        clearInterval(timer)
      } else {
        setCount(current)
      }
    }, 50)
    return () => clearInterval(timer)
  }, [target])

  return (
    <div className="flex items-center gap-3 px-6 py-4 flex-1">
      <div className="text-muted-foreground">{icon}</div>
      <div>
        <div className="text-2xl font-bold tracking-tight text-foreground">{count}+</div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest">{label}</div>
      </div>
    </div>
  )
}

// --- Navbar ---
function Navbar({ activeSection, onSectionChange }: { activeSection: string; onSectionChange: (s: string) => void }) {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-[hsl(0,70%,55%)]" />
          <span className="font-semibold text-foreground tracking-tight font-serif">Manogna Sreenivas</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant={activeSection === 'overview' ? 'default' : 'ghost'} size="sm" onClick={() => onSectionChange('overview')} className="text-xs uppercase tracking-widest">
            Overview
          </Button>
          <Button variant={activeSection === 'chat' ? 'default' : 'ghost'} size="sm" onClick={() => onSectionChange('chat')} className="text-xs uppercase tracking-widest">
            Chat
          </Button>
        </div>
      </div>
    </nav>
  )
}

// --- HeroSection ---
function HeroSection() {
  return (
    <div className="py-20 px-6">
      <div className="max-w-3xl mx-auto text-center">
        <div className="w-20 h-20 mx-auto mb-6 bg-secondary border border-border flex items-center justify-center">
          <FaGraduationCap className="w-8 h-8 text-muted-foreground" />
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-3 font-serif text-foreground">Manogna Sreenivas</h1>
        <p className="text-muted-foreground text-base mb-4 tracking-wide">PhD Student &middot; Electrical Engineering, IISc Bangalore</p>
        <p className="text-foreground/70 text-lg leading-relaxed max-w-2xl mx-auto mb-8" style={{ lineHeight: '1.7', letterSpacing: '-0.02em' }}>
          Developing learning methods for computer vision with limited data and distribution shifts &mdash; building models that adapt in dynamic real-world environments
        </p>
        <div className="flex items-center justify-center gap-4">
          <a href="https://scholar.google.co.in/citations?user=ytQg9qIAAAAJ" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <FaGraduationCap className="w-4 h-4" /> Google Scholar
          </a>
          <Separator orientation="vertical" className="h-4" />
          <a href="https://github.com/manogna-s" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <FaGithub className="w-4 h-4" /> GitHub
          </a>
          <Separator orientation="vertical" className="h-4" />
          <a href="https://manogna-s.github.io/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <FiExternalLink className="w-4 h-4" /> Website
          </a>
        </div>
      </div>
    </div>
  )
}

// --- StatsBar ---
function StatsBar() {
  return (
    <div className="max-w-4xl mx-auto px-6 mb-16">
      <div className="border border-border bg-card flex flex-col md:flex-row md:divide-x divide-border">
        <AnimatedCounter target={9} label="Publications" icon={<FiBookOpen className="w-5 h-5" />} />
        <AnimatedCounter target={5} label="Research Areas" icon={<FiLayers className="w-5 h-5" />} />
        <AnimatedCounter target={4} label="Years Active" icon={<FiClock className="w-5 h-5" />} />
        <AnimatedCounter target={7} label="Venues" icon={<FiUser className="w-5 h-5" />} />
      </div>
    </div>
  )
}

// --- TimelineSection ---
function TimelineSection() {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  return (
    <div className="max-w-5xl mx-auto px-6 mb-20">
      <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-8 text-center">Research Timeline</h2>
      <div className="relative">
        <div className="hidden md:block absolute top-6 left-0 right-0 h-px bg-border" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {TIMELINE_ITEMS.map((item, idx) => (
            <button key={idx} onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)} className="text-left group relative">
              <div className="hidden md:flex items-center justify-center mb-4">
                <div className={`w-3 h-3 border-2 transition-colors ${expandedIdx === idx ? 'bg-[hsl(0,70%,55%)] border-[hsl(0,70%,55%)]' : 'bg-background border-muted-foreground group-hover:border-foreground'}`} />
              </div>
              <div className="text-lg font-bold tracking-tight text-foreground mb-1">{item.year}</div>
              <div className="text-sm text-muted-foreground leading-relaxed">{item.label}</div>
              {expandedIdx === idx && (
                <div className="mt-3 pt-3 border-t border-border">
                  <p className="text-xs text-foreground/60 leading-relaxed">{TIMELINE_DETAILS[idx]}</p>
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// --- TopicCluster ---
function TopicCluster() {
  const sizeClasses: Record<string, string> = {
    large: 'text-sm px-4 py-2',
    medium: 'text-xs px-3 py-1.5',
    small: 'text-[11px] px-2.5 py-1',
  }

  return (
    <div className="max-w-4xl mx-auto px-6 mb-20">
      <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-8 text-center">Research Areas</h2>
      <div className="flex flex-wrap justify-center gap-3">
        {RESEARCH_TOPICS.map((topic) => (
          <Badge key={topic.name} variant="outline" className={`border-border hover:bg-secondary transition-colors cursor-default ${sizeClasses[topic.size] ?? 'text-xs px-2.5 py-1'}`}>
            {topic.name}
          </Badge>
        ))}
      </div>
    </div>
  )
}

// --- PublicationCard ---
function PublicationCard({ pub, onDiscuss }: { pub: SamplePublication; onDiscuss: (title: string) => void }) {
  return (
    <Card className="border-border bg-card hover:bg-secondary/30 transition-colors">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold leading-snug tracking-tight">{pub.title}</CardTitle>
        <div className="flex items-center gap-2 mt-1">
          <Badge variant="outline" className="text-[10px] border-[hsl(0,70%,55%)] text-[hsl(0,70%,55%)]">{pub.venue}</Badge>
          <span className="text-xs text-muted-foreground">{pub.year}</span>
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        <p className="text-xs text-muted-foreground leading-relaxed">{pub.abstract}</p>
      </CardContent>
      <CardFooter>
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-foreground gap-1" onClick={() => onDiscuss(pub.title)}>
          <FiMessageSquare className="w-3 h-3" /> Discuss with Twin
        </Button>
      </CardFooter>
    </Card>
  )
}

// --- PublicationsGrid ---
function PublicationsGrid({ onDiscuss }: { onDiscuss: (title: string) => void }) {
  const [showAll, setShowAll] = useState(false)
  const displayPubs = showAll ? ALL_PUBLICATIONS : SAMPLE_PUBLICATIONS

  return (
    <div className="max-w-5xl mx-auto px-6 mb-20">
      <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-8 text-center">Publications</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {displayPubs.map((pub) => (
          <PublicationCard key={pub.title} pub={pub} onDiscuss={onDiscuss} />
        ))}
      </div>
      {!showAll && ALL_PUBLICATIONS.length > 4 && (
        <div className="text-center mt-6">
          <Button variant="outline" size="sm" onClick={() => setShowAll(true)} className="text-xs uppercase tracking-widest">
            View all {ALL_PUBLICATIONS.length} publications
          </Button>
        </div>
      )}
      {showAll && (
        <div className="text-center mt-6">
          <Button variant="outline" size="sm" onClick={() => setShowAll(false)} className="text-xs uppercase tracking-widest">
            Show fewer
          </Button>
        </div>
      )}
    </div>
  )
}

// --- KnowledgeBaseSection ---
function KnowledgeBaseSection() {
  const { documents, loading, error, fetchDocuments, uploadDocument, removeDocuments } = useRAGKnowledgeBase()
  const [isOpen, setIsOpen] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen && documents === null) {
      fetchDocuments(RAG_ID)
    }
  }, [isOpen, documents, fetchDocuments])

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploadStatus('Uploading...')
    setUploadError(null)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (!file) continue
      const result = await uploadDocument(RAG_ID, file)
      if (!result.success) {
        setUploadError(result.error ?? 'Upload failed')
        setUploadStatus(null)
        return
      }
    }
    setUploadStatus('Upload complete')
    setTimeout(() => setUploadStatus(null), 3000)
  }

  const handleDelete = async (fileName: string) => {
    await removeDocuments(RAG_ID, [fileName])
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFileUpload(e.dataTransfer.files)
  }

  return (
    <div className="max-w-4xl mx-auto px-6 mb-20">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <button className="w-full flex items-center justify-between py-4 border-t border-b border-border text-left">
            <div className="flex items-center gap-3">
              <FiUpload className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs uppercase tracking-widest text-muted-foreground">Manage Knowledge Base</span>
            </div>
            {isOpen ? <FiChevronUp className="w-4 h-4 text-muted-foreground" /> : <FiChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="py-6 space-y-6">
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed p-8 text-center transition-colors ${isDragging ? 'border-foreground bg-secondary/50' : 'border-border'}`}
            >
              <FiUpload className="w-6 h-6 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-2">Drop PDF, DOCX, or TXT files here</p>
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={loading}>
                {loading ? 'Processing...' : 'Browse Files'}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt"
                multiple
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files)}
              />
            </div>

            {uploadStatus && (
              <div className="flex items-center gap-2 text-sm text-foreground">
                <FiCheck className="w-4 h-4 text-green-500" /> {uploadStatus}
              </div>
            )}
            {uploadError && (
              <div className="flex items-center gap-2 text-sm text-[hsl(0,70%,55%)]">
                <FiAlertCircle className="w-4 h-4" /> {uploadError}
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 text-sm text-[hsl(0,70%,55%)]">
                <FiAlertCircle className="w-4 h-4" /> {error}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs uppercase tracking-widest text-muted-foreground">Documents</span>
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => fetchDocuments(RAG_ID)} disabled={loading}>
                  <FiRefreshCw className={`w-3 h-3 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
                </Button>
              </div>
              {loading && !Array.isArray(documents) && (
                <div className="space-y-2">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="h-10 bg-muted animate-pulse" />
                  ))}
                </div>
              )}
              {Array.isArray(documents) && documents.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No documents uploaded yet.</p>
              )}
              {Array.isArray(documents) && documents.length > 0 && (
                <div className="space-y-1">
                  {documents.map((doc) => (
                    <div key={doc.fileName} className="flex items-center justify-between py-2 px-3 border border-border bg-secondary/20 group">
                      <div className="flex items-center gap-3 min-w-0">
                        <FiFile className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm text-foreground truncate">{doc.fileName}</p>
                          <p className="text-xs text-muted-foreground">{doc.fileType ? doc.fileType.toUpperCase() : 'FILE'} {doc.status ? `| ${doc.status}` : ''}</p>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-[hsl(0,70%,55%)]" onClick={() => handleDelete(doc.fileName)}>
                        <FiTrash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

// --- ChatMessageBubble ---
function ChatMessageBubble({ msg, onFollowup }: { msg: ChatMessage; onFollowup: (q: string) => void }) {
  const isUser = msg.role === 'user'
  const [isMetadataOpen, setIsMetadataOpen] = useState(false)
  const hasMetadata = Boolean((msg.metadata && msg.metadata.trim()) || (Array.isArray(msg.citations) && msg.citations.length > 0))

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-8 h-8 bg-secondary border border-border flex items-center justify-center mr-3 flex-shrink-0 mt-1">
          <FaGraduationCap className="w-4 h-4 text-muted-foreground" />
        </div>
      )}
      <div className={`max-w-[85%] ${isUser ? 'bg-secondary border border-border' : 'bg-card border border-border'}`}>
        {!isUser && (
          <div className="px-4 pt-3 pb-1 flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] border-[hsl(0,70%,55%)] text-[hsl(0,70%,55%)]">AI Twin</Badge>
          </div>
        )}
        <div className="px-4 py-3">
          {!isUser ? renderMarkdown(msg.content) : (
            <p className="text-sm text-foreground" style={{ lineHeight: '1.7' }}>{msg.content}</p>
          )}
        </div>

        {Array.isArray(msg.followups) && msg.followups.length > 0 && (
          <div className="px-4 pb-3 border-t border-border pt-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Follow-up Questions</p>
            <div className="flex flex-wrap gap-2">
              {msg.followups.map((q, qIdx) => (
                <button key={qIdx} onClick={() => onFollowup(q)} className="text-xs text-foreground/70 hover:text-foreground border border-border px-3 py-1.5 hover:bg-secondary transition-colors text-left">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isUser && hasMetadata && (
          <div className="px-4 pb-3 border-t border-border pt-3">
            <Collapsible open={isMetadataOpen} onOpenChange={setIsMetadataOpen}>
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center justify-between text-left text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
                  <span>Response Metadata</span>
                  {isMetadataOpen ? <FiChevronUp className="w-3 h-3" /> : <FiChevronDown className="w-3 h-3" />}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="pt-3 space-y-3">
                  {Array.isArray(msg.citations) && msg.citations.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Citations</p>
                      <div className="flex flex-wrap gap-2">
                        {msg.citations.map((cit, cIdx) => (
                          <Badge key={cIdx} variant="secondary" className="text-[10px] font-normal">
                            {cit?.title ?? 'Untitled'}{cit?.venue ? ` (${cit.venue}` : ''}{cit?.year ? `, ${cit.year})` : cit?.venue ? ')' : ''}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {msg.metadata && (
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Evidence Notes</p>
                      <div className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">
                        {msg.metadata}
                      </div>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </div>
    </div>
  )
}

// --- ModelBenchmarkPanel ---
function ModelBenchmarkPanel({ seedPrompt }: { seedPrompt: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const [benchmarkPrompt, setBenchmarkPrompt] = useState(seedPrompt)
  const [modelList, setModelList] = useState(DEFAULT_BENCHMARK_MODELS.join('\n'))
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [summary, setSummary] = useState<{ best_quality_model?: string | null; fastest_model?: string | null } | null>(null)

  useEffect(() => {
    if (!benchmarkPrompt.trim() && seedPrompt.trim()) {
      setBenchmarkPrompt(seedPrompt)
    }
  }, [seedPrompt, benchmarkPrompt])

  const toPercent = (value: number) => `${Math.round((value || 0) * 100)}%`

  const runBenchmark = async () => {
    const models = modelList
      .split(/[\n,]/)
      .map(item => item.trim())
      .filter(Boolean)

    if (!benchmarkPrompt.trim()) {
      setError('Enter a benchmark question.')
      return
    }

    if (models.length < 2) {
      setError('Provide at least 2 model IDs.')
      return
    }

    setIsRunning(true)
    setError(null)
    setResults([])
    setSummary(null)

    try {
      const response = await fetchWrapper('/api/model-benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: benchmarkPrompt.trim(),
          models,
          rag_id: RAG_ID,
        }),
      })

      if (!response) {
        throw new Error('No response from server.')
      }

      const data = await response.json()
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Benchmark failed.')
      }

      const ordered = Array.isArray(data.results)
        ? [...data.results].sort((a, b) => (b?.quality?.overall || 0) - (a?.quality?.overall || 0))
        : []

      setResults(ordered)
      setSummary(data.summary || null)
    } catch (benchError) {
      setError(benchError instanceof Error ? benchError.message : 'Benchmark failed.')
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="mt-4">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <button className="w-full flex items-center justify-between py-3 px-4 border border-border bg-card text-left">
            <div className="flex items-center gap-3">
              <FiLayers className="w-4 h-4 text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Model A/B Test</span>
            </div>
            {isOpen ? <FiChevronUp className="w-4 h-4 text-muted-foreground" /> : <FiChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border border-t-0 border-border bg-card p-4 space-y-4">
            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Benchmark Prompt</Label>
              <Textarea
                value={benchmarkPrompt}
                onChange={(e) => setBenchmarkPrompt(e.target.value)}
                rows={3}
                className="mt-2 text-sm"
                placeholder="Enter one question to test across models"
              />
            </div>

            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Models (one per line)</Label>
              <Textarea
                value={modelList}
                onChange={(e) => setModelList(e.target.value)}
                rows={4}
                className="mt-2 text-xs font-mono"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={runBenchmark} disabled={isRunning}>
                {isRunning ? 'Running...' : 'Run Benchmark'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setBenchmarkPrompt(seedPrompt)} disabled={isRunning}>
                Use Latest Question
              </Button>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-2 border border-[hsl(0,70%,55%)]/30 bg-[hsl(0,70%,55%)]/5">
                <FiAlertCircle className="w-4 h-4 text-[hsl(0,70%,55%)]" />
                <p className="text-xs text-[hsl(0,70%,55%)]">{error}</p>
              </div>
            )}

            {summary && (
              <div className="flex flex-wrap gap-2">
                {summary.best_quality_model && (
                  <Badge variant="outline" className="text-[10px]">
                    Best quality: {summary.best_quality_model}
                  </Badge>
                )}
                {summary.fastest_model && (
                  <Badge variant="outline" className="text-[10px]">
                    Fastest: {summary.fastest_model}
                  </Badge>
                )}
              </div>
            )}

            {results.length > 0 && (
              <div className="space-y-3">
                {results.map((item, idx) => (
                  <div key={`${item.model}-${idx}`} className="border border-border p-3 bg-secondary/20">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <Badge variant="secondary" className="text-[10px]">#{idx + 1}</Badge>
                      <span className="text-xs font-mono text-foreground">{item.model}</span>
                      <Badge variant="outline" className="text-[10px]">{item.latency_ms} ms</Badge>
                      <Badge variant="outline" className="text-[10px]">Quality {toPercent(item.quality?.overall)}</Badge>
                    </div>

                    {item.status === 'error' ? (
                      <p className="text-xs text-[hsl(0,70%,55%)]">{item.error || 'Model run failed.'}</p>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
                          <p className="text-[11px] text-muted-foreground">Relevance: <span className="text-foreground">{toPercent(item.quality?.relevance)}</span></p>
                          <p className="text-[11px] text-muted-foreground">Grounding: <span className="text-foreground">{toPercent(item.quality?.grounding)}</span></p>
                          <p className="text-[11px] text-muted-foreground">Citations: <span className="text-foreground">{toPercent(item.quality?.citations)}</span></p>
                          <p className="text-[11px] text-muted-foreground">Completeness: <span className="text-foreground">{toPercent(item.quality?.completeness)}</span></p>
                        </div>
                        <div className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">
                          {item.response_text || 'No response text returned.'}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

// --- ChatInterface ---
function ChatInterface({ initialMessage, onAgentActive }: { initialMessage?: string; onAgentActive: (id: string | null) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const initialSentRef = useRef(false)

  useEffect(() => {
    setSessionId(crypto.randomUUID())
  }, [])

  useEffect(() => {
    if (initialMessage && sessionId && !initialSentRef.current) {
      initialSentRef.current = true
      handleSendMessage(initialMessage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, sessionId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isLoading])

  const parseAgentResponse = (result: any): { text: string; metadata: string; citations: Citation[]; followups: string[] } => {
    const agentResult = result?.response?.result ?? result?.response?.message ?? result?.response ?? result
    const parsed = coerceAgentPayload(agentResult)
    const fallbackText = stripJsonCodeFence(stripThinkBlocks(String(result?.response?.message || '')))
    const rawText = stripThinkBlocks(
      parsed?.response_text
      || parsed?.text
      || parsed?.message
      || fallbackText
      || ''
    )
    const { mainText, metadataText: inTextMetadata } = splitResponseAndMetadata(rawText)

    const citations = Array.isArray(parsed?.citations) ? parsed.citations : []
    const followups = extractFollowups(parsed)

    let metadata = inTextMetadata

    if (typeof parsed?.metadata === 'string' && parsed.metadata.trim()) {
      metadata = metadata ? `${metadata}\n\n${parsed.metadata.trim()}` : parsed.metadata.trim()
    }

    if (typeof parsed?.evidence_notes === 'string' && parsed.evidence_notes.trim()) {
      metadata = metadata ? `${metadata}\n\n${parsed.evidence_notes.trim()}` : parsed.evidence_notes.trim()
    }

    if (typeof agentResult === 'string') {
      const cleaned = stripJsonCodeFence(stripThinkBlocks(agentResult))
      const externalMeta = splitResponseAndMetadata(cleaned).metadataText
      if (externalMeta) {
        metadata = metadata ? `${metadata}\n\n${externalMeta}` : externalMeta
      }
    }

    return {
      text: mainText || 'No response received.',
      metadata: sanitizeMetadataForDisplay(metadata),
      citations,
      followups,
    }
  }

  const handleSendMessage = async (msg: string) => {
    if (!msg.trim() || isLoading) return

    const userMsg: ChatMessage = {
      role: 'user',
      content: msg.trim(),
      timestamp: new Date().toISOString(),
    }

    setMessages((prev) => [...prev, userMsg])
    setInputValue('')
    setIsLoading(true)
    setChatError(null)
    onAgentActive(AGENT_ID)

    try {
      const result = await callAIAgent(msg.trim(), AGENT_ID, { session_id: sessionId, rag_id: RAG_ID })
      if (result.success) {
        const { text, metadata, citations, followups } = parseAgentResponse(result)
        const twinMsg: ChatMessage = {
          role: 'twin',
          content: text,
          metadata,
          citations,
          followups,
          timestamp: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, twinMsg])
      } else {
        setChatError(result.error ?? 'Failed to get a response. Please try again.')
      }
    } catch {
      setChatError('Network error. Please try again.')
    } finally {
      setIsLoading(false)
      onAgentActive(null)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage(inputValue)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 pt-20 pb-8 flex flex-col" style={{ minHeight: 'calc(100vh - 56px)' }}>
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold tracking-tight font-serif text-foreground mb-1">Digital Twin Chat</h2>
        <p className="text-sm text-muted-foreground">Peer-to-peer academic conversation with Manogna Sreenivas&apos;s research AI</p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto mb-6 space-y-6 pr-2" style={{ maxHeight: 'calc(100vh - 340px)' }}>
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 bg-secondary border border-border flex items-center justify-center mb-6">
              <FiMessageSquare className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-foreground/70 max-w-md leading-relaxed" style={{ lineHeight: '1.7' }}>
              Hello! I am Manogna Sreenivas&apos;s Research Digital Twin. You can ask about domain shift, why test-time adaptation is needed, variants of TTA, overall research evolution, and future directions from the thesis.
            </p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <ChatMessageBubble key={idx} msg={msg} onFollowup={handleSendMessage} />
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="w-8 h-8 bg-secondary border border-border flex items-center justify-center mr-3 flex-shrink-0">
              <FaGraduationCap className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="bg-card border border-border px-4 py-4">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        {chatError && (
          <div className="flex items-center gap-2 p-3 border border-[hsl(0,70%,55%)]/30 bg-[hsl(0,70%,55%)]/5">
            <FiAlertCircle className="w-4 h-4 text-[hsl(0,70%,55%)] flex-shrink-0" />
            <p className="text-sm text-[hsl(0,70%,55%)]">{chatError}</p>
            <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => setChatError(null)}>
              <FiX className="w-3 h-3" />
            </Button>
          </div>
        )}
      </div>

      {/* Suggested Prompts */}
      {messages.length === 0 && (
        <div className="mb-4">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-3">Suggested Questions</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button key={prompt} onClick={() => handleSendMessage(prompt)} className="text-xs text-foreground/70 hover:text-foreground border border-border px-3 py-2 hover:bg-secondary transition-colors">
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input Bar */}
      <div className="border border-border bg-card p-3">
        <div className="flex items-end gap-3">
          <Textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the Digital Twin about Manogna's research..."
            className="flex-1 border-none bg-transparent resize-none text-sm focus-visible:ring-0 focus-visible:ring-offset-0 min-h-[40px] max-h-[120px]"
            rows={1}
            disabled={isLoading}
          />
          <Button onClick={() => handleSendMessage(inputValue)} disabled={!inputValue.trim() || isLoading} size="sm">
            <FiSend className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ModelBenchmarkPanel
        seedPrompt={
          [...messages].reverse().find((item) => item.role === 'user')?.content
          || inputValue
          || SUGGESTED_PROMPTS[3]
        }
      />
    </div>
  )
}

// --- SampleChatView ---
function SampleChatView() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-20 pb-8">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold tracking-tight font-serif text-foreground mb-1">Digital Twin Chat</h2>
        <p className="text-sm text-muted-foreground">Peer-to-peer academic conversation with Manogna Sreenivas&apos;s research AI</p>
        <Badge variant="secondary" className="mt-2 text-[10px]">Sample Data Mode</Badge>
      </div>

      <div className="space-y-6 mb-6">
        {SAMPLE_MESSAGES.map((msg, idx) => (
          <ChatMessageBubble key={idx} msg={msg} onFollowup={() => {}} />
        ))}
      </div>

      <div className="border border-border bg-card p-3 opacity-60">
        <div className="flex items-end gap-3">
          <Textarea placeholder="Ask the Digital Twin about Manogna's research..." className="flex-1 border-none bg-transparent resize-none text-sm focus-visible:ring-0 focus-visible:ring-offset-0 min-h-[40px]" rows={1} disabled />
          <Button size="sm" disabled>
            <FiSend className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// --- AgentStatusSection ---
function AgentStatusSection({ activeAgentId }: { activeAgentId: string | null }) {
  return (
    <div className="max-w-4xl mx-auto px-6 mb-10">
      <div className="border-t border-border pt-6">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-3">Agent Status</p>
        <div className="flex items-center gap-3 p-3 border border-border bg-card">
          <div className={`w-2 h-2 flex-shrink-0 ${activeAgentId === AGENT_ID ? 'bg-[hsl(0,70%,55%)] animate-pulse' : 'bg-green-500'}`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">Research Digital Twin Agent</p>
            <p className="text-xs text-muted-foreground truncate">Conversational research peer powered by Manogna Sreenivas&apos;s knowledge base &middot; IISc Bangalore</p>
          </div>
          <Badge variant="outline" className="text-[10px] flex-shrink-0">
            {activeAgentId === AGENT_ID ? 'Active' : 'Ready'}
          </Badge>
        </div>
      </div>
    </div>
  )
}

// --- Main Page ---
export default function Page() {
  const [activeSection, setActiveSection] = useState<string>('overview')
  const [showSampleData, setShowSampleData] = useState(false)
  const [chatInitialMessage, setChatInitialMessage] = useState<string | undefined>(undefined)
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)

  const handleDiscussWithTwin = useCallback((title: string) => {
    setChatInitialMessage(`Tell me about the paper "${title}" and its key contributions`)
    setActiveSection('chat')
  }, [])

  const handleSectionChange = useCallback((s: string) => {
    setActiveSection(s)
    setChatInitialMessage(undefined)
  }, [])

  return (
    <ErrorBoundary>
      <div style={THEME_VARS} className="min-h-screen bg-background text-foreground font-sans">
        <Navbar activeSection={activeSection} onSectionChange={handleSectionChange} />

        {/* Sample Data Toggle */}
        <div className="fixed top-16 right-6 z-40 flex items-center gap-2 bg-card border border-border px-3 py-2">
          <Label htmlFor="sample-toggle" className="text-[10px] uppercase tracking-widest text-muted-foreground cursor-pointer">Sample Data</Label>
          <Switch id="sample-toggle" checked={showSampleData} onCheckedChange={setShowSampleData} />
        </div>

        {activeSection === 'overview' && (
          <div className="pt-14">
            <HeroSection />
            <StatsBar />
            <TimelineSection />
            <TopicCluster />
            <PublicationsGrid onDiscuss={handleDiscussWithTwin} />
            <KnowledgeBaseSection />
            <AgentStatusSection activeAgentId={activeAgentId} />
          </div>
        )}

        {activeSection === 'chat' && (
          <div className="pt-14">
            {showSampleData ? (
              <SampleChatView />
            ) : (
              <ChatInterface initialMessage={chatInitialMessage} onAgentActive={setActiveAgentId} />
            )}
            <AgentStatusSection activeAgentId={activeAgentId} />
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}
