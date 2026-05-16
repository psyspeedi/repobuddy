import { z } from 'zod'

export const ConceptSchema = z.object({
  name: z.string().min(1).max(80),
  evidenceQuote: z.string().min(1).max(400),
})

export const PatternSchema = z.object({
  name: z.string().min(1).max(80),
  confidence: z.enum(['low', 'medium', 'high']),
  evidenceQuote: z.string().min(1).max(400),
})

export const SemanticAnnotationSchema = z.object({
  description: z.string().min(1).max(800),
  concepts: z.array(ConceptSchema).max(5),
  patterns: z.array(PatternSchema).max(5),
})

export type SemanticAnnotation = z.infer<typeof SemanticAnnotationSchema>
export type Concept = z.infer<typeof ConceptSchema>
export type Pattern = z.infer<typeof PatternSchema>
